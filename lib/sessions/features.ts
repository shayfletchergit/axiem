/**
 * lib/sessions/features.ts
 *
 * Phase 0.5 — per-session structural feature vector + outcome.
 *
 * This is the ONLY layer that reads trades to produce behavioural metrics. The
 * A-Game baseline (Phase 1) reads these materialised vectors from `sessions`
 * and never touches trades directly — satisfying the locked rule
 * "A-Game derived ONLY from sessions / no raw trades used directly".
 *
 * Pure & deterministic: computeSessionFeatures(trades) is a function of the
 * trades alone. No psychology, no ML, no per-trade scoring leaks upward — only
 * aggregate structural numbers.
 */

import { mean, median, variance, round } from "@/lib/agame/stats";
import type { SessionTrade, SessionFeatureVector, SessionOutcome } from "./types";

// Re-exported so existing importers (lib/db/agame.ts, lib/agame/types.ts) that
// reference these from the features module continue to resolve unchanged.
export type { SessionFeatureVector, SessionOutcome } from "./types";

/** Inter-entry gaps at/under this many seconds count as a "burst" entry. */
export const BURST_THRESHOLD_SECONDS = 120;

/**
 * Round-turn commission per contract, in dollars. Default 0 (no effect).
 * `trades.net_pnl` excludes commission; set this to fold a flat estimate into
 * `net_pnl_adj` so expectancy reflects the true cost of frequent trading.
 */
export const COMMISSION_PER_CONTRACT_RT = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes (SessionFeatureVector / SessionOutcome live in ./types; re-exported above)
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionFeatures {
  feature_vector: SessionFeatureVector;
  outcome:        SessionOutcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the structural feature vector + outcome for a single session's trades.
 *
 * @param trades  All trades in ONE session (any order; includes open/skipped).
 */
export function computeSessionFeatures(trades: SessionTrade[]): SessionFeatures {
  // Deterministic order: opened_at ASC, id ASC.
  const sorted = [...trades].sort((a, b) => {
    const ao = Date.parse(a.opened_at);
    const bo = Date.parse(b.opened_at);
    if (ao !== bo) return ao - bo;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const n = sorted.length;
  const openedMs = sorted.map((t) => Date.parse(t.opened_at));
  const closedMs = sorted.map((t) => (t.closed_at ? Date.parse(t.closed_at) : null));
  const sizes = sorted.map((t) => t.max_size);

  // ── Duration: first open → last activity (max of any open/close) ───────────
  const lastActivity = Math.max(
    ...openedMs,
    ...closedMs.map((c, i) => c ?? openedMs[i]),
  );
  const durationSec = (lastActivity - openedMs[0]) / 1000;

  // ── Pace: gaps between consecutive ENTRIES (opened_at deltas) ──────────────
  const gapsSec: number[] = [];
  for (let i = 1; i < n; i++) gapsSec.push((openedMs[i] - openedMs[i - 1]) / 1000);

  const burstRatio =
    gapsSec.length > 0
      ? gapsSec.filter((g) => g <= BURST_THRESHOLD_SECONDS).length / gapsSec.length
      : null;

  // ── Post-loss reaction (structural proxy, no psychology) ───────────────────
  // A "loss" = a closed, `ok`, negative-P&L trade. Look at the immediately
  // following trade in the session (if any).
  const postLossDelays: number[] = [];
  const postLossSizeRatios: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const t = sorted[i];
    const isLoss =
      t.reconstruction_status === "ok" && t.closed_at !== null && t.net_pnl !== null && t.net_pnl < 0;
    if (!isLoss) continue;
    const next = sorted[i + 1];
    const lossClose = closedMs[i];
    if (lossClose !== null) postLossDelays.push((openedMs[i + 1] - lossClose) / 1000);
    if (t.max_size > 0) postLossSizeRatios.push(next.max_size / t.max_size);
  }

  // ── Outcome (P&L only from closed `ok` trades; commission-adjusted) ────────
  let netPnl = 0;
  let pnlTrades = 0;
  let wins = 0;
  let losses = 0;
  let contracts = 0;
  for (const t of sorted) {
    if (t.reconstruction_status !== "ok" || t.closed_at === null || t.net_pnl === null) continue;
    netPnl += t.net_pnl;
    pnlTrades += 1;
    contracts += t.max_size;
    if (t.net_pnl > 0) wins += 1;
    else if (t.net_pnl < 0) losses += 1;
  }
  const netPnlAdj = netPnl - COMMISSION_PER_CONTRACT_RT * contracts;
  const decided = wins + losses;

  const feature_vector: SessionFeatureVector = {
    trade_count:                    n,
    session_duration_seconds:       round(durationSec, 1),
    median_inter_trade_gap_seconds: gapsSec.length ? round(median(gapsSec), 1) : null,
    mean_inter_trade_gap_seconds:   gapsSec.length ? round(mean(gapsSec), 1) : null,
    median_position_size:           round(median(sizes), 4),
    mean_position_size:             round(mean(sizes), 4),
    size_variance:                  round(variance(sizes), 4),
    entry_burst_ratio:              burstRatio === null ? null : round(burstRatio, 4),
    post_loss_trade_delay_seconds:  postLossDelays.length ? round(median(postLossDelays), 1) : null,
    post_loss_size_change_ratio:    postLossSizeRatios.length ? round(median(postLossSizeRatios), 4) : null,
    instrument_count:               new Set(sorted.map((t) => t.instrument)).size,
  };

  const outcome: SessionOutcome = {
    net_pnl:     round(netPnl, 4),
    net_pnl_adj: round(netPnlAdj, 4),
    trade_count: n,
    pnl_trades:  pnlTrades,
    wins,
    losses,
    win_rate:    decided > 0 ? round(wins / decided, 4) : null,
    expectancy:  n > 0 && pnlTrades > 0 ? round(netPnlAdj / n, 4) : null,
  };

  return { feature_vector, outcome };
}
