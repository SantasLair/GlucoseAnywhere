// Everything GlucoseAnywhere keeps lives in this browser.
//   prefs    localStorage            units, limits, chart range
//   creds    localStorage or         Dexcom sign-in + cached session ids; sessionStorage when
//            sessionStorage          "remember me" is off, so closing the tab forgets it
//   sync     localStorage            optional Google Drive / OneDrive link for the insulin log: access tokens, delete markers
//   feedback localStorage            which days the app was opened, and whether the feedback prompt was dismissed
//   readings IndexedDB               glucose history (falls back to memory if IndexedDB is blocked)
//   treatments IndexedDB             the insulin and carb log you enter (same fallback)
// Every storage call is wrapped: private windows and blocked site data can make any of them throw.

const PREFS_KEY = 'ga.prefs';
const CREDS_KEY = 'ga.creds';
const FEEDBACK_KEY = 'ga.feedback';
const SYNC_KEY = 'ga.sync';
const FEEDBACK_AFTER_DAYS = 5;
const DB_NAME = 'glucoseanywhere';
const STORE = 'readings';
const TREAT = 'treatments';
const KEEP_MS = 90 * 24 * 3600e3;

export const DEFAULT_PREFS = { useMmol: false, low: 70, high: 180, range: 6, startBig: false, theme: 'auto', layout: 'standard', stayAwake: true,
  iobGraph: false, iobKind: 'iob',               // IOB is a number; the graph is opt-in
  insulinOn: false,                             // the whole insulin log / wizard feature is opt-in
  // Insulin calculator. Dose-affecting values start empty: the wizard stays off until you enter your own.
  icr: null, isf: null, target: null,          // g per unit, mg/dL per unit, mg/dL
  dia: 5, peak: 75, step: 0.5, maxBolus: 10, carbHours: 3 };

const read = (area, key) => { try { return JSON.parse(area.getItem(key)); } catch { return null; } };
const write = (area, key, value) => { try { area.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const drop = (area, key) => { try { area.removeItem(key); } catch { /* storage unavailable */ } };

// ---- prefs
export const loadPrefs = () => ({ ...DEFAULT_PREFS, ...(read(localStorage, PREFS_KEY) ?? {}) });
export const savePrefs = p => write(localStorage, PREFS_KEY, p);

// ---- feedback prompt: shown once, after the app has been opened on a few different days
const loadFeedback = () => ({ days: [], done: false, ...(read(localStorage, FEEDBACK_KEY) ?? {}) });

/** Record that the app was opened today. */
export function noteVisit(now = new Date()) {
  const f = loadFeedback();
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (f.done || f.days.includes(today)) return;
  write(localStorage, FEEDBACK_KEY, { ...f, days: [...f.days, today].slice(-FEEDBACK_AFTER_DAYS) });
}

export const feedbackDue = () => { const f = loadFeedback(); return !f.done && f.days.length >= FEEDBACK_AFTER_DAYS; };
export const dismissFeedback = () => write(localStorage, FEEDBACK_KEY, { days: [], done: true });

// ---- cloud sync link: { provider, token, refresh?, expires, deleted?: [{ id, at }], last? }, or null
export const loadSync = () => read(localStorage, SYNC_KEY);
export const saveSync = v => (v ? write(localStorage, SYNC_KEY, v) : drop(localStorage, SYNC_KEY));

// ---- credentials: { username, password, region, remember, accountId?, sessionId? }
export function loadCreds() {
  const c = read(localStorage, CREDS_KEY) ?? read(sessionStorage, CREDS_KEY);
  return c && c.username && c.password ? c : null;
}

export function saveCreds(c) {
  const [keep, other] = c.remember ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
  write(keep, CREDS_KEY, c);
  drop(other, CREDS_KEY);
}

export function clearCreds() {
  drop(localStorage, CREDS_KEY);
  drop(sessionStorage, CREDS_KEY);
}

// ---- readings
let memory = new Map();
let memoryTreat = new Map();
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 't' });
        if (!db.objectStoreNames.contains(TREAT)) db.createObjectStore(TREAT, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        // Let "Forget everything" (or an upgrade) in another tab proceed instead of waiting on us.
        req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    } catch (e) { reject(e); }
  });
  return dbPromise;
}

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export async function putReadings(list) {
  for (const r of list) memory.set(r.t, r);
  try {
    const tx = (await openDb()).transaction(STORE, 'readwrite');
    for (const r of list) tx.objectStore(STORE).put(r);
    await done(tx);
  } catch { /* kept in memory for this visit */ }
}

/** Readings with t >= sinceMs, oldest first. */
export async function getReadings(sinceMs) {
  try {
    const db = await openDb();
    const rows = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll(IDBKeyRange.lowerBound(sinceMs));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    for (const r of rows) memory.set(r.t, r);
    return rows;
  } catch {
    return [...memory.values()].filter(r => r.t >= sinceMs).sort((a, b) => a.t - b.t);
  }
}

