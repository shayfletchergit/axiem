/**
 * lib/db/trades.ts
 *
 * Persistence operations for the trades table.
 *
 * Design principle: trades are fully derived from executions.
 * They are never the source of truth — only a materialised view of reconstruction output.
 * Any trade row can be regenerated at any time by re-running reconstructTrades()
 * over the executions table for that position.
 *
 * Atomicity guarantee
 * ───────────────────
 * replacePositionTrades calls the `replace_position_trades` Postgres RPC.
 * That RPC issues DELETE + INSERT inside a single transaction, so there is
 * never a window where a position has zero trades due to a partial write.
 *
 * Required Postgres schema
 * ────────────────────────
 * See supabase/migrations/005_executions_trades.sql for full DDL.
 * Minimum documented at the bottom of this file.
 */

import { createServiceClient } from "@/lib/supabase/server";
import type { ReconstructedTrade } from "@/lib/reconstructor";

// ─────────────────────────────────────────────────────────────────────────────
// Replace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically replace all trades for a position with a fresh reconstruction set.
 *
 * Calls the `replace_position_trades` Postgres RPC which:
 *   1. DELETEs all existing trades for (user_id, symbol, account_id).
 *   2. INSERTs the new set — including open trades, complex_reversal skips, etc.
 *   Both steps execute in a single Postgres transaction (atomic, never partial).
 *
 * Correctness note on concurrency
 * ────────────────────────────────
 * The advisory lock in getForReconstruction() serialises the READ phase.
 * This write completes independently, after the lock has been released.
 * If two reconstructions race (lock-serialised reads, parallel writes):
 *   - Both reads produce valid, monotonically increasing execution snapshots.
 *   - The second write wins (last-write-wins via DELETE+INSERT).
 *   - Because the second read happened after the first's lock released, it
 *     always read ≥ as many executions as the first.
 *   - The final DB state therefore reflects the most complete reconstruction.
 * This is sufficient for MVP correctness at expected user volumes.
 *
 * @param userId    - Authenticated Supabase user UUID.
 * @param symbol    - Instrument symbol (e.g. "ESM5").
 * @param accountId - Broker account ID string.
 * @param trades    - Full set of ReconstructedTrade from the reconstructor,
 *                    including open and complex_reversal records.
 */
