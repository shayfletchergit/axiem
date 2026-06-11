/**
 * lib/replay.ts
 *
 * Full event-log replay — regenerates all derived trades from scratch.
 *
 * Safety guarantees
 * ─────────────────
 *   REPLAY-1  Idempotent: running replay twice produces identical trades.
 *             (Same events → same reconstructor output → same trades.)
 *
 *   REPLAY-2  Cannot silently overwrite active state without visible flag.
 *             replay_status = 'running' is set in position_rebuild_state
 *             before any write, and cleared (→ 'completed') only after the
 *             write succeeds.  If replay is interrupted (process crash),
 *             replay_status remains 'running' until the heartbeat timer
 *             expires (> 2 min), at which point the health endpoint surfaces
 *             it as is_replay_stuck = true and the UI shows
 *             "Replay interrupted — recovering".
 *
 *   REPLAY-3  Recovery from interruption: call replayPosition() again.
 *             It re-acquires the rebuild lock, re-clears the old state, and
 *             re-generates trades from event_log.  The event_log is immutable
 *             — replay always converges to the correct state.
 *
 *   REPLAY-4  Concurrent-safe with live ingestion.
 *             Ingestion continues appending events during replay.
 *             After replay finishes, the next ingested fill triggers a normal
 *             reconstruction cycle that picks up the new events.
 *             The UI shows replay_status = 'running' for the duration —
 *             no silent inconsistency window.
 *
 *   REPLAY-5  Cannot run concurrently for the same position.
 *             (a) Persistent rebuild lock (rebuild_locks table) prevents a
 *                 second instance from acquiring replay for the same position.
 *             (b) DB advisory lock in read_events_for_reconstruction serialises
 *                 concurrent replay + reconstruction at the read phase.
 *             The two layers are complementary: the persistent lock is
 *             observable and stale-recoverable; the advisory lock is
 *             in-transaction and low-latency.
 *
 *   REPLAY-6  Heartbeat prevents false stale detection.
 *             A setInterval fires every 30 seconds during replay, calling:
 *               heartbeatRebuildLock — keeps rebuild_locks.updated_at fresh
 *               heartbeatReplay      — keeps replay_heartbeat_at fresh
 *             Without this, a replay that runs longer than 2 minutes would be
 *             mis-classified as stuck by the health endpoint.
 *
 * What replay does NOT do
 * ─────────────────────────
 *   - Does NOT modify or delete event_log rows (source of truth is immutable).
 *   - Does NOT re-send SSE events to clients (silent DB-only operation).
 *   - Does NOT affect other users' data.
 *   - Does NOT pause ingestion (advisory lock serialises at read phase only).
 */

import { createServiceClient }          from "@/lib/supabase/server";
import { readEventsForPosition,
         readAllEventsForUser }          from "@/lib/db/eventLog";
import { replacePositionTrades }        from "@/lib/db/trades";
import { markReplayStarted,
         markReplayFinished,
         markReplayFailed }             from "@/lib/db/rebuildState";
import { tryAcquireRebuildLock,
         releaseRebuildLock,
         heartbeatRebuildLock,
         heartbeatReplay }              from "@/lib/db/rebuildLock";
import { reduceEvents, toExecution }    from "@/lib/events/reducer";
import { reconstructTrades }             from "@/lib/reconstructor";

/** Heartbeat interval for long-running replays (ms). */
const REPLAY_HEARTBEAT_INTERVAL_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayPositionResult {
  userId:      string;
  instrument:  string;
  accountId:   string;
  eventsRead:  number;
  tradesWrote: number;
  durationMs:  number;
}

