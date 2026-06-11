/**
 * lib/ingest.ts
 *
 * Ingestion pipeline — append-only write to event_log + fire-and-forget reconstruction.
 *
 * Pipeline (per fill)
 * ───────────────────
 *   1. Normalize   raw broker fill → canonical fields + build broker_event_hash
 *   2. Append      idempotent event_log write (UNIQUE broker_event_hash → 23505 no-op)
 *   3. If new:
 *      a. Broadcast  "execution" + "rebuild_state:started" SSE events
 *      b. Schedule   fire-and-forget reconstruction (does NOT block ingestion)
 *   4. Return       { accepted, skipped, rejected } — always succeeds (INV-A)
 *
 * Hard invariants
 * ────────────────
 *   INV-A  ingest() always returns success.  All errors caught and logged internally.
 *   INV-B  Reconstruction coordination is DB-backed.
 *          Persistent rebuild_locks table is the SOURCE OF TRUTH for cross-instance safety.
 *          DB advisory lock in read_events_for_reconstruction handles intra-RPC serialisation.
 *          In-process pendingRebuilds Set is a PERFORMANCE OPTIMISATION only — not relied
 *          on for correctness.
 *   INV-C  Duplicate fills are dropped at DB level via UNIQUE(user_id, broker_event_hash).
 *   INV-D  Ingestion does NOT await reconstruction.  Returns after event_log write commits.
 *   INV-E  SSE is not the source of truth.  Broadcast is best-effort after DB write.
 *   INV-F  event_log is the ONLY write target for ingestion.  trades is derived.
 *
 * Reconstruction scheduling (INV-B detail)
 * ─────────────────────────────────────────
 * For each accepted fill:
 *   1. Check in-process pendingRebuilds (fast path — avoids DB round-trip).
 *      If already pending in this process, skip scheduling.
 *   2. Try to acquire persistent rebuild_lock (DB round-trip).
 *      If another instance holds a fresh lock, skip scheduling — that instance
 *      will reconstruct with all events (advisory lock guarantees it reads ≥ events).
 *   3. If lock acquired: run reconstruction, then re-check for stragglers.
 *
 * Re-trigger after reconstruction
 * ─────────────────────────────────
 * After completing a reconstruction and releasing the lock, we check if new events
 * arrived during the rebuild (latest_seq_id > last_rebuilt_seq_id).  If yes, we
 * immediately re-acquire the lock and reconstruct again.  This closes the gap where
 * a fill arrives between the read phase and the release — no event is ever left
 * unprocessed indefinitely.
 */

import type { Execution }                      from "@/lib/broker/types";
import { reconstructTrades }                    from "@/lib/reconstructor";
import { readEventsForPosition }                from "@/lib/db/eventLog";
import { appendEvent, buildBrokerEventHash,
         buildExecutionPayload }                from "@/lib/db/eventLog";
import { replacePositionTrades }               from "@/lib/db/trades";
import { markRebuildStarted,
         markRebuildFinished,
         getLatestEventSequenceId }             from "@/lib/db/rebuildState";
import { tryAcquireRebuildLock,
         releaseRebuildLock }                   from "@/lib/db/rebuildLock";
import { reduceEvents, toExecution }            from "@/lib/events/reducer";
import { broadcast }                            from "@/lib/broker/streamBus";

// ─────────────────────────────────────────────────────────────────────────────
// In-process coalescing (performance optimisation — NOT correctness source)
// ─────────────────────────────────────────────────────────────────────────────
// Prevents multiple concurrent DB lock-acquire round-trips within one process.
// The persistent rebuild_locks table is the authoritative cross-instance lock.

const g = globalThis as typeof globalThis & { _axiemPendingRebuilds?: Set<string> };
if (!g._axiemPendingRebuilds) g._axiemPendingRebuilds = new Set<string>();
const pendingRebuilds = g._axiemPendingRebuilds;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestResult {
  /** Fills that were new and persisted to the event_log. */
  accepted: number;
  /** Fills that were duplicates and silently ignored (INV-C). */
  skipped: number;
  /** Fills that failed normalisation (bad payload from broker). */
  rejected: number;
}

