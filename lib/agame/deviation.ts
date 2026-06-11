/**
 * lib/agame/deviation.ts
 *
 * Phase 1 — on-demand A-Game deviation. NOT persisted.
 *
 * Pure comparison of a live/partial session snapshot against the stored
 * baseline. This is the surface that powers the Risk Desk, the live feed, and
 * the Form Score replacement: "how far am I from my best self, right now?"
 *
 * Each value is a SIGNED FRACTION: (live − baseline) / baseline.
 *   +0.42 → 42% above baseline   ·   −0.18 → 18% below baseline   ·   null → n/a
 */

import type { AgameBaselineCore, AgameDeviation, LiveSessionSnapshot } from "./types";

function pctDelta(live: number | null, base: number | null): number | null {
  if (live == null || base == null || base === 0) return null;
  return (live - base) / base;
}

/**
 * Compute the live session's deviation from the A-Game baseline.
 * Returns all-null when the baseline is still calibrating.
 */
export function computeDeviation(
  baseline: AgameBaselineCore,
  live: LiveSessionSnapshot,
): AgameDeviation {
  if (baseline.status !== "ready") {
    return { trade_count: null, pace: null, size: null, duration: null };
  }
  return {
    trade_count: pctDelta(live.trade_count, baseline.median_trade_count),
    pace:        pctDelta(live.median_inter_trade_gap_seconds, baseline.median_inter_trade_gap_seconds),
    size:        pctDelta(live.median_position_size, baseline.median_position_size),
    duration:    pctDelta(live.session_duration_seconds / 60, baseline.median_session_duration_minutes),
  };
}