export interface ReplayAllResult {
  userId:       string;
  positions:    ReplayPositionResult[];
  totalEvents:  number;
  totalTrades:  number;
  durationMs:   number;
  errors:       Array<{ instrument: string; accountId: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay one position
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replay a single position: clear its trades, re-reduce events, re-reconstruct.
 *
 * Steps:
 *   0. Acquire persistent rebuild lock (REPLAY-5, Blocker 2).
 *      Throws immediately if another instance holds a fresh lock — retry later.
 *   1. Mark replay_status = 'running' in position_rebuild_state (REPLAY-2).
 *   2. Start heartbeat interval — prevents stale detection for long replays (REPLAY-6).
 *   3. Delete derived trades via replay_position RPC.
 *   4. Read all events via advisory-locked RPC (REPLAY-5).
 *   5. Reduce events → executions.
 *   6. Reconstruct trades (pure, deterministic — REPLAY-1).
 *   7. Write trades atomically.
 *   8. Mark replay_status = 'completed', record last_rebuilt_event_sequence_id.
 *   9. Stop heartbeat interval, release rebuild lock.
 *
 * On failure:
 *   - catch: calls markReplayFailed (replay_status = 'failed'), re-throws.
 *   - finally: clears heartbeat timer, releases rebuild lock.
 *   - Health endpoint surfaces 'failed' as "Replay interrupted — recovering".
 *   - Recovery: call replayPosition() again (REPLAY-3).
 *
 * @throws If lock cannot be acquired (another instance is active).
 * @throws If any step fails — callers should catch and surface to operators.
 */
export async function replayPosition(
  userId:     string,
  instrument: string,
  accountId:  string,
): Promise<ReplayPositionResult> {
  const t0 = Date.now();

  // ── Step 0: Acquire persistent rebuild lock ───────────────────────────────
  // Non-blocking: if another instance holds a fresh lock, fail immediately.
  // The holding instance will complete reconstruction with all events
  // (advisory lock in read_events_for_reconstruction ensures this).
  const acquired = await tryAcquireRebuildLock(userId, accountId, instrument);
  if (!acquired) {
    throw new Error(
      `[replay] rebuild lock held by another instance — ` +
      `${instrument}@${accountId}. Retry after current reconstruction completes.`,
    );
  }

  // ── Step 2 (pre-work): Start heartbeat interval ───────────────────────────
  // Fires every 30s to prevent stale detection while replay is running.
  // Calls both heartbeat functions:
  //   heartbeatRebuildLock → keeps rebuild_locks.updated_at fresh
  //   heartbeatReplay      → keeps replay_heartbeat_at fresh (is_replay_stuck guard)
  const heartbeatInterval = setInterval(() => {
    void heartbeatRebuildLock(userId, accountId, instrument);
    void heartbeatReplay(userId, accountId, instrument);
  }, REPLAY_HEARTBEAT_INTERVAL_MS);

  try {
    // ── Step 1: Flag replay in progress ─────────────────────────────────────
    // Sets replay_status = 'running', replay_in_progress = true, replay_started_at = now.
    await markReplayStarted(userId, accountId, instrument);

    // ── Step 3: Clear derived trades ─────────────────────────────────────────
    await clearPositionTrades(userId, instrument, accountId);

    // ── Step 4: Read event log ────────────────────────────────────────────────
    // Advisory-locked RPC: ORDER BY event_sequence_id ASC.
    // Serialised with concurrent reconstruction for same position (REPLAY-5).
    const events = await readEventsForPosition(userId, instrument, accountId);

    if (events.length === 0) {
      console.log("[replay] no events — position is clean", { userId, instrument, accountId });
      await markReplayFinished(userId, accountId, instrument, 0);
      return {
        userId, instrument, accountId,
        eventsRead:  0,
        tradesWrote: 0,
        durationMs:  Date.now() - t0,
      };
    }

    // ── Step 5: Reduce events → ReducerExecutions ─────────────────────────────
    const { executions: reducerExecs } = reduceEvents(events);

    // ── Step 6: Reconstruct trades (pure, deterministic) ─────────────────────
    const executions = reducerExecs.map(toExecution);
    const trades     = reconstructTrades(executions);

    // ── Step 7: Atomically write trades ───────────────────────────────────────
    await replacePositionTrades(userId, instrument, accountId, trades);

    const lastSeqId = events[events.length - 1].event_sequence_id;

    // ── Step 8: Mark complete ─────────────────────────────────────────────────
    // Sets replay_status = 'completed', replay_in_progress = false,
    // last_rebuilt_event_sequence_id = lastSeqId.
    await markReplayFinished(userId, accountId, instrument, lastSeqId);

    const result: ReplayPositionResult = {
      userId, instrument, accountId,
      eventsRead:  events.length,
      tradesWrote: trades.length,
      durationMs:  Date.now() - t0,
    };

    console.log("[replay] position complete", result);
    return result;

  } catch (err) {
    // ── Failure path ──────────────────────────────────────────────────────────
    // Set replay_status = 'failed' so health endpoint surfaces it as
    // "Replay interrupted — recovering".  Retry = call replayPosition() again.
    await markReplayFailed(userId, accountId, instrument);
    console.error("[replay] position failed — replay_status = failed", {
      userId, instrument, accountId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;

  } finally {
    // ── Step 9: Cleanup (always runs) ─────────────────────────────────────────
    clearInterval(heartbeatInterval);
    // Release persistent rebuild lock.
    // Non-fatal if this fails — stale timeout (120s) will auto-release.
    await releaseRebuildLock(userId, accountId, instrument);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay all positions for a user
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replay all positions for a user.
 *
 * Discovers all unique (instrument, account_id) pairs from the event_log,
 * then replays each sequentially (not in parallel — avoids DB lock contention
 * and makes failure attribution clear).
 *
 * Each position acquires its own rebuild lock via replayPosition().
 * If a lock cannot be acquired for a position (another instance active),
 * that position's error is recorded and replay continues for the remaining
 * positions.
 *
 * Failures for individual positions are caught and recorded — they do not
 * abort the replay of other positions.
 *
 * CAUTION: expensive for large event logs.  Use during maintenance windows
 * or in response to operator-triggered schema migrations.
 */
export async function replayAllForUser(userId: string): Promise<ReplayAllResult> {
  const t0 = Date.now();
  console.log("[replay] starting full replay for user", { userId });

  const allEvents = await readAllEventsForUser(userId);

  if (allEvents.length === 0) {
    console.log("[replay] no events found for user", { userId });
    return {
      userId, positions: [], totalEvents: 0, totalTrades: 0,
      durationMs: Date.now() - t0, errors: [],
    };
  }

  // Discover unique (instrument, account_id) pairs
  const positionSet = new Map<string, { instrument: string; accountId: string }>();
  for (const event of allEvents) {
    const key = `${event.instrument}\x00${event.account_id}`;
    if (!positionSet.has(key)) {
      positionSet.set(key, { instrument: event.instrument, accountId: event.account_id });
    }
  }

  const positions = Array.from(positionSet.values());
  const results:  ReplayPositionResult[] = [];
  const errors:   Array<{ instrument: string; accountId: string; error: string }> = [];

  console.log("[replay] discovered positions", {
    userId,
    count:     positions.length,
    positions: positions.map((p) => `${p.instrument}@${p.accountId}`),
  });

  for (const { instrument, accountId } of positions) {
    try {
      const posResult = await replayPosition(userId, instrument, accountId);
      results.push(posResult);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[replay] position failed", { userId, instrument, accountId, error: errorMsg });
      errors.push({ instrument, accountId, error: errorMsg });
    }
  }

  const summary: ReplayAllResult = {
    userId,
    positions:   results,
    totalEvents: results.reduce((s, r) => s + r.eventsRead, 0),
    totalTrades: results.reduce((s, r) => s + r.tradesWrote, 0),
    durationMs:  Date.now() - t0,
    errors,
  };

  console.log("[replay] full replay complete", {
    userId,
    positions:   results.length,
    failed:      errors.length,
    totalEvents: summary.totalEvents,
    totalTrades: summary.totalTrades,
    durationMs:  summary.durationMs,
  });

  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function clearPositionTrades(
  userId:     string,
  instrument: string,
  accountId:  string,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("replay_position", {
    p_user_id:    userId,
    p_instrument: instrument,
    p_account_id: accountId,
  });
  if (error) {
    throw new Error(`[replay] replay_position RPC failed: ${error.message}`);
  }
}
