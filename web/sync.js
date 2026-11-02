// Optional sync of the insulin log to the user's own Google Drive or OneDrive.
// Only the insulin/carb log goes there (never the Dexcom sign-in or glucose readings), as one JSON file in the
// app's private folder, which the app can read and write but the rest of the drive stays out of reach.
// There is no server of ours in the middle: the browser talks to the provider directly, with no SDKs.
//   Microsoft: authorization code + PKCE, with a refresh token, so it keeps working.
//   Google:    implicit flow (Google's web clients need a secret for the code flow), so the token lasts an hour
//              and the user taps Reconnect when it runs out.
// The merge is by entry id, so two devices add each other's entries; deletes travel as tombstones.
import { CLIENT_IDS } from './sync-config.js';
import { loadSync, saveSync, getTreatments, putTreatments, deleteTreatment, cleanTreatment } from './store.js';

const FILE = 'glucoseanywhere-insulin-log.json';
const KEEP_TOMBSTONES_MS = 90 * 24 * 3600e3;
const redirectUri = () => location.origin + '/';

export const PROVIDERS = {
  google: { name: 'Google Drive' },
  microsoft: { name: 'OneDrive' },
};
export const configured = () => Object.keys(PROVIDERS).filter(p => CLIENT_IDS[p]);

// ---- PKCE helpers
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async s => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));

// ---- sign-in
/** Leave the app for the provider's consent page. It returns to this origin; call finishSignIn() at start-up. */
export async function connect(provider) {
  const id = CLIENT_IDS[provider];
  if (!id) throw new Error('not configured');
  const state = randomString();
  const pending = { provider, state };
  let url;
  if (provider === 'microsoft') {
    pending.verifier = randomString();
    url = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?' + new URLSearchParams({
      client_id: id, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query', state,
      scope: 'Files.ReadWrite.AppFolder offline_access', code_challenge: await sha256(pending.verifier), code_challenge_method: 'S256',
    });
  } else {
    url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: id, response_type: 'token', redirect_uri: redirectUri(), state,
      scope: 'https://www.googleapis.com/auth/drive.appdata', include_granted_scopes: 'true',
    });
  }
  saveSync({ ...(loadSync() ?? {}), pending });
  location.assign(url);
}

/** Call once at start-up. If this page load is the provider sending the user back, store the tokens. */
export async function finishSignIn() {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
  const isMs = q.has('code') && q.has('state'), isGoogle = h.has('access_token') && h.has('state');
  const err = q.get('error') || h.get('error');
  if (!isMs && !isGoogle && !err) return null;
  const s = loadSync() ?? {};
  const { pending } = s;
  history.replaceState(null, '', location.pathname);
  saveSync({ ...s, pending: undefined });
  if (err) return { error: 'The sign-in was cancelled or refused.' };
  if (!pending || pending.state !== (q.get('state') || h.get('state'))) return { error: 'The sign-in response did not match, so it was ignored.' };
  try {
    if (isGoogle) {
      saveSync({ provider: 'google', token: h.get('access_token'), expires: Date.now() + Number(h.get('expires_in')) * 1000 });
    } else {
      saveSync({ provider: 'microsoft', ...await tokenRequest({
        grant_type: 'authorization_code', code: q.get('code'), code_verifier: pending.verifier, redirect_uri: redirectUri(),
      }) });
    }
    return { provider: pending.provider };
  } catch { return { error: "Couldn't finish signing in." }; }
}

async function tokenRequest(params) {
  const r = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST', body: new URLSearchParams({ client_id: CLIENT_IDS.microsoft, ...params }),
  });
  if (!r.ok) throw new Error('token');
  const t = await r.json();
  return { token: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 };
}

export const disconnect = () => saveSync(null);
export const connectedTo = () => loadSync()?.provider ?? null;

