// Everything GlucoseAnywhere keeps lives in this browser.
//   prefs    localStorage            units, limits, chart range
//   creds    localStorage or         Dexcom sign-in + cached session ids; sessionStorage when
//            sessionStorage          "remember me" is off, so closing the tab forgets it
//   readings IndexedDB               glucose history (falls back to memory if IndexedDB is blocked)
// Every storage call is wrapped: private windows and blocked site data can make any of them throw.

const PREFS_KEY = 'ga.prefs';
const CREDS_KEY = 'ga.creds';
const DB_NAME = 'glucoseanywhere';
const STORE = 'readings';
const KEEP_MS = 90 * 24 * 3600e3;

export const DEFAULT_PREFS = { useMmol: false, low: 70, high: 180, range: 6 };

const read = (area, key) => { try { return JSON.parse(area.getItem(key)); } catch { return null; } };
const write = (area, key, value) => { try { area.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };
const drop = (area, key) => { try { area.removeItem(key); } catch { /* storage unavailable */ } };

// ---- prefs
export const loadPrefs = () => ({ ...DEFAULT_PREFS, ...(read(localStorage, PREFS_KEY) ?? {}) });
export const savePrefs = p => write(localStorage, PREFS_KEY, p);

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
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 't' });
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
    const tx = (await openDb()).transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(IDBKeyRange.upperBound(cutoff));
    await done(tx);
  } catch { /* nothing to prune */ }
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

  const rows = await getReadings(0);
  lines.push('', 'Glucose readings (IndexedDB)');
  if (rows.length) {
    lines.push(`  ${rows.length} readings`,
      `  from ${new Date(rows[0].t).toLocaleString()}`,
      `  to ${new Date(rows[rows.length - 1].t).toLocaleString()}`);
  } else {
    lines.push('  none');
  }

  let caches_ = 0;
  try { caches_ = (await caches.keys()).length; } catch { /* unavailable */ }
  lines.push('', 'Offline copy of this app (cache)', `  ${caches_ ? 'saved' : 'none'}`);
  return lines.join('\n');
}

/** Remove everything this app stored in the browser, including the offline app cache. */
export async function forgetEverything() {
  clearCreds();
  drop(localStorage, PREFS_KEY);
  memory = new Map();
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
