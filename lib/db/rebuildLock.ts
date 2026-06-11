/**
 * lib/db/rebuildLock.ts
 *
 * Persistent rebuild lock — cross-instance reconstruction coordination.
 *
 * This module is the DB interface for the rebuild_locks table (migration 008).
 *
 * Why persistent locks?
 * ──────────────────────
 * The in-process pendingRebuilds Set in ingest.ts handles burst coalescing
 * within a single process.  It is invisible to other server instances and
 * evaporates on restart.  Under multi-instance deployment (e.g. Vercel with
 * multiple serverless instances), two instances can both schedule reconstruction
 * for the same position simultaneously.
 *
 * The DB advisory lock in read_events_for_reconstruction handles CORRECTNESS —
 * the second reconstruction always reads ≥ events than the first and converges
 * to the right state.  But it wastes CPU and DB connections.
 *
 * rebuild_locks adds:
 *   1. Persistent "running" state visible to all instances.
 *   2. Stale lock auto-recovery (crash mid-reconstruction → lock auto-releases).
 *   3. Observable state for the health endpoint.
 *
 * Lock lifecycle
 * ──────────────
 *   tryAcquireRebuildLock  → returns true if acquired, false if held by another
 *   releaseRebuildLock     → sets status = idle
 *   heartbeatRebuildLock   → updates updated_at (prevents stale detection for long runs)
 *
 * Stale detection
 * ────────────────
 * A lock is stale if status = 'running' AND now() - updated_at > STALE_THRESHOLD_MS.
 * tryAcquireRebuildLock auto-releases stale locks and re-acquires in one atomic UPDATE.
 * The health endpoint surfaces stale locks as errors.
 *
 * Required schema: supabase/migrations/008_rebuild_locks.sql
 */

import { createServiceClient } from "@/lib/supabase/server";

/** A stale lock is one that has been 'running' for longer than this. */
export const REBUILD_LOCK_STALE_SECS = 120;  // 2 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Lock acquisition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to acquire the rebuild lock for a position.
 *
 * Non-blocking: returns immediately with true (acquired) or false (held).
 * Auto-releases stale locks (running > REBUILD_LOCK_STALE_SECS).
 *
 * Returns false if another instance holds a fresh (non-stale) lock.
 * The caller should not schedule reconstruction in that case — the holding
 * instance will reconstruct with all events (advisory lock ensures this).
 */
export async function tryAcquireRebuildLock(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<boolean> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc("try_acquire_rebuild_lock", {
    p_user_id:    userId,
    p_account_id: accountId,
    p_instrument: instrument,
    p_stale_secs: REBUILD_LOCK_STALE_SECS,
  });

  if (error) {
    // Lock acquisition failure is non-fatal from correctness perspective:
    // the advisory lock inside read_events_for_reconstruction still serialises.
    // Log and return false — better to skip than to crash ingestion (INV-A).
    console.warn("[rebuildLock] tryAcquire failed (non-fatal)", {
      userId, accountId, instrument,
      error: error.message,
    });
    return false;
  }

  return data === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lock release
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Release the rebuild lock for a position.
 * Always called in a finally block — must not throw.
 */
export async function releaseRebuildLock(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<void> {
  const supabase = createServiceClient();

  const { error } = await supabase.rpc("release_rebuild_lock", {
    p_user_id:    userId,
    p_account_id: accountId,
    p_instrument: instrument,
  });

  if (error) {
    // Non-fatal: the stale timeout will eventually auto-release.
    console.warn("[rebuildLock] release failed (non-fatal, will auto-expire)", {
      userId, accountId, instrument,
      error: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat (for long-running replay operations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the lock's updated_at timestamp to prevent stale detection.
 * Call this periodically during long replay operations (every 30 seconds).
 * Not needed for normal reconstruction (typically < 1 second).
 */
export async function heartbeatRebuildLock(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<void> {
  const supabase = createServiceClient();

  const { error } = await supabase.rpc("heartbeat_rebuild_lock", {
    p_user_id:    userId,
    p_account_id: accountId,
    p_instrument: instrument,
  });

  if (error) {
    console.warn("[rebuildLock] heartbeat failed (non-fatal)", {
      userId, accountId, instrument,
      error: error.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update replay heartbeat in position_rebuild_state.
 * Call every 30 seconds during large replay operations to prevent stale detection.
 */
export async function heartbeatReplay(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<void> {
  const supabase = createServiceClient();

  const { error } = await supabase.rpc("heartbeat_replay", {
    p_user_id:    userId,
    p_account_id: accountId,
    p_instrument: instrument,
  });

  if (error) {
    console.warn("[rebuildLock] heartbeatReplay failed (non-fatal)", {
      userId, accountId, instrument,
      error: error.message,
    });
  }
}
