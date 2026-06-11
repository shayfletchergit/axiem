/**
 * lib/events/types.ts
 *
 * Canonical types for the Axiem event log — the ONLY source of truth.
 *
 * Architecture invariants
 * ───────────────────────
 *   EV-1  Every state-changing action in the system is first written as an event.
 *   EV-2  Events are immutable once written.  No UPDATE on event_log — ever.
 *   EV-3  event_sequence_id is the SOLE ordering dimension.
 *         fill_timestamp (broker clock) is payload metadata, never an ordering key.
 *   EV-4  broker_event_hash is the ONLY deduplication mechanism.
 *         Format: `${broker}:${accountId}:${brokerExecId}`
 *   EV-5  All derived state (orders, positions, trades, behavior) is regenerable
 *         by replaying events in event_sequence_id order.
 *
 * Adding new event types
 * ──────────────────────
 * 1. Add a literal to EventType.
 * 2. Add a payload interface named `${PascalCase}EventPayload`.
 * 3. Add the payload to the EventPayload discriminated union.
 * 4. The reducer will fail a TypeScript exhaustiveness check until the new type
 *    is handled — this is intentional.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Event types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All event types the system recognises.
 * "execution" is the only type for MVP.
 * "correction" and "position_reset" are placeholders for future use.
 */
export type EventType =
  | "execution"         // A broker fill was received and persisted
  | "correction"        // A fill was corrected by the broker (future)
  | "position_reset";   // Manual position reset (future)

// ─────────────────────────────────────────────────────────────────────────────
// Per-type payload interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload for event_type = "execution".
 *
 * Contains the fully normalised fill fields — no broker-specific field names.
 * The raw broker object is stored in EventLogEntry.raw_payload, not here.
 *
 * fill_timestamp is stored as a payload field (broker clock metadata).
 * It is NOT used for ordering — event_sequence_id is.
 */
export interface ExecutionEventPayload {
  broker_exec_id:  string;     // broker's fill ID
  account_id:      string;     // broker account ID
  symbol:          string;     // resolved instrument symbol (e.g. "ESM5") or contractId
  side:            "buy" | "sell";
  qty:             number;     // fill quantity (> 0)
  price:           number;     // fill price (> 0)
  fill_timestamp:  string;     // ISO — broker clock; metadata only, not ordering key
  order_id:        string | null;  // parent order ID; null = synthetic order
}

export interface CorrectionEventPayload {
  original_event_sequence_id: number;
  corrected_fields:           Record<string, unknown>;
  reason:                     string;
}

export interface PositionResetEventPayload {
  account_id:  string;
  instrument:  string;
  reason:      string;
}

/** Discriminated union of all known event payloads. */
export type EventPayload =
  | ExecutionEventPayload
  | CorrectionEventPayload
  | PositionResetEventPayload;

// ─────────────────────────────────────────────────────────────────────────────
// Core log entry type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single row from the event_log table.
 *
 * event_sequence_id is assigned by the DB (BIGINT GENERATED ALWAYS AS IDENTITY)
 * and is the canonical ordering key for all downstream processing.
 *
 * raw_payload holds the unmodified broker object for audit / schema recovery.
 */
export interface EventLogEntry<P extends EventPayload = EventPayload> {
  /**
   * DB-assigned strictly-monotonic sequence number.
   * The sole ordering key for reconstruction and replay.
   */
  event_sequence_id: number;

  /** DB UUID primary key. */
  id:                string;
  user_id:           string;
  broker:            string;    // "tradovate" for MVP
  account_id:        string;
  instrument:        string;    // canonical symbol
  event_type:        EventType;

  /**
   * Dedup key: `${broker}:${accountId}:${brokerExecId}`.
   * UNIQUE(user_id, broker_event_hash) in the DB.
   * The ONLY mechanism for detecting duplicate fills.
   */
  broker_event_hash: string;

  /** Normalised, typed event data. */
  payload:           P;

  /** Original broker object, verbatim. Never modified. */
  raw_payload:       Record<string, unknown>;

  /** Wall-clock time this row was written to the DB. */
  created_at:        string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guards
// ─────────────────────────────────────────────────────────────────────────────

export function isExecutionEvent(
  entry: EventLogEntry,
): entry is EventLogEntry<ExecutionEventPayload> {
  return entry.event_type === "execution";
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer output types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete derived state produced by replaying a sequence of events.
 *
 * All fields are regenerable from the event_log alone.
 * The reducer is pure — same events in, same state out.
 */
export interface ReducerOutput {
  /**
   * Executions in event_sequence_id order.
   * Each event produces exactly one Execution (for "execution" events).
   */
  executions: ReducerExecution[];
}

/**
 * A normalised execution derived from an EventLogEntry<ExecutionEventPayload>.
 * Maps directly to the Execution interface used by reconstructTrades().
 */
export interface ReducerExecution {
  /** event_sequence_id — ordering key for the reconstructor (replaces timestamp sort). */
  sequenceId:   number;
  /** `${accountId}:${brokerExecId}` — stable identity key. */
  id:           string;
  brokerExecId: string;
  accountId:    string;
  symbol:       string;
  side:         "buy" | "sell";
  qty:          number;
  price:        number;
  /** ISO broker timestamp — metadata only. Reconstructor uses sequenceId for order. */
  timestamp:    string;
  receivedAt:   number;
  orderId:      string | undefined;
}