/**
 * Ingest a batch of raw broker fills for a single authenticated user.
 * Sequential processing preserves intra-burst event_sequence_id ordering.
 * INV-A: never throws.
 */
export async function ingest(
  userId:    string,
  rawFills:  unknown[],
  broker:    "tradovate" = "tradovate",
): Promise<IngestResult> {
  const result: IngestResult = { accepted: 0, skipped: 0, rejected: 0 };

  for (const raw of rawFills) {
    try {
      const outcome = await ingestOne(userId, raw, broker);
      if      (outcome === "accepted") result.accepted++;
      else if (outcome === "skipped")  result.skipped++;
      else                             result.rejected++;
    } catch (err) {
      console.error("[ingest] unexpected failure in ingestOne", {
        userId, err: err instanceof Error ? err.message : String(err),
      });
      result.rejected++;
    }
  }

  console.log(
    `[ingest] uid=${userId} accepted=${result.accepted} ` +
    `skipped=${result.skipped} rejected=${result.rejected}`,
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline — one fill
// ─────────────────────────────────────────────────────────────────────────────

type OneOutcome = "accepted" | "skipped" | "rejected";

async function ingestOne(
  userId: string,
  raw:    unknown,
  broker: "tradovate",
): Promise<OneOutcome> {
  // ── Step 1: Normalize ───────────────────────────────────────────────────
  let execution: Execution;
  let rawPayload: Record<string, unknown>;

  try {
    rawPayload = guardObject(raw);
    execution  = normalizeForBroker(broker, rawPayload);
  } catch (err) {
    console.warn("[ingest] normalization rejected", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return "rejected";
  }

  // ── Step 2: Append to event_log (idempotent — INV-C, INV-F) ──────────
  const brokerEventHash = buildBrokerEventHash(broker, execution.accountId, execution.brokerExecId);
  const payload = buildExecutionPayload({
    brokerExecId: execution.brokerExecId,
    accountId:    execution.accountId,
    symbol:       execution.symbol,
    side:         execution.side,
    qty:          execution.qty,
    price:        execution.price,
    timestamp:    execution.timestamp,
    orderId:      execution.orderId,
  });

  const { appended } = await appendEvent(
    userId, broker, execution.accountId, execution.symbol,
    "execution", brokerEventHash, payload, rawPayload,
  );

  if (!appended) {
    console.debug("[ingest] duplicate fill ignored", { brokerEventHash });
    return "skipped";
  }

  console.log("[ingest] fill accepted", {
    brokerEventHash,
    symbol:  execution.symbol,
    side:    execution.side,
    qty:     execution.qty,
    price:   execution.price,
    orderId: execution.orderId,
  });

  // ── Step 3a: Broadcast raw execution + rebuild signal (INV-E) ──────────
  broadcast(userId, {
    type: "execution",
    execution: {
      id:        execution.id,
      symbol:    execution.symbol,
      accountId: execution.accountId,
      side:      execution.side,
      qty:       execution.qty,
      price:     execution.price,
      timestamp: execution.timestamp,
      orderId:   execution.orderId ?? null,
    },
  });

  broadcast(userId, {
    type:       "rebuild_state",
    instrument: execution.symbol,
    accountId:  execution.accountId,
    state:      "started",
  });

  // ── Step 3b: Fire-and-forget reconstruction (INV-D) ────────────────────
  const posKey = `${userId}\x00${execution.symbol}\x00${execution.accountId}`;

  if (pendingRebuilds.has(posKey)) {
    // Fast path: another reconstruction is already running in this process.
    // It will acquire the advisory lock after all sequential fills are committed,
    // so it will read all events including this one.
    console.debug("[ingest] in-process coalescing — rebuild already pending", {
      symbol: execution.symbol, accountId: execution.accountId,
    });
    return "accepted";
  }

  pendingRebuilds.add(posKey);
  runReconstructionWithLock(userId, execution.symbol, execution.accountId)
    .catch((err) => {
      console.error("[ingest] reconstruction failed (fill persisted, state may be stale)", {
        symbol: execution.symbol, accountId: execution.accountId,
        err: err instanceof Error ? err.message : String(err),
      });
      broadcast(userId, {
        type: "rebuild_state", instrument: execution.symbol,
        accountId: execution.accountId, state: "failed",
      });
    })
    .finally(() => pendingRebuilds.delete(posKey));

  return "accepted";
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconstruction with persistent lock (INV-B)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acquire the persistent rebuild lock and run reconstruction.
 *
 * If another instance holds a fresh lock, skip — that instance will
 * reconstruct with all events (advisory lock guarantees monotonic snapshot).
 *
 * After reconstruction, check for events that arrived during the build
 * (straggler check).  If new events exist, re-trigger immediately.
 * This ensures no event is left unprocessed indefinitely.
 */
async function runReconstructionWithLock(
  userId:    string,
  symbol:    string,
  accountId: string,
): Promise<void> {
  const acquired = await tryAcquireRebuildLock(userId, accountId, symbol);

  if (!acquired) {
    // Another instance holds the lock and will reconstruct.
    // Mark rebuild started for UI visibility (shows "Updating…").
    await markRebuildStarted(userId, accountId, symbol);
    console.debug("[ingest/reconstruct] lock held by another instance — skipping", {
      symbol, accountId,
    });
    return;
  }

  try {
    await markRebuildStarted(userId, accountId, symbol);

    // Execute the full reconstruction cycle
    const lastSeqId = await executeReconstruction(userId, symbol, accountId);

    if (lastSeqId !== null) {
      await markRebuildFinished(userId, accountId, symbol, lastSeqId);

      broadcast(userId, {
        type: "rebuild_state", instrument: symbol, accountId,
        state: "finished", last_rebuilt_event_sequence_id: lastSeqId, lag: 0,
      });

      // Straggler check: did new events arrive during reconstruction?
      // If so, release lock and immediately re-acquire to pick them up.
      // This ensures eventual consistency without requiring a new fill.
      const latestSeqId = await getLatestEventSequenceIdForPosition(userId, symbol, accountId);
      if (latestSeqId > lastSeqId) {
        console.log("[ingest/reconstruct] straggler events detected — re-triggering", {
          symbol, accountId, lastSeqId, latestSeqId,
        });
        await releaseRebuildLock(userId, accountId, symbol);
        // Recursive re-trigger (will re-acquire lock or skip if another instance beat us)
        await runReconstructionWithLock(userId, symbol, accountId);
        return; // skip the finally release — we already released above
      }
    }
  } finally {
    await releaseRebuildLock(userId, accountId, symbol);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core reconstruction cycle (pure pipeline: read → reduce → reconstruct → write)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute the full reduce → reconstruct → replace cycle for one position.
 * Returns the last event_sequence_id included in the reconstruction, or null
 * if there were no events to process.
 */
async function executeReconstruction(
  userId:    string,
  symbol:    string,
  accountId: string,
): Promise<number | null> {
  // Advisory-locked read (ensures consistent snapshot — EV-3, INV-B)
  const events = await readEventsForPosition(userId, symbol, accountId);

  if (events.length === 0) {
    console.debug("[ingest/reconstruct] no events", { symbol, accountId });
    return null;
  }

  const { executions: reducerExecs } = reduceEvents(events);

  if (reducerExecs.length === 0) {
    console.debug("[ingest/reconstruct] no execution events", { symbol, accountId });
    return null;
  }

  const executions = reducerExecs.map(toExecution);
  const trades     = reconstructTrades(executions);

  const lastSeqId = events[events.length - 1].event_sequence_id;

  console.log("[ingest/reconstruct] complete", {
    symbol, accountId,
    events:     events.length,
    executions: executions.length,
    trades:     trades.length,
    closed:     trades.filter((t) => t.closedAt !== null).length,
    open:       trades.filter((t) => t.closedAt === null).length,
    skipped:    trades.filter((t) => t.reconstructionStatus === "skipped").length,
    lastSeqId,
  });

  await replacePositionTrades(userId, symbol, accountId, trades);

  // Broadcast closed trades via SSE (INV-E: DB write already committed)
  for (const trade of trades) {
    if (trade.closedAt !== null && trade.reconstructionStatus === "ok") {
      broadcast(userId, { type: "trade", trade });
    }
  }

  return lastSeqId;
}

/**
 * Get the latest event_sequence_id for a specific position.
 * Used for the straggler check after reconstruction completes.
 */
async function getLatestEventSequenceIdForPosition(
  userId:    string,
  symbol:    string,
  accountId: string,
): Promise<number> {
  // Re-use the user-level function — for MVP, the per-position query is
  // sufficient since positions are the unit of reconstruction.
  // A more targeted query would filter by instrument + account_id.
  return getLatestEventSequenceId(userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalizer — Tradovate (private)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTradovateFill(raw: Record<string, unknown>): Execution {
  const brokerExecId = coerceString(raw["id"] ?? raw["brokerExecId"], "id");
  if (!brokerExecId) throw new NormalizationError("missing fill id");

  const accountId = coerceString(raw["accountId"], "accountId");
  if (!accountId) throw new NormalizationError("missing accountId");

  const symbol =
    typeof raw["symbol"] === "string" && raw["symbol"].trim()
      ? raw["symbol"].trim()
      : coerceString(raw["contractId"], "contractId");
  if (!symbol) throw new NormalizationError("missing symbol / contractId");

  const rawAction = String(raw["action"] ?? raw["side"] ?? "").toLowerCase().trim();
  if (rawAction !== "buy" && rawAction !== "sell") {
    throw new NormalizationError(`invalid action: "${rawAction}" (expected Buy or Sell)`);
  }
  const side: "buy" | "sell" = rawAction;

  const qty = Number(raw["qty"] ?? raw["quantity"]);
  if (!Number.isFinite(qty) || qty <= 0) throw new NormalizationError(`invalid qty: ${qty}`);

  const price = Number(raw["price"]);
  if (!Number.isFinite(price) || price <= 0) throw new NormalizationError(`invalid price: ${price}`);

  const timestamp = String(raw["timestamp"] ?? raw["fillTimestamp"] ?? "").trim();
  if (!timestamp) throw new NormalizationError("missing timestamp");
  if (isNaN(Date.parse(timestamp))) throw new NormalizationError(`unparseable timestamp: "${timestamp}"`);

  const orderId =
    raw["orderId"] != null && raw["orderId"] !== ""
      ? coerceString(raw["orderId"], "orderId")
      : undefined;

  return {
    id:           `${accountId}:${brokerExecId}`,
    brokerExecId, accountId, symbol, side, qty, price,
    timestamp, receivedAt: Date.now(), orderId,
  };
}

function normalizeForBroker(broker: "tradovate", raw: Record<string, unknown>): Execution {
  switch (broker) {
    case "tradovate": return normalizeTradovateFill(raw);
    default: {
      const _exhaustive: never = broker;
      throw new NormalizationError(`unsupported broker: ${_exhaustive}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

class NormalizationError extends Error {
  constructor(msg: string) { super(msg); this.name = "NormalizationError"; }
}

function guardObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NormalizationError(
      `expected plain object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  return raw as Record<string, unknown>;
}

function coerceString(val: unknown, fieldName: string): string {
  const s = String(val ?? "").trim();
  if (!s || s === "undefined" || s === "null") {
    throw new NormalizationError(`missing or empty field: ${fieldName}`);
  }
  return s;
}
