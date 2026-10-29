// Glucose chart: inline SVG, rebuilt on every render.
// Colours come from CSS classes (see app.css) so the chart follows the light/dark theme;
// inline style attributes are blocked by the page's Content-Security-Policy.
import { fmtGlucoseNum } from './format.js';

// Desktop and tablet-landscape windows: the chart fills the space the layout gives it.
const FILL = window.matchMedia('(min-width: 900px) and (min-height: 600px)');
// The chart view also fills its card, on any screen size.
export const chartFills = () => FILL.matches || !!document.querySelector('.chart-focus');

/** o: { readings, hours, now, low, high, mmol } */
export function drawChart(el, o) {
  const W = Math.max(el.clientWidth, 280);
  // Otherwise: a phone on its side has little height to share with the range tabs and tab bar, so fit to what's left.
  const H = chartFills() ? Math.max(el.clientHeight, 160) : window.innerHeight < 500 ? Math.max(150, window.innerHeight - 200) : 220;
  const k = Math.min(1.8, Math.max(1, W / 600));        // bigger text and dots on a big chart
  const fs = Math.round(11 * k);
  const m = { l: 6, r: Math.round(40 * Math.min(k, 1.5)), t: 12, b: Math.round(24 * Math.min(k, 1.5)) };
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
  s += `<rect class="c-band" x="${m.l}" y="${y(o.high)}" width="${plotR - m.l}" height="${y(o.low) - y(o.high)}" opacity="0.14"/>`;

  // Hourly gridlines + labels
  const step = o.hours <= 6 ? 1 : o.hours <= 12 ? 2 : 4;
  const d0 = new Date(start); d0.setMinutes(0, 0, 0);
  for (let t = d0.getTime(); t <= end; t += 3600e3) {
    if (t < start || new Date(t).getHours() % step) continue;
    const px = x(t).toFixed(1);
    if (px < m.l + 14) continue;      // a label this close to the left edge would be clipped
    const label = new Date(t).toLocaleTimeString([], { hour: 'numeric' });
    s += `<line class="c-grid" x1="${px}" y1="${m.t}" x2="${px}" y2="${plotB}" stroke-width="1"/>`;
    s += `<text class="c-lbl" x="${px}" y="${H - 7}" text-anchor="middle" font-size="${fs}">${label}</text>`;
  }

  // Low/high lines with labels on the right
  for (const [v, cls] of [[o.low, 'c-low-line'], [o.high, 'c-high-line']]) {
    s += `<line class="${cls}" x1="${m.l}" y1="${y(v)}" x2="${plotR}" y2="${y(v)}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`;
    s += `<text class="c-lbl" x="${plotR + 4}" y="${y(v) + 4}" font-size="${fs}">${fmtGlucoseNum(v, o.mmol)}</text>`;
  }

  // Readings
  const rad = (o.hours <= 3 ? 3.2 : o.hours <= 6 ? 2.6 : o.hours <= 12 ? 2 : 1.5) * Math.min(k, 1.6);
  for (const r of vis) {
    const c = r.v < o.low ? 'c-low' : r.v > o.high ? 'c-high' : 'c-ok';
    s += `<circle class="${c}" cx="${x(r.t).toFixed(1)}" cy="${y(r.v).toFixed(1)}" r="${rad.toFixed(1)}"/>`;
  }

  el.innerHTML = s + '</svg>';
}
