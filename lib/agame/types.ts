/**
 * lib/agame/types.ts
 *
 * Phase 1 — A-Game baseline types & constants.
 *
 * A-Game = a median-based structural fingerprint of a trader's top-performing
 * sessions, used as a fixed behavioural reference point. Derived ONLY from
 * `sessions` (their materialised feature_vector + outcome) — never trades.
 */

import type { SessionFeatureVector, SessionOutcome } from "@/lib/sessions/features";

// ── Selection constants (locked spec §2) ─────────────────────────────────────

/** Hard minimum eligible sessions before a baseline can be computed at all. */
export const AGAME_MIN_SESSIONS = 12;
/** Recommended sample for full confidence. */
export const AGAME_RECOMMENDED_SESSIONS = 20;
/** Select the top fraction of sessions by expectancy. */
export const AGAME_TOP_FRACTION = 1 / 3;
/** Never compute medians from fewer than this many top sessions. */
export const AGAME_TOP_MIN = 4;

export type AgameStatus = "calibrating" | "ready";

// ── Input: one session as seen by the A-Game engine ──────────────────────────
// Sourced entirely from the `sessions` table. `key` is a stable tiebreak
// (session_id) so ranking is deterministic regardless of input order.

export interface SessionForAgame {
  key:                   string;
  eligible_for_analysis: boolean;
  feature_vector:        SessionFeatureVector | null;
  outcome:               SessionOutcome | null;
}

// ── Output: the A-Game baseline (analytics fields; id/computed_at added on write)

export interface AgameBaselineCore {
  user_id:    string;
  account_id: string;
  status:     AgameStatus;

  // Metadata
  session_count:          number;  // eligible sessions considered
  min_session_threshold:  number;
  confidence_score:       number;  // 0–1
  baseline_stability_score: number; // 0–1
  data_coverage_ratio:    number;  // eligible / total sessions

  // Structural baseline — medians of the TOP sessions (the product). Null while calibrating.
  avg_trade_count:                 number | null;
  median_trade_count:              number | null;
  trade_count_iqr:                 number | null;

  avg_inter_trade_gap_seconds:     number | null;
  median_inter_trade_gap_seconds:  number | null;
  pace_iqr:                        number | null;

  avg_session_duration_minutes:    number | null;
  median_session_duration_minutes: number | null;

  avg_position_size:               number | null;
  median_position_size:            number | null;
  size_variance:                   number | null;

  post_loss_trade_delay_seconds:   number | null;
  post_loss_size_change_ratio:     number | null;

  entry_burst_ratio:               number | null;

  // Outcome — used ONLY to select best sessions; reported for transparency.
  avg_expectancy:                  number | null;
  median_expectancy:               number | null;
  win_rate:                        number | null;
}

/** On-demand deviation of a live/partial session from the A-Game baseline. NOT persisted. */
export interface AgameDeviation {
  trade_count: number | null; // signed fraction, e.g. -0.18 = 18% below baseline
  pace:        number | null;
  size:        number | null;
  duration:    number | null;
}

/** Minimal live-session shape the deviation helper compares against the baseline. */
export interface LiveSessionSnapshot {
  trade_count:                    number;
  median_inter_trade_gap_seconds: number | null;
  median_position_size:           number;
  session_duration_seconds:       number;
}

// ── Phase 1.5 — Live Behaviour Deviation Engine ──────────────────────────────

/** Deterministic, rule-based behaviour flags (no ML, no psychology). */
export interface BehaviourFlags {
  overtrading:      boolean;  // trade_count  > baseline × 1.25
  speed_escalation: boolean;  // inter-trade gap < baseline × 0.75 (faster)
  size_escalation:  boolean;  // position size > baseline × 1.20
  session_drift:    boolean;  // |deviation| > 30% on ≥ 2 major features
}

/**
 * Real-time comparison of the active session against the A-Game baseline.
 * Read-only analytics; suitable for SSE/polling. `deviations` are SIGNED
 * FRACTIONS ((live − baseline) / baseline); UI renders them as %.
 */
export interface LiveDeviationReport {
  session_id:     string | null;   // null when there is no active session
  baseline_ready: boolean;         // false while A-Game is calibrating / absent
  deviations: {
    trade_count: number | null;
    pace:        number | null;    // negative = faster than baseline
    size:        number | null;
    duration:    number | null;
  };
  flags:          BehaviourFlags;
  risk_score:     number;          // 0–100, weighted sum of risk-increasing deviations
  interpretation: string[];        // factual, non-prescriptive statements
  computed_at:    string;          // ISO timestamp
}

/** The active-session input the engine consumes (from `sessions`). */
export interface ActiveSessionInput {
  session_id:     string;
  status:         "open" | "provisional" | "closed";
  start_ts:       string;
  feature_vector: SessionFeatureVector | null;
  /** When this session's features were last materialised (sessions.computed_at). */
  computed_at?:   string;
}
