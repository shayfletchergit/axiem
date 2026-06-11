/**
 * lib/agame/liveDeviation.ts
 *
 * Phase 1.5 — Live Behaviour Deviation Engine (PURE, read-only).
 *
 * Compares the ACTIVE session against the A-Game baseline and produces signed
 * deviations, deterministic rule-based flags, a simple weighted risk score, and
 * factual interpretation strings. No ML, no psychology, no recomputation of
 * sessions or baseline. Runs in microseconds — the cost in production is the
 * two indexed reads in lib/db/liveBehaviour.ts.
 *
 * Baseline reference = the MEDIAN_* fields (the A-Game fingerprint), consistent
 * with the locked "always median" rule from Phase 1. (`avg_*` are reference-only.)
 *
 * All comparisons guard against null / zero baseline values: a missing or zero
 * baseline yields a null deviation and never trips a flag.
 */

import { clamp01 } from "./stats";
import { computeDeviation } from "./deviation";
import {
  type AgameBaselineCore,
  type LiveDeviationReport,
  type BehaviourFlags,
  type ActiveSessionInput,
  type LiveSessionSnapshot,
} from "./types";

// ── Flag thresholds (deterministic, locked spec §4) ──────────────────────────
const OVERTRADING_MULT = 1.25;
const SPEED_MULT       = 0.75;
const SIZE_MULT        = 1.20;
const DRIFT_DEV        = 0.30;  // |deviation| over a "major" feature
const DRIFT_MIN_FEATS  = 2;

// ── Risk score weights (locked spec §6) ──────────────────────────────────────
const W_TRADE_COUNT = 0.3;
const W_PACE        = 0.3;
const W_SIZE        = 0.2;
const W_DURATION    = 0.2;

// ── Interpretation threshold: don't narrate trivial noise ────────────────────
const NARRATE_DEV = 0.15;

function pos(x: number | null): number {
  return x != null && x > 0 ? x : 0;
}
function pct(frac: number): number {
  return Math.round(Math.abs(frac) * 100);
}

/**
 * Compute the live deviation report for one active session vs the baseline.
 *
 * @param session   The active session (status open|provisional) with its
 *                  materialised feature_vector. Pass null for "no active session".
 * @param baseline  The A-Game baseline for this (user, account), or null/absent.
 * @param now       Reference timestamp ms (default Date.now()); injectable for tests.
 */
