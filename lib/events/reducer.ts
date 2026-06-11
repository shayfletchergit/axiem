/**
 * lib/events/reducer.ts
 *
 * Pure event reducer — transforms an ordered sequence of EventLogEntry records
 * into fully derived state.
 *
 * Design constraints
 * ──────────────────
 *   PURE-1  No I/O.  No DB calls.  No side effects.  Deterministic.
 *   PURE-2  Input MUST be sorted by event_sequence_id ASC.
 *           The function never re-sorts — unsorted input is incorrect input.
 *   PURE-3  Unknown event types are logged and skipped, not thrown.
 *           This makes the reducer forward-compatible with new event types.
 *   PURE-4  The reducer does NOT reconstruct trades.
 *           Its output (ReducerOutput.executions) feeds reconstructTrades()
 *           in a separate pipeline step.
 *
 * Two-step pipeline
 * ─────────────────
 *   1. reduceEvents(events)         → ReducerOutput   (this file)
 *   2. reconstructTrades(executions) → ReconstructedTrade[]  (lib/reconstructor.ts)
 *
 * The separation keeps the reducer focused on "what happened" and the
 * reconstructor focused on "what trades resulted".
 */

import type {
  EventLogEntry,
  EventPayload,
  ExecutionEventPayload,
  ReducerOutput,
  ReducerExecution,
} from "./types";
import { isExecutionEvent } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce an ordered sequence of events into derived state.
 *
 * @param events  EventLogEntry rows sorted by event_sequence_id ASC.
 *                The caller (lib/db/eventLog.ts) guarantees this ordering.
 * @returns ReducerOutput containing executions ready for reconstructTrades().
 *
 * Idempotent: calling with the same events always produces identical output.
 * Safe to call with an empty array — returns { executions: [] }.
 */
export function reduceEvents(
  events: EventLogEntry<EventPayload>[],
): ReducerOutput {
  const executions: ReducerExecution[] = [];

  for (const entry of events) {
    switch (entry.event_type) {
      case "execution":
        if (isExecutionEvent(entry)) {
          const exec = mapExecutionEvent(entry as EventLogEntry<ExecutionEventPayload>);
          executions.push(exec);
        }
        break;

      case "correction":
        // TODO: apply field-level correction to the referenced execution.
        // For MVP, corrections are appended to the log but not yet processed.
        console.debug("[reducer] correction event received — not yet implemented", {
          event_sequence_id: entry.event_sequence_id,
        });
        break;

      case "position_reset":
        // TODO: clear accumulated executions for the affected (account, instrument).
        console.debug("[reducer] position_reset event received — not yet implemented", {
          event_sequence_id: entry.event_sequence_id,
        });
        break;

      default: {
        // TypeScript exhaustiveness check — if EventType grows, this will error.
        const _exhaustive: never = entry.event_type;
        console.warn("[reducer] unknown event_type — skipped", {
          event_type: _exhaustive,
          event_sequence_id: entry.event_sequence_id,
        });
      }
    }
  }

  return { executions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event → ReducerExecution mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a single execution event to a ReducerExecution.
 *
 * The key ordering contract:
 *   - sequenceId = event_sequence_id (DB-assigned, strictly monotonic)
 *   - This becomes the sort key for reconstructTrades() via the Execution.id
 *     ordering contract.  The reconstructor does NOT re-sort by timestamp.
 */
function mapExecutionEvent(
  entry: EventLogEntry<ExecutionEventPayload>,
): ReducerExecution {
  const p = entry.payload;
  return {
    sequenceId:   entry.event_sequence_id,
    id:           `${p.account_id}:${p.broker_exec_id}`,  // stable identity
    brokerExecId: p.broker_exec_id,
    accountId:    p.account_id,
    symbol:       p.symbol,
    side:         p.side,
    qty:          p.qty,
    price:        p.price,
    timestamp:    p.fill_timestamp,     // metadata; ordering uses sequenceId
    receivedAt:   Date.now(),           // approx wall-clock for this reduction pass
    orderId:      p.order_id ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter: ReducerExecution → lib/broker/types Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert ReducerExecution to the Execution interface expected by reconstructTrades().
 *
 * The reconstructor currently uses the Execution type from lib/broker/types.ts.
 * This adapter decouples the event model from the reconstructor's input contract.
 *
 * sequenceId is intentionally NOT included in the Execution type (it's a broker
 * type, not an event-sourcing concept) — the caller must ensure executions are
 * passed to reconstructTrades() in sequenceId order, which is guaranteed by
 * the DB read ORDER BY event_sequence_id ASC.
 */
export function toExecution(re: ReducerExecution): import("../broker/types").Execution {
  return {
    id:           re.id,
    brokerExecId: re.brokerExecId,
    accountId:    re.accountId,
    symbol:       re.symbol,
    side:         re.side,
    qty:          re.qty,
    price:        re.price,
    timestamp:    re.timestamp,
    receivedAt:   re.receivedAt,
    orderId:      re.orderId,
    // Propagate event_sequence_id as the canonical ordering key (EV-3).
    // The reconstructor uses this for order-level sort when present.
    sequenceId:   re.sequenceId,
  };
}
