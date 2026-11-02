// Which settings travel with the insulin log to the user's drive, and how two devices' copies are merged.
// Pure functions, no DOM and no storage, so they can be tested on their own.
//
// Each synced setting has a time it was last changed on a device (prefs.settingsAt[key]). When two devices disagree,
// the newer change wins. Values arriving from the drive are checked against the same limits as typed ones.
// Dose-affecting values are never changed silently: the app shows a notice listing every change it applied.

export const SYNC_KEYS = ['icr', 'isf', 'target', 'dia', 'peak', 'carbHours', 'step', 'maxBolus', 'medButtons'];

const RANGES = { icr: [1, 150], isf: [5, 400], target: [70, 200], dia: [3, 8], peak: [30, 120], carbHours: [1, 8], maxBolus: [1, 50] };
const CLEARABLE = ['icr', 'isf', 'target'];       // leaving these empty is how the wizard is switched off
export const STEPS = [0.05, 0.1, 0.5, 1];
const MAX_FUTURE_MS = 24 * 3600e3;                // ignore timestamps from a badly wrong clock

/** { ok: true, v } with a clean value, or { ok: false }. */
export function cleanSetting(key, v) {
  if (key in RANGES) {
    if (v === null && CLEARABLE.includes(key)) return { ok: true, v: null };
    const n = typeof v === 'number' ? v : NaN;
    const [lo, hi] = RANGES[key];
    return n >= lo && n <= hi ? { ok: true, v: n } : { ok: false };
  }
  if (key === 'step') return STEPS.includes(v) ? { ok: true, v } : { ok: false };
  if (key === 'medButtons') {
    if (!Array.isArray(v)) return { ok: false };
    const list = v.filter(m => m && typeof m.label === 'string' && m.label.trim()).slice(0, 6).map(m => ({
      label: m.label.trim().slice(0, 30),
      items: (Array.isArray(m.items) ? m.items : []).filter(i => typeof i === 'string' && i.trim()).map(i => i.trim().slice(0, 40)).slice(0, 12),
    }));
    return { ok: true, v: list };
  }
  return { ok: false };
}

export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What this device offers the drive: every synced setting the user has set, with when.
 * A custom value from before syncing existed has no time yet, so it is stamped `now`; an untouched default is left
 * out, so another device's real value is never overwritten by a default.
 * Returns { offer: { key: { v, at } }, at: the updated settingsAt to save }.
 */
export function offerSettings(prefs, defaults, now) {
  const at = { ...(prefs.settingsAt ?? {}) };
  const offer = {};
  for (const k of SYNC_KEYS) {
    if (!at[k] && !sameValue(prefs[k], defaults[k])) at[k] = now;
    if (at[k]) offer[k] = { v: prefs[k], at: at[k] };
  }
  return { offer, at };
}

/** The drive's copy and this device's offer, merged: the newer change wins, bad values are dropped. */
export function mergeSettings(local, remote, now = Date.now()) {
  const ok = (k, e) => SYNC_KEYS.includes(k) && e && Number.isFinite(e.at) && e.at > 0 && e.at < now + MAX_FUTURE_MS && cleanSetting(k, e.v).ok;
  const out = {};
  for (const [k, e] of Object.entries(remote ?? {})) if (ok(k, e)) out[k] = { v: cleanSetting(k, e.v).v, at: e.at };
  for (const [k, e] of Object.entries(local ?? {})) if (ok(k, e) && (!out[k] || e.at > out[k].at)) out[k] = { v: cleanSetting(k, e.v).v, at: e.at };
  return out;
}

/** Applies the merged settings to prefs. Newer wins. Returns { prefs: a changed copy, changes: [{ key, from, to }] }. */
export function applyRemote(prefs, merged, now = Date.now()) {
  const next = { ...prefs, settingsAt: { ...(prefs.settingsAt ?? {}) } };
  const changes = [];
  for (const [k, e] of Object.entries(merged ?? {})) {
    if (!SYNC_KEYS.includes(k) || !e || !Number.isFinite(e.at) || e.at >= now + MAX_FUTURE_MS) continue;
    if (!(e.at > (next.settingsAt[k] ?? 0))) continue;
    const c = cleanSetting(k, e.v);
    if (!c.ok) continue;
    if (!sameValue(next[k], c.v)) changes.push({ key: k, from: next[k], to: c.v });
    next[k] = c.v;
    next.settingsAt[k] = e.at;
  }
  return { prefs: next, changes };
}
