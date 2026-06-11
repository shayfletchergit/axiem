/**
 * lib/db/executions.ts
 *
 * Persistence operations for the executions table.
 *
 * Invariants enforced here
 * ─────────────────────────
 *   INV-C  Duplicate executions are silently dropped — never reach reconstruction.
 *          Guaranteed by UNIQUE(user_id, synthetic_id) constraint + conflict detection.
 *
 *   INV-D  Reconstruction always reads via the advisory-lock RPC.
 *          The RPC serialises concurrent reads for the same (user, symbol, account)
 *          triple inside a Postgres transaction, ensuring a consistent snapshot.
 *
 *   INV-5  (from reconstructor) The query ORDER BY is the sole enforcement point
 *          for fill sort order.  The reconstructor trusts this ordering completely.
 *
 * Required Postgres schema
 * ────────────────────────
 * Run the migration in supabase/migrations/005_executions_trades.sql before use.
 * The minimum required schema is documented at the bottom of this file.
 */

import { createServiceClient } from "@/lib/supabase/server";
import type { Execution } from "@/lib/broker/types";

// ─────────────────────────────────────────────────────────────────────────────
// Insert
// ─────────────────────────────────────────────────────────────────────────────

export interface InsertResult {
  /** True = new row written. False = duplicate silently ignored (INV-C). */
  inserted: boolean;
  /** DB uuid of the execution row, or null on duplicate. */
  dbId: string | null;
}

/**
 * Insert a single normalised execution, idempotent.
 *
 * Uses ON CONFLICT DO NOTHING on the UNIQUE(user_id, synthetic_id) constraint.
 * Returns { inserted: false } when the execution has already been seen — the
 * caller must treat this as a clean no-op, not an error.
 *
 * @param userId - Authenticated Supabase user UUID.
 * @param ex     - Normalised execution (output of normalizeRawFill).
 * @param rawPayload - Original broker object, stored for audit / schema change recovery.
 */
export async function insertExecution(
  userId: string,
  ex: Execution,
  rawPayload: Record<string, unknown>,
): Promise<InsertResult> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("executions")
    .insert({
      user_id:        userId,
      synthetic_id:   ex.id,            // `${accountId}:${brokerExecId}` — dedup key
      broker_exec_id: ex.brokerExecId,
      account_id:     ex.accountId,
      symbol:         ex.symbol,
      side:           ex.side,
      qty:            ex.qty,
      price:          ex.price,
      fill_timestamp: ex.timestamp,
      order_id:       ex.orderId ?? null,
      received_at:    ex.receivedAt,
      raw_payload:    rawPayload,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation — duplicate fill, clean no-op (INV-C)
    if (error.code === "23505") {
      return { inserted: false, dbId: null };
    }
    // Any other DB error is a real failure — propagate to ingest for logging
    throw new Error(`[db/executions] insert failed: ${error.message} (${error.code})`);
  }

  return { inserted: true, dbId: (data as { id: string }).id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read (advisory-locked snapshot for reconstruction)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all executions for a position, sorted and advisory-locked.
 *
 * Calls the `read_executions_for_reconstruction` Postgres RPC which:
 *   1. Acquires pg_advisory_xact_lock on (user_id, symbol, account_id).
 *   2. Reads all matching executions ORDER BY fill_timestamp ASC, synthetic_id ASC.
 *   3. Returns the rows (lock is transaction-scoped; released when RPC returns).
 *
 * Serialisation guarantee: two concurrent reconstruction triggers for the same
 * position will not read overlapping snapshots — the second waits for the first
 * to complete its read before it can begin.  Combined with the atomic
 * replace_position_trades RPC, this ensures the final DB state always converges
 * to the most-complete reconstruction.
 *
 * INV-5: ORDER BY is enforced inside the RPC, not assumed by the caller.
 *
 * @returns Executions sorted (fill_timestamp ASC, synthetic_id ASC), ready for
 *          direct input to reconstructTrades().
 */
export async function getForReconstruction(
  userId: string,
  symbol: string,
  accountId: string,
): Promise<Execution[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc(
    "read_executions_for_reconstruction",
    {
      p_user_id:    userId,
      p_symbol:     symbol,
      p_account_id: accountId,
    },
  );

  if (error) {
    throw new Error(
      `[db/executions] read_executions_for_reconstruction failed: ${error.message}`,
    );
  }

  return ((data ?? []) as Record<string, unknown>[]).map(mapRowToExecution);
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping
// ─────────────────────────────────────────────────────────────────────────────

/** Map a DB execution row to the canonical Execution interface. */
function mapRowToExecution(row: Record<string, unknown>): Execution {
  return {
    id:           row["synthetic_id"] as string,
    brokerExecId: row["broker_exec_id"] as string,
    accountId:    row["account_id"] as string,
    symbol:       row["symbol"] as string,
    side:         row["side"] as "buy" | "sell",
    qty:          Number(row["qty"]),
    price:        Number(row["price"]),
    timestamp:    row["fill_timestamp"] as string,
    receivedAt:   Number(row["received_at"]),
    orderId:      (row["order_id"] as string | null) ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Required Postgres schema
// ─────────────────────────────────────────────────────────────────────────────
// Run supabase/migrations/005_executions_trades.sql
//
// Minimum required for this module:
//
//   CREATE TABLE executions (
//     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
//     synthetic_id    TEXT NOT NULL,          -- dedup key: `${accountId}:${brokerExecId}`
//     broker_exec_id  TEXT NOT NULL,
//     account_id      TEXT NOT NULL,
//     symbol          TEXT NOT NULL,
//     side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
//     qty             INTEGER NOT NULL CHECK (qty > 0),
//     price           NUMERIC(12,4) NOT NULL CHECK (price > 0),
//     fill_timestamp  TIMESTAMPTZ NOT NULL,
//     order_id        TEXT,
//     received_at     BIGINT NOT NULL,
//     raw_payload     JSONB NOT NULL DEFAULT '{}',
//     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     CONSTRAINT executions_user_synthetic_uniq UNIQUE (user_id, synthetic_id)
//   );
//
//   CREATE INDEX executions_reconstruction_idx
//     ON executions (user_id, symbol, account_id, fill_timestamp ASC, synthetic_id ASC);
//
//   CREATE OR REPLACE FUNCTION read_executions_for_reconstruction(
//     p_user_id UUID, p_symbol TEXT, p_account_id TEXT
//   ) RETURNS SETOF executions LANGUAGE plpgsql SECURITY DEFINER AS $$
//   BEGIN
//     PERFORM pg_advisory_xact_lock(
//       hashtext(p_user_id::text),
//       hashtext(p_symbol || '|' || p_account_id)
//     );
//     RETURN QUERY
//       SELECT * FROM executions
//       WHERE user_id = p_user_id AND symbol = p_symbol AND account_id = p_account_id
//       ORDER BY fill_timestamp ASC, synthetic_id ASC;
//   END; $$;
