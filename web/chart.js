// Glucose chart: inline SVG, rebuilt on every render.
import { fmtGlucoseNum } from './format.js';

const COLORS = { ok: '#4CC38A', high: '#F2B33D', low: '#EF5350' };

/** o: { readings, hours, now, low, high, mmol } */
export function drawChart(el, o) {
  // A phone on its side has little height to share with the range tabs and tab bar, so fit to what's left.
  const W = Math.max(el.clientWidth, 280);
  const H = window.innerHeight < 500 ? Math.max(150, window.innerHeight - 200) : 220;
  const m = { l: 6, r: 40, t: 12, b: 24 };
  const end = o.now, start = end - o.hours * 3600e3;
  const vis = o.readings.filter(r => r.t >= start && r.t <= end);

  let hi = 0;
  for (const r of vis) if (r.v > hi) hi = r.v;
  const yMin = 40, yMax = Math.min(400, Math.max(250, hi + 20));
  const x = t => m.l + (t - start) / (end - start) * (W - m.l - m.r);
  const y = v => m.t + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const plotR = W - m.r, plotB = H - m.b;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Glucose chart">`;

  // Target band
  s += `<rect x="${m.l}" y="${y(o.high)}" width="${plotR - m.l}" height="${y(o.low) - y(o.high)}" fill="#4CC38A" opacity="0.12"/>`;

  // Hourly gridlines + labels
  const step = o.hours <= 6 ? 1 : o.hours <= 12 ? 2 : 4;
  const d0 = new Date(start); d0.setMinutes(0, 0, 0);
  for (let t = d0.getTime(); t <= end; t += 3600e3) {
    if (t < start || new Date(t).getHours() % step) continue;
    const px = x(t).toFixed(1);
    if (px < m.l + 14) continue;      // a label this close to the left edge would be clipped
    const label = new Date(t).toLocaleTimeString([], { hour: 'numeric' });
    s += `<line x1="${px}" y1="${m.t}" x2="${px}" y2="${plotB}" stroke="#2F333B" stroke-width="1"/>`;
    s += `<text x="${px}" y="${H - 7}" text-anchor="middle" font-size="11" fill="#8A8F99">${label}</text>`;
  }

  // Low/high lines with labels on the right
  for (const v of [o.low, o.high]) {
    s += `<line x1="${m.l}" y1="${y(v)}" x2="${plotR}" y2="${y(v)}" stroke="${v === o.low ? COLORS.low : COLORS.high}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`;
    s += `<text x="${plotR + 4}" y="${y(v) + 4}" font-size="11" fill="#8A8F99">${fmtGlucoseNum(v, o.mmol)}</text>`;
  }

  // Readings
  const rad = o.hours <= 3 ? 3.2 : o.hours <= 6 ? 2.6 : o.hours <= 12 ? 2 : 1.5;
  for (const r of vis) {
    const c = r.v < o.low ? COLORS.low : r.v > o.high ? COLORS.high : COLORS.ok;
    s += `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.v).toFixed(1)}" r="${rad}" fill="${c}"/>`;
  }

  el.innerHTML = s + '</svg>';
}
