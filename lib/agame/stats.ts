/**
 * lib/agame/stats.ts
 *
 * Brutally simple, dependency-free, deterministic statistics.
 *
 * Per the locked A-Game spec: NEVER mean for the baseline meaning — always
 * median + IQR. (mean/variance are provided only for reference fields.)
 * No ML, no weighting, no magic. Pure functions on number[].
 */

/** Mean of a list. NaN-safe inputs should be filtered by the caller. */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Population variance. */
export function variance(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) * (x - m)));
}

/**
 * Linear-interpolated quantile (p in [0,1]) over a copy-sorted list.
 * Matches the common "type 7" definition used by numpy/R default.
 */
export function quantile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const s = [...xs].sort((a, b) => a - b);
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  const frac = idx - lo;
  return s[lo] * (1 - frac) + s[hi] * frac;
}

/** Median (50th percentile). */
export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}

/** Interquartile range (Q3 − Q1). A robust spread measure. */
export function iqr(xs: number[]): number {
  if (xs.length === 0) return 0;
  return quantile(xs, 0.75) - quantile(xs, 0.25);
}

/**
 * Robust coefficient of dispersion: IQR / |median|.
 * Used for the stability score. Returns 0 when the median is ~0 (no signal).
 */
export function robustCV(xs: number[]): number {
  const m = median(xs);
  if (Math.abs(m) < 1e-9) return 0;
  return iqr(xs) / Math.abs(m);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Round to a fixed number of decimals (keeps stored values tidy & stable). */
export function round(x: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