class NeedsSignIn extends Error {}
async function accessToken() {
  const s = loadSync();
  if (!s?.provider) throw new NeedsSignIn();
  if (s.expires > Date.now() + 60e3) return s.token;
  if (s.provider === 'microsoft' && s.refresh) {
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh });
      saveSync({ ...s, ...t, refresh: t.refresh ?? s.refresh });
      return t.token;
    } catch { /* fall through */ }
  }
  throw new NeedsSignIn();
}
export const needsReconnect = e => e instanceof NeedsSignIn;

// ---- the remote file
async function call(url, token, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (r.status === 401) throw new NeedsSignIn();
  return r;
}

const GRAPH = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${FILE}:/content`;
const DRIVE = 'https://www.googleapis.com';

async function googleFileId(token) {
  const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${FILE}'`, fields: 'files(id)' });
  const r = await call(`${DRIVE}/drive/v3/files?${q}`, token);
  if (!r.ok) throw new Error('list');
  return (await r.json()).files?.[0]?.id ?? null;
}

/** The remote log, or null when there isn't one yet. */
async function download(provider, token) {
  if (provider === 'microsoft') {
    const r = await call(GRAPH, token);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('download');
    return r.json();
  }
  const id = await googleFileId(token);
  if (!id) return null;
  const r = await call(`${DRIVE}/drive/v3/files/${id}?alt=media`, token);
  if (!r.ok) throw new Error('download');
  return r.json();
}

async function upload(provider, token, data) {
  const body = JSON.stringify(data);
  if (provider === 'microsoft') {
    const r = await call(GRAPH, token, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('upload');
    return;
  }
  const id = await googleFileId(token);
  let r;
  if (id) {
    r = await call(`${DRIVE}/upload/drive/v3/files/${id}?uploadType=media`, token, { method: 'PATCH', body, headers: { 'Content-Type': 'application/json' } });
  } else {
    const boundary = randomString();
    const meta = JSON.stringify({ name: FILE, parents: ['appDataFolder'] });
    r = await call(`${DRIVE}/upload/drive/v3/files?uploadType=multipart`, token, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`,
    });
  }
  if (!r.ok) throw new Error('upload');
}

// ---- merge

/**
 * Two-way sync. Returns the number of entries added on this device.
 * `deleted` is the local tombstone list [{ id, at }], and `forgetDeleted(list)` replaces it.
 */
export async function syncNow() {
  const s = loadSync();
  const provider = s?.provider;
  const token = await accessToken();
  const remote = await download(provider, token);

  const now = Date.now();
  const tomb = new Map();
  for (const d of [...(s.deleted ?? []), ...(remote?.deleted ?? [])]) if (d?.id && now - d.at < KEEP_TOMBSTONES_MS) tomb.set(d.id, d);

  const local = await getTreatments(0);
  const merged = new Map(local.map(r => [r.id, r]));
  const before = merged.size;
  for (const r of remote?.treatments ?? []) {
    const c = cleanTreatment(r);
    if (!c) continue;
    const mine = merged.get(c.id);
    if (!mine || (c.u ?? 0) > (mine.u ?? 0)) merged.set(c.id, c);
  }
  for (const id of tomb.keys()) if (merged.has(id)) { merged.delete(id); await deleteTreatment(id); }
  const localById = new Map(local.map(r => [r.id, r]));
  const changed = [...merged.values()].filter(r => ['u', 'v', 't', 'kind', 'name'].some(k => localById.get(r.id)?.[k] !== r[k]));
  const added = changed.filter(r => !localById.has(r.id));
  if (changed.length) await putTreatments(changed);   // new entries, and edits made on another device

  const rows = [...merged.values()].sort((a, b) => a.t - b.t);
  await upload(provider, token, { app: 'GlucoseAnywhere', version: 1, treatments: rows, deleted: [...tomb.values()] });
  saveSync({ ...loadSync(), deleted: [...tomb.values()], last: now });
  return { added: added.length, total: rows.length, before };
}

/** Remember that this device deleted an entry, so the next sync removes it everywhere. */
export function noteDeleted(id) {
  const s = loadSync();
  if (!s?.provider) return;
  saveSync({ ...s, deleted: [...(s.deleted ?? []), { id, at: Date.now() }] });
}
