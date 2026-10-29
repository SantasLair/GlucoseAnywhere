// Display formatting shared by all screens. All stored glucose values are mg/dL.
export const MMOL = 18.0182;

export const TREND_ARROWS = {
  DoubleUp: '⇈', SingleUp: '↑', FortyFiveUp: '↗', Flat: '→',
  FortyFiveDown: '↘', SingleDown: '↓', DoubleDown: '⇊',
  NotComputable: '?', RateOutOfRange: '?', None: '',
};
export const STALE_MS = 15 * 60 * 1000;

export const toMmol = v => v / MMOL;
export const unitsLabel = mmol => (mmol ? 'mmol/L' : 'mg/dL');

/** Glucose text for display, e.g. "112", "6.2", "LOW", "HIGH". */
export function fmtGlucose(v, mmol) {
  if (v == null || Number.isNaN(v)) return '--';
  if (v <= 39) return 'LOW';
  if (v >= 401) return 'HIGH';
  return mmol ? toMmol(v).toFixed(1) : String(Math.round(v));
}

/** Number only (no LOW/HIGH words); for inputs and chart labels. */
export function fmtGlucoseNum(v, mmol) {
  return mmol ? toMmol(v).toFixed(1) : String(Math.round(v));
}

export function parseNum(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function fmtDelta(latest, prev, mmol) {
  if (!latest || !prev || latest.t - prev.t > 10 * 60 * 1000) return '';
  const d = latest.v - prev.v;
  if (mmol) {
    const m = Math.round(toMmol(d) * 10) / 10;
    return m === 0 ? '0.0' : (m > 0 ? '+' : '-') + Math.abs(m).toFixed(1);
  }
  const r = Math.round(d);
  return r === 0 ? '0' : (r > 0 ? '+' : '-') + Math.abs(r);
}

export function glucoseClass(v, low, high, stale) {
  if (stale) return 'stale';
  return v < low ? 'low' : v > high ? 'high' : 'ok';
}

export function fmtAge(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

export const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
