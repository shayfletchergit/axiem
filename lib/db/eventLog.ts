/**
 * lib/db/eventLog.ts
 *
 * Persistence layer for the event_log table — the sole source of truth.
 *
 * Design principles
 * ─────────────────
 *   EV-1  append-only.  No UPDATE, no DELETE on event_log rows.
 *   EV-3  event_sequence_id (DB-assigned IDENTITY) is the ordering key.
 *         Never ORDER BY fill_timestamp or synthetic_id from this layer.
 *   EV-4  broker_event_hash is the ONLY dedup key.
 *         Duplicate = error code 23505 on UNIQUE(user_id, broker_event_hash).
 *
 * Required Postgres schema
 * ────────────────────────
 * See supabase/migrations/006_event_sourcing.sql for full DDL.
 */

import { createServiceClient }    from "@/lib/supabase/server";
import type { EventLogEntry, EventPayload, ExecutionEventPayload } from "@/lib/events/types";

// ─────────────────────────────────────────────────────────────────────────────
// Append (write path)
// ─────────────────────────────────────────────────────────────────────────────

export interface AppendResult {
  /**
   * True = new event written.
   * False = duplicate (UNIQUE conflict on broker_event_hash); clean no-op.
   */
  appended: boolean;
  /** DB-assigned event_sequence_id, or null on duplicate. */
  sequenceId: number | null;
}

/**
 * Append a single event to the event_log.
 *
 * Idempotent: if broker_event_hash already exists for this user, returns
 * { appended: false, sequenceId: null } — no error, no side effect.
 *
 * @param userId           Authenticated Supabase user UUID.
 * @param broker           Broker identifier (e.g. "tradovate").
 * @param accountId        Broker account ID.
 * @param instrument       Canonical symbol (e.g. "ESM5").
 * @param eventType        Event type (e.g. "execution").
 * @param brokerEventHash  Dedup key: `${broker}:${accountId}:${brokerExecId}`.
 * @param payload          Typed event payload.
 * @param rawPayload       Original broker object, unmodified.
 */
export async function appendEvent(
  userId:           string,
  broker:           string,
  accountId:        string,
  instrument:       string,
  eventType:        string,
  brokerEventHash:  string,
  payload:          EventPayload,
  rawPayload:       Record<string, unknown>,
): Promise<AppendResult> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("event_log")
    .insert({
      user_id:           userId,
      broker,
      account_id:        accountId,
      instrument,
      event_type:        eventType,
      broker_event_hash: brokerEventHash,
      payload,
      raw_payload:       rawPayload,
    })
    .select("event_sequence_id")
    .single();

  if (error) {
    // 23505 = unique_violation — duplicate event, clean no-op (EV-4)
    if (error.code === "23505") {
      return { appended: false, sequenceId: null };
    }
    throw new Error(`[db/eventLog] append failed: ${error.message} (${error.code})`);
  }

  return {
    appended:   true,
    sequenceId: (data as { event_sequence_id: number }).event_sequence_id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read (reconstruction read path)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all events for a (user, instrument, account) position, sorted by
 * event_sequence_id ASC.
 *
 * Calls the `read_events_for_reconstruction` RPC which:
 *   1. Acquires pg_advisory_xact_lock on (user_id, instrument, account_id).
 *   2. Returns events ORDER BY event_sequence_id ASC.
 *
 * Advisory lock: two concurrent reconstruction attempts for the same position
 * serialise here.  The second waits until the first's read transaction ends,
 * guaranteeing a monotonically increasing snapshot.
 *
 * @returns Events sorted by event_sequence_id ASC, ready for reduceEvents().
 */
export async function readEventsForPosition(
  userId:     string,
  instrument: string,
  accountId:  string,
): Promise<EventLogEntry<EventPayload>[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc(
    "read_events_for_reconstruction",
    {
      p_user_id:    userId,
      p_instrument: instrument,
      p_account_id: accountId,
    },
  );

  if (error) {
    throw new Error(
      `[db/eventLog] read_events_for_reconstruction failed: ${error.message}`,
    );
  }

  return ((data ?? []) as Record<string, unknown>[]).map(mapRowToEntry);
}

/**
 * Read ALL events for a user across all positions, sorted by event_sequence_id ASC.
 *
 * Used exclusively by the replay pathway.  Not for hot-path reconstruction.
 *
 * @returns All events for the user in strict event_sequence_id order.
 */
export async function readAllEventsForUser(
  userId: string,
): Promise<EventLogEntry<EventPayload>[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("event_log")
    .select("*")
    .eq("user_id", userId)
    .order("event_sequence_id", { ascending: true });

  if (error) {
    throw new Error(`[db/eventLog] readAllEventsForUser failed: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map(mapRowToEntry);
}

/**
 * Read events for a position since a given sequence ID (exclusive).
 * Used for incremental reconstruction — avoids re-reading already-processed events.
 *
 * @param sinceSequenceId  Last processed event_sequence_id (exclusive lower bound).
 */
export async function readEventsForPositionSince(
  userId:          string,
  instrument:      string,
  accountId:       string,
  sinceSequenceId: number,
): Promise<EventLogEntry<EventPayload>[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("event_log")
    .select("*")
    .eq("user_id",    userId)
    .eq("instrument", instrument)
    .eq("account_id", accountId)
    .gt("event_sequence_id", sinceSequenceId)
    .order("event_sequence_id", { ascending: true });

  if (error) {
    throw new Error(`[db/eventLog] readEventsForPositionSince failed: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map(mapRowToEntry);
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping
// ─────────────────────────────────────────────────────────────────────────────

function mapRowToEntry(row: Record<string, unknown>): EventLogEntry<EventPayload> {
  return {
    event_sequence_id: Number(row["event_sequence_id"]),
    id:                row["id"] as string,
    user_id:           row["user_id"] as string,
    broker:            row["broker"] as string,
    account_id:        row["account_id"] as string,
    instrument:        row["instrument"] as string,
    event_type:        row["event_type"] as EventLogEntry["event_type"],
    broker_event_hash: row["broker_event_hash"] as string,
    payload:           row["payload"] as EventPayload,
    raw_payload:       row["raw_payload"] as Record<string, unknown>,
    created_at:        row["created_at"] as string,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: build broker_event_hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the broker_event_hash dedup key.
 * Format: `${broker}:${accountId}:${brokerExecId}`
 *
 * This is the ONLY dedup mechanism in the event-sourced system.
 * It replaces the old `synthetic_id = ${accountId}:${brokerExecId}`.
 */
export function buildBrokerEventHash(
  broker:      string,
  accountId:   string,
  brokerExecId: string,
): string {
  return `${broker}:${accountId}:${brokerExecId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type: execution event payload builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an ExecutionEventPayload from normalised fill fields.
 * Keeps the mapping co-located with the DB layer, not scattered in ingest.
 */
export function buildExecutionPayload(fields: {
  brokerExecId: string;
  accountId:    string;
  symbol:       string;
  side:         "buy" | "sell";
  qty:          number;
  price:        number;
  timestamp:    string;
  orderId?:     string;
}): ExecutionEventPayload {
  return {
    broker_exec_id: fields.brokerExecId,
    account_id:     fields.accountId,
    symbol:         fields.symbol,
    side:           fields.side,
    qty:            fields.qty,
    price:          fields.price,
    fill_timestamp: fields.timestamp,
    order_id:       fields.orderId ?? null,
  };
}