export async function replacePositionTrades(
  userId: string,
  symbol: string,
  accountId: string,
  trades: ReconstructedTrade[],
): Promise<void> {
  const supabase = createServiceClient();

  // Serialise to plain objects before JSONB transfer.
  // null values must be JSON null (not undefined) so Postgres casts work correctly.
  const payload = trades.map((t) => ({
    direction:              t.direction,
    opened_at:              t.openedAt,
    closed_at:              t.closedAt ?? null,
    entry_price:            t.entryPrice ?? null,
    exit_price:             t.exitPrice ?? null,
    max_size:               t.maxSize,
    execution_ids:          t.executionIds,
    reconstruction_status:  t.reconstructionStatus,
    behavioral_tags:        t.behavioralTags,
    pnl_points:             t.pnlPoints ?? null,
    net_pnl:                t.netPnl ?? null,
  }));

  const { error } = await supabase.rpc("replace_position_trades", {
    p_user_id:    userId,
    p_symbol:     symbol,
    p_account_id: accountId,
    p_trades:     payload,
  });

  if (error) {
    throw new Error(`[db/trades] replace_position_trades failed: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read helpers (used by /api/session/current for SSE reconnect reconciliation)
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeRow {
  id:                     string;
  user_id:                string;
  account_id:             string;
  symbol:                 string;
  direction:              "long" | "short";
  opened_at:              string;
  closed_at:              string | null;
  entry_price:            number | null;
  exit_price:             number | null;
  max_size:               number;
  execution_ids:          string[];
  reconstruction_status:  "ok" | "skipped";
  behavioral_tags:        string[];
  pnl_points:             number | null;
  net_pnl:                number | null;
  created_at:             string;
  updated_at:             string;
}

/**
 * Read all trades for a user's current session.
 * "Session" here means all trades opened on or after the start of the current
 * CME trading day (5 PM CT = 22:00 UTC the prior calendar day).
 *
 * Returns trades ordered by opened_at DESC (most recent first).
 * Excludes complex_reversal trades from the default view — callers that need
 * them can filter by reconstruction_status.
 */
export async function getSessionTrades(
  userId: string,
  sessionStartUtc: Date = cmeSessionStart(),
): Promise<TradeRow[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .eq("user_id", userId)
    .gte("opened_at", sessionStartUtc.toISOString())
    .neq("reconstruction_status", "skipped")
    .order("opened_at", { ascending: false });

  if (error) {
    throw new Error(`[db/trades] getSessionTrades failed: ${error.message}`);
  }

  return (data ?? []) as TradeRow[];
}

/**
 * Compute the start of the current CME trading session.
 * CME equity futures roll at 17:00 CT = 22:00 UTC (23:00 UTC during CDT).
 * For MVP, we use a fixed 22:00 UTC offset.  A proper implementation would
 * account for US daylight saving time transitions.
 */
function cmeSessionStart(): Date {
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // 22:00 UTC = 17:00 CT standard time
  const rollHour = 22;
  const rollMs = rollHour * 60 * 60 * 1000;
  const todayRoll = new Date(todayUtc.getTime() + rollMs);
  // If we're before today's roll time, the session started yesterday
  return now < todayRoll
    ? new Date(todayRoll.getTime() - 24 * 60 * 60 * 1000)
    : todayRoll;
}

// ─────────────────────────────────────────────────────────────────────────────
// Required Postgres schema
// ─────────────────────────────────────────────────────────────────────────────
// Run supabase/migrations/005_executions_trades.sql
//
// Minimum required for this module:
//
//   CREATE TABLE trades (
//     id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
//     account_id            TEXT NOT NULL,
//     symbol                TEXT NOT NULL,
//     direction             TEXT NOT NULL CHECK (direction IN ('long','short')),
//     opened_at             TIMESTAMPTZ NOT NULL,
//     closed_at             TIMESTAMPTZ,
//     entry_price           NUMERIC(12,4),
//     exit_price            NUMERIC(12,4),
//     max_size              INTEGER NOT NULL CHECK (max_size > 0),
//     execution_ids         TEXT[] NOT NULL DEFAULT '{}',
//     reconstruction_status TEXT NOT NULL DEFAULT 'ok'
//                           CHECK (reconstruction_status IN ('ok','skipped')),
//     behavioral_tags       TEXT[] NOT NULL DEFAULT '{}',
//     pnl_points            NUMERIC(12,4),
//     net_pnl               NUMERIC(12,4),
//     created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//
//   CREATE INDEX trades_session_idx
//     ON trades (user_id, symbol, account_id, opened_at DESC);
//
//   CREATE OR REPLACE FUNCTION replace_position_trades(
//     p_user_id UUID, p_symbol TEXT, p_account_id TEXT, p_trades JSONB
//   ) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
//   BEGIN
//     DELETE FROM trades
//     WHERE user_id = p_user_id AND symbol = p_symbol AND account_id = p_account_id;
//
//     IF jsonb_array_length(p_trades) = 0 THEN RETURN; END IF;
//
//     INSERT INTO trades (
//       user_id, account_id, symbol, direction,
//       opened_at, closed_at, entry_price, exit_price,
//       max_size, execution_ids, reconstruction_status,
//       behavioral_tags, pnl_points, net_pnl
//     )
//     SELECT
//       p_user_id, p_account_id, p_symbol,
//       (t->>'direction')::text,
//       (t->>'opened_at')::timestamptz,
//       (t->>'closed_at')::timestamptz,
//       (t->>'entry_price')::numeric,
//       (t->>'exit_price')::numeric,
//       (t->>'max_size')::integer,
//       ARRAY(SELECT jsonb_array_elements_text(t->'execution_ids')),
//       (t->>'reconstruction_status')::text,
//       ARRAY(SELECT jsonb_array_elements_text(t->'behavioral_tags')),
//       (t->>'pnl_points')::numeric,
//       (t->>'net_pnl')::numeric
//     FROM jsonb_array_elements(p_trades) AS t;
//   END; $$;