export function computeLiveDeviation(
  session: ActiveSessionInput | null,
  baseline: AgameBaselineCore | null,
  now: number = Date.now(),
): LiveDeviationReport {
  const computed_at = new Date(now).toISOString();
  const noFlags: BehaviourFlags = {
    overtrading: false, speed_escalation: false, size_escalation: false, session_drift: false,
  };
  const noDev = { trade_count: null, pace: null, size: null, duration: null };

  // ── No active session ──────────────────────────────────────────────────────
  if (!session) {
    return {
      session_id: null, baseline_ready: false,
      deviations: noDev, flags: noFlags, risk_score: 0,
      interpretation: ["No active session."], computed_at,
    };
  }

  // ── Baseline not usable (calibrating / absent) ──────────────────────────────
  const baselineReady = baseline != null && baseline.status === "ready";
  if (!baselineReady || !session.feature_vector) {
    const reason = !session.feature_vector
      ? "Active session has no materialised features yet."
      : "A-Game baseline is still calibrating; live comparison unavailable.";
    return {
      session_id: session.session_id, baseline_ready: baselineReady,
      deviations: noDev, flags: noFlags, risk_score: 0,
      interpretation: [reason], computed_at,
    };
  }

  const fv = session.feature_vector;
  const live: LiveSessionSnapshot = {
    trade_count:                    fv.trade_count,
    median_inter_trade_gap_seconds: fv.median_inter_trade_gap_seconds,
    median_position_size:           fv.median_position_size,
    session_duration_seconds:       fv.session_duration_seconds,
  };

  // ── Deviations (reuses the Phase 1 helper; signed fractions) ────────────────
  const dev = computeDeviation(baseline as AgameBaselineCore, live);

  // ── Flags (guard null / non-positive baseline) ──────────────────────────────
  const bTc   = baseline!.median_trade_count;
  const bGap  = baseline!.median_inter_trade_gap_seconds;
  const bSize = baseline!.median_position_size;

  const flags: BehaviourFlags = {
    overtrading:
      bTc != null && bTc > 0 && live.trade_count > bTc * OVERTRADING_MULT,
    speed_escalation:
      bGap != null && bGap > 0 && live.median_inter_trade_gap_seconds != null &&
      live.median_inter_trade_gap_seconds < bGap * SPEED_MULT,
    size_escalation:
      bSize != null && bSize > 0 && live.median_position_size > bSize * SIZE_MULT,
    session_drift:
      [dev.trade_count, dev.pace, dev.size, dev.duration]
        .filter((d): d is number => d != null && Math.abs(d) > DRIFT_DEV).length >= DRIFT_MIN_FEATS,
  };

  // ── Risk score: weighted sum of RISK-INCREASING deviations, scaled to 0–100 ─
  // trade_count↑, pace↓ (faster), size↑, duration↑ each add risk. Deviations in
  // the safe direction (e.g. slower pace, shorter session) contribute nothing.
  const riskRaw =
    pos(dev.trade_count)      * W_TRADE_COUNT +
    pos(dev.pace != null ? -dev.pace : null) * W_PACE +   // faster = negative dev
    pos(dev.size)             * W_SIZE +
    pos(dev.duration)         * W_DURATION;
  const risk_score = Math.round(clamp01(riskRaw) * 100);

  // ── Interpretation (factual, non-prescriptive) ──────────────────────────────
  const interpretation = buildInterpretation(dev);

  return {
    session_id:     session.session_id,
    baseline_ready: true,
    deviations:     { trade_count: dev.trade_count, pace: dev.pace, size: dev.size, duration: dev.duration },
    flags,
    risk_score,
    interpretation,
    computed_at,
  };
}

function buildInterpretation(dev: {
  trade_count: number | null; pace: number | null; size: number | null; duration: number | null;
}): string[] {
  const out: string[] = [];

  if (dev.trade_count != null && Math.abs(dev.trade_count) >= NARRATE_DEV) {
    out.push(`Trade frequency is ${pct(dev.trade_count)}% ${dev.trade_count > 0 ? "above" : "below"} A-Game baseline.`);
  }
  if (dev.pace != null && Math.abs(dev.pace) >= NARRATE_DEV) {
    // negative pace deviation = smaller gap = faster
    out.push(`Session pacing is ${pct(dev.pace)}% ${dev.pace < 0 ? "faster than" : "slower than"} baseline behaviour.`);
  }
  if (dev.size != null && Math.abs(dev.size) >= NARRATE_DEV) {
    out.push(`Position sizing is ${pct(dev.size)}% ${dev.size > 0 ? "above" : "below"} A-Game baseline.`);
  }
  if (dev.duration != null && Math.abs(dev.duration) >= NARRATE_DEV) {
    out.push(`Session duration is ${pct(dev.duration)}% ${dev.duration > 0 ? "above" : "below"} baseline.`);
  }

  if (out.length === 0) out.push("Current session is tracking within A-Game baseline ranges.");
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Active-session selection (pure — testable session-switching logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the active session from a set of candidates: status open|provisional,
 * latest by start_ts. Deterministic (ties broken by session_id). Returns null
 * if none are active.
 */
export function selectActiveSession<T extends { session_id: string; status: string; start_ts: string }>(
  sessions: T[],
): T | null {
  let best: T | null = null;
  for (const s of sessions) {
    if (s.status !== "open" && s.status !== "provisional") continue;
    if (best === null) { best = s; continue; }
    const a = Date.parse(s.start_ts);
    const b = Date.parse(best.start_ts);
    if (a > b || (a === b && s.session_id > best.session_id)) best = s;
  }
  return best;
}
