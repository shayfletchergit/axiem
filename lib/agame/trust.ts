/**
 * lib/agame/trust.ts
 *
 * Phase 2 — Trust Layer (PURE, additive). Wraps the existing live behaviour
 * output with uncertainty, data-quality, and safety metadata. It does NOT touch
 * any analytics: session segmentation, A-Game math, deviation formulas, and the
 * risk-score weights are all consumed read-only and never recomputed here.
 *
 * Design intent (locked):
 *   • traders never misinterpret uncertainty as certainty
 *   • system failures never appear as valid signals
 *   • weak data is clearly marked as weak
 *   • no numeric output implies authority it has not earned
 *   • "0 = safe" ambiguity is eliminated (suppressed → null, never a low number)
 */

import type { AgameBaselineCore, LiveDeviationReport } from "./types";

// ── Thresholds (presentation only — no analytics) ────────────────────────────
export const TRUST_STALE_SECONDS   = 120;  // data age beyond which the feed is "stale"
export const CONF_MEDIUM_SESSIONS  = 20;   // baseline_strength MEDIUM floor
export const CONF_HIGH_SESSIONS    = 60;   // baseline_strength HIGH floor
export const STABILITY_OK          = 0.5;  // below → treated as unstable
export const STABILITY_HIGH        = 0.7;  // required (with session count) for HIGH

// ── Vocabulary ────────────────────────────────────────────────────────────────
export type SystemState =
  | "LIVE" | "STALE" | "REBUILDING" | "DISCONNECTED" | "CALIBRATING";
export type BaselineStrength = "LOW" | "MEDIUM" | "HIGH";
export type SignalQuality = "STRONG" | "WEAK" | "INSUFFICIENT_DATA";

export interface DataFreshness {
  is_stale:       boolean;
  last_update_ms: number;
  age_seconds:    number;
  source:         "live" | "cached" | "recomputed";
}

export interface ConfidenceInfo {
  baseline_strength: BaselineStrength;
  sample_size:       number;
  session_count:     number;
  stability_score:   number;  // 0–1
}

export interface RiskContext {
  label:         string;          // fixed, non-authoritative
  is_actionable: false;           // ALWAYS false — this layer never instructs
  warning:       string | null;
}

export type SignalQualityMap = {
  trade_count: SignalQuality;
  pace:        SignalQuality;
  size:        SignalQuality;
  duration:    SignalQuality;
  overall:     SignalQuality;
};

/** Runtime/transport context the trust layer needs (supplied by the caller). */
export interface TrustRuntime {
  now?:            number;   // default Date.now()
  connected?:      boolean;  // SSE/transport up? default true
  rebuilding?:     boolean;  // sessions/baseline mid-recompute? default false
  last_update_ms?: number;   // when this snapshot was produced/received; default now
  source_hint?:    "live" | "cached" | "recomputed";
}

/** The full trusted contract returned to the UI. */
export interface TrustedLiveReport {
  session_id:        string | null;
  system_state:      SystemState;
  message:           string | null;          // human state message (calibrating/stale/…)
  data_freshness:    DataFreshness;
  confidence:        ConfidenceInfo;
  deviations:        LiveDeviationReport["deviations"];   // passthrough — never recomputed
  flags:             LiveDeviationReport["flags"];        // passthrough
  signal_quality_map: SignalQualityMap;
  risk_score:        number | null;          // suppressed (null) when not actionable
  risk_context:      RiskContext;
  interpretation:    string[];               // passthrough (factual)
  baseline_reference: BaselineReference | null;
  computed_at:       string;
}

