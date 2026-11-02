// Insulin and carb maths. No DOM, no storage. Glucose is mg/dL, insulin is units, carbs are grams, times are ms.
//
// Insulin activity uses the exponential curve from OpenAPS/Loop: it needs only the insulin's peak time and
// its duration (DIA). Carbs absorb linearly over a set number of hours.

const MIN = 60e3;

/** Constants of the exponential curve. peak and dia are in minutes; the peak has to be under half the DIA. */
export function curveParams(peakMin, diaMin) {
  const td = Math.max(diaMin, 60);
  const tp = Math.min(Math.max(peakMin, 15), td / 2 - 1);
  const tau = tp * (1 - tp / td) / (1 - 2 * tp / td);
  const a = 2 * tau / td;
  const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
  return { td, tp, tau, a, S };
}

/** Share of a dose still active `min` minutes after it was taken: 1 at the start, 0 once the DIA has passed. */
export function iobFraction(min, c) {
  if (min <= 0) return 1;
  if (min >= c.td) return 0;
  const { tau, td, a, S } = c;
  return 1 - S * (1 - a) * ((min * min / (tau * td * (1 - a)) - min / tau - 1) * Math.exp(-min / tau) + 1);
}

/** How fast one dose is working `min` minutes after it was taken, in units per hour (0 outside the DIA). */
export function activityFraction(min, c) {
  if (min <= 0 || min >= c.td) return 0;
  return 60 * (c.S / (c.tau * c.tau)) * min * (1 - min / c.td) * Math.exp(-min / c.tau);
}

/** Units per hour being used at time t. doses: [{ t, v }] */
export function activityAt(doses, t, c) {
  let sum = 0;
  for (const d of doses) if (d.t <= t) sum += d.v * activityFraction((t - d.t) / MIN, c);
  return sum;
}

/** Units on board at time t. doses: [{ t, v }] */
export function iobAt(doses, t, c) {
  let sum = 0;
  for (const d of doses) if (d.t <= t) sum += d.v * iobFraction((t - d.t) / MIN, c);
  return sum;
}

/** Grams of carbs not yet absorbed at time t. carbs: [{ t, v }]; hours: how long a meal takes to absorb. */
export function cobAt(carbs, t, hours) {
  let sum = 0;
  for (const m of carbs) {
    if (m.t > t) continue;
    sum += m.v * Math.max(0, 1 - (t - m.t) / (hours * 3600e3));
  }
  return sum;
}

/** Activity sampled every stepMin minutes from `from` to `to`: [{ t, v }] */
export function activitySeries(doses, from, to, c, stepMin = 5) {
  const out = [];
  for (let t = from; t <= to; t += stepMin * MIN) out.push({ t, v: activityAt(doses, t, c) });
  return out;
}

/** IOB sampled every stepMin minutes from `from` to `to`: [{ t, v }] */
export function iobSeries(doses, from, to, c, stepMin = 5) {
  const out = [];
  for (let t = from; t <= to; t += stepMin * MIN) out.push({ t, v: iobAt(doses, t, c) });
  return out;
}

/** The settings the wizard needs, or null if any is missing. */
export const wizardReady = p => !!(p.icr > 0 && p.isf > 0 && p.target > 0);

/**
 * What a pump's bolus wizard shows: carbs / ratio, plus (glucose - target) / sensitivity, minus insulin on board.
 * in: { bg, carbs, iob } (bg null = food only) and settings { icr, isf, target, step, maxBolus }. Never negative, rounded to the dose step.
 */
export function wizard({ bg, carbs = 0, iob = 0 }, p) {
  const meal = carbs / p.icr;
  const correction = bg == null ? 0 : (bg - p.target) / p.isf;
  const raw = meal + correction - iob;
  const rounded = Math.round(Math.max(0, raw) / p.step) * p.step;
  const capped = rounded > p.maxBolus;
  return { meal, correction, iob, raw, units: Math.min(rounded, p.maxBolus), capped };
}
