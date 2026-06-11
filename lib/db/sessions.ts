/**
 * lib/db/sessions.ts
 *
 * Phase 0 — persistence layer for the derived `sessions` table.
 *
 * Read-only over `trades`; write-only to `sessions` (its own derived cache).
 * This module NEVER touches event_log, executions, trades (writes), or any
 * existing reconstruction/ingestion path. It is purely additive.
 *
 * Source-of-truth discipline
 * ──────────────────────────
 *   trades (derived) ──read──▶ buildSessions() ──write──▶ sessions (derived)
 *
 * sessions can be dropped and fully regenerated at any time via
 * rebuildSessionsFromTrades(). Idempotent: re-running replaces in one
 * transaction (replace_user_sessions RPC), never duplicates.
 *
 * Required schema: supabase/migrations/009_sessions.sql
 */

import { createServiceClient } from "@/lib/supabase/server";
import { assignSessions } from "@/lib/sessions/segment";
import { computeSessionFeatures } from "@/lib/sessions/features";
import type { Session, SessionTrade, SegmentOptions } from "@/lib/sessions/types";

// Supabase caps a single select at 1000 rows; page through to read everything.
const PAGE_SIZE = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Read: trades → SessionTrade[]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read ALL of a user's trades as the minimal SessionTrade shape, fully paged.
 *
 * Includes `skipped` (complex_reversal) trades — they carry valid opened_at /
 * closed_at and represent real activity, so they participate in flat-state
 * detection. Maps the DB column `symbol` → domain field `instrument`.
 *
 * Ordered (opened_at ASC, id ASC) for stable paging; buildSessions re-sorts
 * defensively regardless.
 *
 * @param userId     Owner.
 * @param accountId  Optional filter to a single account.
 */
export async function readTradesForSessions(
  userId: string,
  accountId?: string,
): Promise<SessionTrade[]> {
  const supabase = createServiceClient();
  const all: SessionTrade[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("trades")
      .select("id, account_id, symbol, opened_at, closed_at, max_size, net_pnl, direction, reconstruction_status")
      .eq("user_id", userId)
      .order("opened_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (accountId) query = query.eq("account_id", accountId);

    const { data, error } = await query;
    if (error) {
      throw new Error(`[db/sessions] readTradesForSessions failed: ${error.message}`);
    }

    const rows = (data ?? []) as Array<{
      id: string;
      account_id: string;
      symbol: string;
      opened_at: string;
      closed_at: string | null;
      max_size: number;
      net_pnl: number | null;
      direction: "long" | "short";
      reconstruction_status: "ok" | "skipped";
    }>;

    for (const r of rows) {
      all.push({
        id:                    r.id,
        account_id:            r.account_id,
        instrument:            r.symbol,           // DB `symbol` → domain `instrument`
        opened_at:             r.opened_at,
        closed_at:             r.closed_at,
        max_size:              r.max_size,
        net_pnl:               r.net_pnl,
        direction:             r.direction,
        reconstruction_status: r.reconstruction_status,
      });
    }

    if (rows.length < PAGE_SIZE) break; // last page
  }

  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write: replace a user's sessions atomically
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically replace ALL of a user's sessions with the supplied set.
 *
 * Calls the `replace_user_sessions` RPC (DELETE + INSERT in one transaction).
 * Idempotent — safe to run repeatedly.
 */
export async function replaceUserSessions(userId: string, sessions: Session[]): Promise<void> {
  const supabase = createServiceClient();

  const payload = sessions.map((s) => ({
    session_id:            s.session_id,
    account_id:            s.account_id,
    start_ts:              s.start_ts,
    end_ts:                s.end_ts,
    trade_count:           s.trade_count,
    first_trade_id:        s.first_trade_id,
    last_trade_id:         s.last_trade_id,
    status:                s.status,
    eligible_for_analysis: s.eligible_for_analysis,
    feature_vector:        s.feature_vector ?? null,
    outcome:               s.outcome ?? null,
  }));

  const { error } = await supabase.rpc("replace_user_sessions", {
    p_user_id:  userId,
    p_sessions: payload,
  });

  if (error) {
    throw new Error(`[db/sessions] replace_user_sessions failed: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration: recompute a user's sessions from trades
// ─────────────────────────────────────────────────────────────────────────────

export interface RebuildSessionsResult {
  userId:          string;
  tradesRead:      number;
  sessionsWritten: number;
  eligibleCount:   number;
  openCount:       number;
  durationMs:      number;
}

/**
 * Recompute and persist ALL sessions for a user from their trades.
 *
 * Pure read of `trades` → deterministic buildSessions() → atomic replace.
 * Fully idempotent and replay-safe. This is the one-time Phase 0 backfill unit
 * and the building block any future incremental scheduler would call.
 *
 * @param userId  Owner.
 * @param opts    Segmentation options (gap, eligibility, day-boundary, now).
 */
export async function rebuildSessionsFromTrades(
  userId: string,
  opts: SegmentOptions = {},
): Promise<RebuildSessionsResult> {
  const t0 = Date.now();

  const trades = await readTradesForSessions(userId);

  // Segment → then materialise each session's structural feature vector + outcome.
  // Features are computed here (the sessions layer) so downstream A-Game reads
  // ONLY sessions, never trades.
  const groups   = assignSessions(userId, trades, opts);
  const sessions: Session[] = groups.map((g) => {
    const { feature_vector, outcome } = computeSessionFeatures(g.trades);
    return { ...g.session, feature_vector, outcome };
  });

  await replaceUserSessions(userId, sessions);

  return {
    userId,
    tradesRead:      trades.length,
    sessionsWritten: sessions.length,
    eligibleCount:   sessions.filter((s) => s.eligible_for_analysis).length,
    openCount:       sessions.filter((s) => s.status === "open").length,
    durationMs:      Date.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read helper (verification / future read paths)
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionRow {
  session_id:            string;
  user_id:               string;
  account_id:            string;
  start_ts:              string;
  end_ts:                string;
  trade_count:           number;
  first_trade_id:        string;
  last_trade_id:         string;
  status:                "open" | "provisional" | "closed";
  eligible_for_analysis: boolean;
  feature_vector:        Record<string, unknown> | null;
  outcome:               Record<string, unknown> | null;
  computed_at:           string;
}

/** Read a user's stored sessions (most recent first). For verification/UI later. */
export async function getSessions(userId: string, accountId?: string): Promise<SessionRow[]> {
  const supabase = createServiceClient();
  let query = supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .order("start_ts", { ascending: false });

  if (accountId) query = query.eq("account_id", accountId);

  const { data, error } = await query;
  if (error) {
    throw new Error(`[db/sessions] getSessions failed: ${error.message}`);
  }
  return (data ?? []) as SessionRow[];
}