export async function pruneReadings(now = Date.now()) {
  const cutoff = now - KEEP_MS;
  for (const t of memory.keys()) if (t < cutoff) memory.delete(t);
  try {
    const tx = (await openDb()).transaction(STORE, 'readwrite');   // the insulin log is never pruned
    tx.objectStore(STORE).delete(IDBKeyRange.upperBound(cutoff));
    await done(tx);
  } catch { /* nothing to prune */ }
}

// ---- treatments: { id, t, kind: 'insulin' | 'carbs', v }  (units or grams)
const newId = t => `${t}-${Math.random().toString(36).slice(2, 7)}`;

/** Save entries; ones without an id get one. Returns what was saved. */
export async function putTreatments(list) {
  const rows = list.map(r => ({ ...r, id: r.id ?? newId(r.t) }));
  for (const r of rows) memoryTreat.set(r.id, r);
  try {
    const tx = (await openDb()).transaction(TREAT, 'readwrite');
    for (const r of rows) tx.objectStore(TREAT).put(r);
    await done(tx);
  } catch { /* kept in memory for this visit */ }
  return rows;
}

export async function deleteTreatment(id) {
  memoryTreat.delete(id);
  try {
    const tx = (await openDb()).transaction(TREAT, 'readwrite');
    tx.objectStore(TREAT).delete(id);
    await done(tx);
  } catch { /* only in memory */ }
}

/** Treatments with t >= sinceMs, oldest first. */
export async function getTreatments(sinceMs = 0) {
  let rows;
  try {
    const db = await openDb();
    rows = await new Promise((resolve, reject) => {
      const req = db.transaction(TREAT).objectStore(TREAT).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    for (const r of rows) memoryTreat.set(r.id, r);
  } catch {
    rows = [...memoryTreat.values()];
  }
  return rows.filter(r => r.t >= sinceMs).sort((a, b) => a.t - b.t);
}

/** Ask the browser not to clear this app's storage when the phone is short on space. Safe to call repeatedly. */
export async function requestPersistence() {
  try { return !!(await navigator.storage?.persist?.()); } catch { return false; }
}

/** Plain-text list of everything stored on this device. The password is never shown. */
export async function describeStorage() {
  const lines = [];
  const inLocal = read(localStorage, CREDS_KEY);
  const c = inLocal ?? read(sessionStorage, CREDS_KEY);
  if (c) {
    lines.push('Dexcom sign-in',
      `  username: ${c.username}`,
      '  password: saved (hidden here)',
      `  region: ${c.region}`,
      `  session ids: ${c.sessionId ? 'saved' : 'none'}`,
      `  kept in: ${inLocal ? 'localStorage (until you sign out)' : 'sessionStorage (until this tab closes)'}`);
  } else {
    lines.push('Dexcom sign-in', '  none');
  }
  lines.push('', 'Display settings (localStorage)', `  ${JSON.stringify(loadPrefs())}`);
  const sy = loadSync();
  lines.push('', 'Cloud sync (localStorage)', sy?.provider
    ? `  linked to ${sy.provider === 'google' ? 'Google Drive' : 'OneDrive'} (access token saved, hidden here)${sy.last ? `, last synced ${new Date(sy.last).toLocaleString()}` : ''}`
    : '  not linked');
  lines.push('', 'Feedback prompt (localStorage)', `  ${JSON.stringify(loadFeedback())}`);

  const rows = await getReadings(0);
  lines.push('', 'Glucose readings (IndexedDB)');
  if (rows.length) {
    lines.push(`  ${rows.length} readings`,
      `  from ${new Date(rows[0].t).toLocaleString()}`,
      `  to ${new Date(rows[rows.length - 1].t).toLocaleString()}`);
  } else {
    lines.push('  none');
  }

  const treats = await getTreatments(0);
  let persisted = false;
  try { persisted = !!(await navigator.storage?.persisted?.()); } catch { /* unavailable */ }
  lines.push('', 'Insulin and carb log (IndexedDB)', `  ${treats.length ? treats.length + ' entries, kept until you delete them' : 'none'}`,
    `  protected from automatic clean-up by the browser: ${persisted ? 'yes' : 'not granted'}`);

  let caches_ = 0;
  try { caches_ = (await caches.keys()).length; } catch { /* unavailable */ }
  lines.push('', 'Offline copy of this app (cache)', `  ${caches_ ? 'saved' : 'none'}`);
  return lines.join('\n');
}

/** Remove everything this app stored in the browser, including the offline app cache. */
export async function forgetEverything() {
  clearCreds();
  drop(localStorage, PREFS_KEY);
  drop(localStorage, FEEDBACK_KEY);
  drop(localStorage, SYNC_KEY);
  memory = new Map();
  memoryTreat = new Map();
  try { (await openDb()).close(); } catch { /* ignore */ }
  dbPromise = null;
  try {
    await new Promise(resolve => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  } catch { /* ignore */ }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* ignore */ }
}
