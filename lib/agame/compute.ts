/**
 * lib/agame/compute.ts
 *
 * Phase 1 — pure A-Game baseline computation.
 *
 * computeAgameBaseline() is a PURE function of the session feature vectors it is
 * given (which come ONLY from the `sessions` table). No trades, no I/O, no ML,
 * no clustering, no randomness. Same sessions → same baseline.
 *
 * The locked rule, enforced here:
 *   • baseline values are the MEDIAN of the TOP sessions (never the mean of all)
 *   • outcome (expectancy) is used ONLY to select the top sessions
 *   • below AGAME_MIN_SESSIONS eligible → status "calibrating", all values null
 */

import { mean, median, iqr, robustCV, clamp01, round } from "./stats";
import {
  type SessionForAgame,
  type AgameBaselineCore,
  AGAME_MIN_SESSIONS,
  AGAME_RECOMMENDED_SESSIONS,
  AGAME_TOP_FRACTION,
  AGAME_TOP_MIN,
} from "./types";

/**
 * Compute the A-Game baseline for one (user, account).
 *
 * @param userId        Owner.
 * @param accountId     Account scope.
 * @param sessions      ALL of this account's sessions (eligible or not), each
 *                      carrying its materialised feature_vector + outcome.
 * @param totalSessions Total session count for the account (for coverage ratio).
 *                      Defaults to sessions.length.
 */
export function computeAgameBaseline(
  userId: string,
  accountId: string,
  sessions: SessionForAgame[],
  totalSessions: number = sessions.length,
): AgameBaselineCore {
  // ── Eligibility: ≥4 trades AND a computable expectancy ─────────────────────
  const eligible = sessions.filter(
    (s) =>
      s.eligible_for_analysis &&
      s.feature_vector != null &&
      s.outcome != null &&
      s.outcome.expectancy != null,
  );

  const coverage = totalSessions > 0 ? eligible.length / totalSessions : 0;

  const base: AgameBaselineCore = {
    user_id: userId,
    account_id: accountId,
    status: "calibrating",
    session_count: eligible.length,
    min_session_threshold: AGAME_MIN_SESSIONS,
    confidence_score: 0,
    baseline_stability_score: 0,
    data_coverage_ratio: round(coverage, 4),
    avg_trade_count: null,
    median_trade_count: null,
    trade_count_iqr: null,
    avg_inter_trade_gap_seconds: null,
    median_inter_trade_gap_seconds: null,
    pace_iqr: null,
    avg_session_duration_minutes: null,
    median_session_duration_minutes: null,
    avg_position_size: null,
    median_position_size: null,
    size_variance: null,
    post_loss_trade_delay_seconds: null,
    post_loss_size_change_ratio: null,
    entry_burst_ratio: null,
    avg_expectancy: null,
    median_expectancy: null,
    win_rate: null,
  };

  // Not enough data → calibrating (no baseline values).
  if (eligible.length < AGAME_MIN_SESSIONS) return base;

  // ── Rank by expectancy (desc); deterministic tiebreak on key ───────────────
  const ranked = [...eligible].sort((a, b) => {
    const ea = a.outcome!.expectancy as number;
    const eb = b.outcome!.expectancy as number;
    if (eb !== ea) return eb - ea;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const topCount = Math.min(
    eligible.length,
    Math.max(AGAME_TOP_MIN, Math.ceil(eligible.length * AGAME_TOP_FRACTION)),
  );
  const top = ranked.slice(0, topCount);

  // ── Gather per-feature arrays from the TOP sessions ────────────────────────
  const fv = (s: SessionForAgame) => s.feature_vector!;
  const oc = (s: SessionForAgame) => s.outcome!;
  const present = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);

  const tradeCounts = top.map((s) => fv(s).trade_count);
  const paces       = present(top.map((s) => fv(s).median_inter_trade_gap_seconds));
  const durationMin = top.map((s) => fv(s).session_duration_seconds / 60);
  const sizes       = top.map((s) => fv(s).median_position_size);
  const sizeVars    = top.map((s) => fv(s).size_variance);
  const bursts      = present(top.map((s) => fv(s).entry_burst_ratio));
  const plDelays    = present(top.map((s) => fv(s).post_loss_trade_delay_seconds));
  const plRatios    = present(top.map((s) => fv(s).post_loss_size_change_ratio));
  const expectancies = top.map((s) => oc(s).expectancy as number);
  const winRates    = present(top.map((s) => oc(s).win_rate));

  // ── Stability: lower robust dispersion across core features → more stable ──
  const cvs = [robustCV(tradeCounts), robustCV(paces), robustCV(durationMin), robustCV(sizes)];
  const stability = clamp01(1 - mean(cvs));

  // ── Confidence: blend of sample adequacy and stability ─────────────────────
  const sampleAdequacy = clamp01(eligible.length / AGAME_RECOMMENDED_SESSIONS);
  const confidence = clamp01(0.5 * sampleAdequacy + 0.5 * stability);

  const medOrNull = (xs: number[]) => (xs.length ? round(median(xs), 4) : null);

  return {
    ...base,
    status: "ready",
    confidence_score: round(confidence, 4),
    baseline_stability_score: round(stability, 4),

    avg_trade_count:    round(mean(tradeCounts), 4),
    median_trade_count: round(median(tradeCounts), 4),
    trade_count_iqr:    round(iqr(tradeCounts), 4),

    avg_inter_trade_gap_seconds:    paces.length ? round(mean(paces), 2) : null,
    median_inter_trade_gap_seconds: medOrNull(paces),
    pace_iqr:                       paces.length ? round(iqr(paces), 2) : null,

    avg_session_duration_minutes:    round(mean(durationMin), 2),
    median_session_duration_minutes: round(median(durationMin), 2),

    avg_position_size:    round(mean(sizes), 4),
    median_position_size: round(median(sizes), 4),
    size_variance:        round(median(sizeVars), 4),

    post_loss_trade_delay_seconds: medOrNull(plDelays),
    post_loss_size_change_ratio:   medOrNull(plRatios),

    entry_burst_ratio: medOrNull(bursts),

    avg_expectancy:    round(mean(expectancies), 4),
    median_expectancy: round(median(expectancies), 4),
    win_rate:          medOrNull(winRates),
  };
}
