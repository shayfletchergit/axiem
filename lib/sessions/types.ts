/**
 * lib/sessions/types.ts
 *
 * Phase 0 — Behavioural Intelligence System: session segmentation types.
 *
 * A "session" is a derived behavioural unit: a contiguous period of trading
 * activity per ACCOUNT (across all instruments). Sessions are NOT a source of
 * truth — they are a deterministic materialised view over the `trades` table,
 * which is itself derived from the immutable `event_log`.
 *
 *   event_log (truth) → trades (derived) → sessions (derived, this module)
 *
 * Nothing here depends on client state, journaling, or subjective input.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants (tunable defaults — see Technical Spec §2, §5)
// ─────────────────────────────────────────────────────────────────────────────

/** Idle-while-flat gap that starts a new session. Default G = 75 minutes. */
export const DEFAULT_GAP_MS = 75 * 60 * 1000;

/** A session is eligible for downstream analytics only at/above this trade count. */
export const DEFAULT_MIN_ELIGIBLE_TRADES = 4;

/**
 * Exchange timezone used for the trading-day boundary.
 * CME equity-index futures roll at 17:00 CT; a timestamp at/after 17:00 CT
 * belongs to the NEXT trading day's session.
 */
export const EXCHANGE_TZ = "America/Chicago";
export const SESSION_ROLL_HOUR_CT = 17;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SessionStatus = "open" | "provisional" | "closed";

/**
 * Structural feature vector materialised per session (stored in
 * sessions.feature_vector as JSONB). Computed by lib/sessions/features.ts.
 * Read by the A-Game engine — the only behavioural numbers it ever sees.
 */
export interface SessionFeatureVector {
  trade_count:                     number;
  session_duration_seconds:        number;
  median_inter_trade_gap_seconds:  number | null;  // null when < 2 entries
  mean_inter_trade_gap_seconds:    number | null;
  median_position_size:            number;
  mean_position_size:              number;
  size_variance:                   number;
  entry_burst_ratio:               number | null;  // share of gaps ≤ burst threshold
  post_loss_trade_delay_seconds:   number | null;  // null when no qualifying loss
  post_loss_size_change_ratio:     number | null;
  instrument_count:                number;
}

/** Session-level outcome (stored in sessions.outcome as JSONB). */
export interface SessionOutcome {
  net_pnl:      number;          // Σ net_pnl over closed `ok` trades
  net_pnl_adj:  number;          // net_pnl − commission estimate
  trade_count:  number;          // total trades (expectancy denominator)
  pnl_trades:   number;          // count of trades that contributed P&L
  wins:         number;
  losses:       number;
  win_rate:     number | null;   // wins / (wins+losses); null if none decided
  expectancy:   number | null;   // net_pnl_adj / trade_count; null if no trades
}

/**
 * The minimal trade shape the segmenter consumes.
 *
 * Sourced ONLY from the `trades` table. `instrument` maps from `trades.symbol`
 * (the DB column is named `symbol`). All fields are reconstructed truth.
 */
export interface SessionTrade {
  id:                     string;        // trades.id (uuid) — deterministic tiebreak
  account_id:             string;
  instrument:             string;        // mapped from trades.symbol
  opened_at:              string;        // ISO 8601 — first entry fill time
  closed_at:              string | null; // ISO 8601 — null = position still open
  max_size:               number;
  net_pnl:                number | null; // null for open / complex_reversal / unknown instrument
  direction:              "long" | "short";
  reconstruction_status:  "ok" | "skipped";
}

/**
 * A derived session. `feature_vector` and `outcome` are intentionally NULL in
 * Phase 0 — they are placeholders the Phase 1 A-Game engine will populate.
 */
export interface Session {
  session_id:             string;                       // deterministic (UUIDv5-style hash)
  user_id:                string;
  account_id:             string;
  start_ts:               string;                       // ISO — first trade opened_at
  end_ts:                 string;                       // ISO — last flat point (or last activity if open)
  trade_count:            number;
  first_trade_id:         string;
  last_trade_id:          string;
  status:                 SessionStatus;
  eligible_for_analysis:  boolean;
  feature_vector:         SessionFeatureVector | null;     // null until materialised
  outcome:                SessionOutcome | null;           // null until materialised
}

/**
 * A session paired with the trades that belong to it. Returned by
 * assignSessions() so the feature layer can compute per-session metrics without
 * re-deriving the segmentation. buildSessions() returns only the `.session`.
 */
export interface SessionGroup {
  session: Session;
  trades:  SessionTrade[];
}

export interface SegmentOptions {
  /** Idle-while-flat gap (ms) that starts a new session. Default DEFAULT_GAP_MS. */
  gapMs?:              number;
  /** Minimum trades for `eligible_for_analysis = true`. Default DEFAULT_MIN_ELIGIBLE_TRADES. */
  minEligibleTrades?: number;
  /** Split sessions at the CME trading-day boundary (17:00 CT). Default true. */
  splitOnDayBoundary?: boolean;
  /**
   * Reference "now" in ms. ONLY affects whether the trailing (most recent)
   * session is classified open/provisional/closed. Historical sessions are
   * unaffected, so segmentation remains deterministic across replays for all
   * but the live tail. Default Date.now().
   */
  now?:               number;
}