export interface BaselineReference {
  median_trade_count:              number | null;
  median_inter_trade_gap_seconds:  number | null;
  median_position_size:            number | null;
  median_session_duration_minutes: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure assembler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a raw live deviation report with the trust layer.
 *
 * @param report    Output of computeLiveDeviation (consumed read-only).
 * @param baseline  The A-Game baseline (for confidence + grounding), or null.
 * @param runtime   Transport/runtime context (connection, rebuild, freshness).
 */
export function applyTrustLayer(
  report: LiveDeviationReport,
  baseline: AgameBaselineCore | null,
  runtime: TrustRuntime = {},
): TrustedLiveReport {
  const now           = runtime.now ?? Date.now();
  const connected     = runtime.connected ?? true;
  const rebuilding    = runtime.rebuilding ?? false;
  const lastUpdateMs  = runtime.last_update_ms ?? now;

  const hasSession    = report.session_id != null;
  const baselineReady = report.baseline_ready;

  const ageSeconds = Math.max(0, (now - lastUpdateMs) / 1000);
  const ageStale   = ageSeconds > TRUST_STALE_SECONDS;

  // ── System state (priority: transport > rebuild > data-sufficiency > age) ──
  const system_state: SystemState =
    !connected      ? "DISCONNECTED" :
    rebuilding      ? "REBUILDING"   :
    !baselineReady  ? "CALIBRATING"  :
    ageStale        ? "STALE"        :
                      "LIVE";

  // ── Data freshness ──────────────────────────────────────────────────────────
  const is_stale = !connected || ageStale;
  const source: DataFreshness["source"] =
    rebuilding ? "cached" :
    is_stale   ? "cached" :
    (runtime.source_hint ?? "live");
  const data_freshness: DataFreshness = {
    is_stale, last_update_ms: lastUpdateMs, age_seconds: round1(ageSeconds), source,
  };

  // ── Confidence ──────────────────────────────────────────────────────────────
  const confidence = buildConfidence(baseline, baselineReady);

  // ── Signal quality (per deviation + overall) ────────────────────────────────
  const sq = (devValue: number | null): SignalQuality =>
    computeSignalQuality(devValue, confidence, system_state);
  const signal_quality_map: SignalQualityMap = {
    trade_count: sq(report.deviations.trade_count),
    pace:        sq(report.deviations.pace),
    size:        sq(report.deviations.size),
    duration:    sq(report.deviations.duration),
    overall:     computeSignalQuality(hasSession ? 1 : null, confidence, system_state),
  };

  // ── Risk score presentation: never "0 = safe"; suppress when not actionable ─
  // Numeric only when there is an active session, a ready baseline, and the feed
  // is not dead/calibrating. STALE/REBUILDING keep the (frozen) number + warning.
  const riskShown =
    hasSession && baselineReady &&
    system_state !== "CALIBRATING" && system_state !== "DISCONNECTED";
  const risk_score = riskShown ? report.risk_score : null;

  const risk_context: RiskContext = {
    label: "composite behavioural deviation index",
    is_actionable: false,
    warning: buildWarning(system_state, confidence.baseline_strength),
  };

  return {
    session_id: report.session_id,
    system_state,
    message: buildMessage(system_state, hasSession),
    data_freshness,
    confidence,
    deviations: report.deviations,   // PASSTHROUGH — deviation logic untouched
    flags: report.flags,             // PASSTHROUGH
    signal_quality_map,
    risk_score,
    risk_context,
    interpretation: report.interpretation,
    baseline_reference: buildBaselineReference(baseline),
    computed_at: new Date(now).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildConfidence(baseline: AgameBaselineCore | null, baselineReady: boolean): ConfidenceInfo {
  const count = baseline?.session_count ?? 0;
  // stability_score reuses the existing baseline_stability_score (dispersion of
  // the top-session features) — no new modelling is introduced here.
  const stability = baseline?.baseline_stability_score ?? 0;

  let strength: BaselineStrength;
  if (!baselineReady || baseline == null) {
    strength = "LOW";
  } else if (stability < STABILITY_OK) {
    strength = "LOW";                         // unstable → LOW regardless of count
  } else if (count >= CONF_HIGH_SESSIONS && stability >= STABILITY_HIGH) {
    strength = "HIGH";
  } else if (count >= CONF_MEDIUM_SESSIONS) {
    strength = "MEDIUM";
  } else {
    strength = "LOW";                         // < 20 sessions
  }

  return { baseline_strength: strength, sample_size: count, session_count: count, stability_score: round4(stability) };
}

function computeSignalQuality(
  devValue: number | null,
  conf: ConfidenceInfo,
  state: SystemState,
): SignalQuality {
  // No baseline / no comparison possible.
  if (state === "CALIBRATING") return "INSUFFICIENT_DATA";
  // This particular signal has no value to compare.
  if (devValue == null) return "INSUFFICIENT_DATA";

  let base: SignalQuality;
  if (conf.baseline_strength === "HIGH") base = "STRONG";
  else if (conf.baseline_strength === "MEDIUM") base = "WEAK";
  else base = conf.session_count < CONF_MEDIUM_SESSIONS ? "INSUFFICIENT_DATA" : "WEAK"; // LOW

  // Frozen / untrustworthy transport can never carry a STRONG signal.
  if ((state === "STALE" || state === "DISCONNECTED" || state === "REBUILDING") && base === "STRONG") {
    base = "WEAK";
  }
  return base;
}

function buildWarning(state: SystemState, strength: BaselineStrength): string | null {
  switch (state) {
    case "CALIBRATING":  return "Insufficient data to establish A-Game baseline; score suppressed.";
    case "DISCONNECTED": return "Feed disconnected — displayed values are frozen and may not reflect current activity.";
    case "REBUILDING":   return "Behavioural data is recomputing — values may shift.";
    case "STALE":        return "Data is stale — values may not reflect current activity.";
    default:             return strength === "LOW" ? "Limited session history — score may be unstable." : null;
  }
}

function buildMessage(state: SystemState, hasSession: boolean): string | null {
  switch (state) {
    case "CALIBRATING":  return "Insufficient data to establish A-Game baseline.";
    case "DISCONNECTED": return "Feed disconnected — values are frozen.";
    case "REBUILDING":   return "Behavioural data is recomputing.";
    case "STALE":        return "Data is stale.";
    default:             return hasSession ? null : "No active session.";
  }
}

function buildBaselineReference(baseline: AgameBaselineCore | null): BaselineReference | null {
  if (!baseline || baseline.status !== "ready") return null;
  return {
    median_trade_count:              baseline.median_trade_count,
    median_inter_trade_gap_seconds:  baseline.median_inter_trade_gap_seconds,
    median_position_size:            baseline.median_position_size,
    median_session_duration_minutes: baseline.median_session_duration_minutes,
  };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
function round4(x: number): number { return Math.round(x * 1e4) / 1e4; }
