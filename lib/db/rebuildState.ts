/**
 * lib/db/rebuildState.ts
 *
 * DB operations for reconstruction freshness tracking (position_rebuild_state).
 *
 * This module is the single source of truth for:
 *   - Recording when a rebuild started/finished and what event it covered.
 *   - Flagging replay in-progress so the UI can show appropriate state.
 *   - Health query aggregation (lag, stale detection).
 *
 * All writes use SECURITY DEFINER RPCs — the ingest pipeline and replay
 * pathway call these via the service client, bypassing RLS.
 *
 * Required schema: supabase/migrations/007_observability.sql
 */

import { createServiceClient } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RebuildStateRow {
  user_id:                         string;
  account_id:                      string;
  instrument:                      string;
  last_rebuilt_event_sequence_id:  number | null;
  rebuild_started_at:              string | null;
  rebuild_finished_at:             string | null;
  rebuild_count:                   number;
  replay_in_progress:              boolean;
  replay_started_at:               string | null;
  created_at:                      string;
  updated_at:                      string;
}

export interface PositionHealthRow {
  instrument:                      string;
  account_id:                      string;
  latest_event_sequence_id:        number;
  last_rebuilt_event_sequence_id:  number | null;
  /** event_sequence_id gap: latest minus last_rebuilt.  0 = current, >0 = stale. */
  lag:                             number;
  rebuild_started_at:              string | null;
  rebuild_finished_at:             string | null;
  rebuild_count:                   number;
  replay_in_progress:              boolean;
  /** 'running' | 'completed' | 'stale' | 'failed' — from migration 008. */
  replay_status:                   string;
  replay_heartbeat_at:             string | null;
  /** True when lag > 0 — UI should show "Updating trades…". */
  is_stale:                        boolean;
  /** True when replay_status = 'running' AND heartbeat is >2 min old. */
  is_replay_stuck:                 boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rebuild lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark that a reconstruction cycle has started for a position.
 *
 * Sets rebuild_started_at, clears rebuild_finished_at.
 * The UI interprets finished_at = NULL as "rebuild in progress".
 *
 * Call before acquiring the advisory lock (i.e. before readEventsForPosition).
 * This means the UI shows "Updating…" as soon as a fill is accepted, not
 * after the heavy work finishes.
 */
export async function markRebuildStarted(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("mark_rebuild_started", {
    p_user_id:    userId,
    p_account_id: accountId,
    p_instrument: instrument,
  });
  if (error) {
    // Non-fatal: observability failure must not block ingestion.
    console.warn("[rebuildState] markRebuildStarted failed (non-fatal)", { error: error.message });
  }
}

/**
 * Mark that a reconstruction cycle completed successfully.
 *
 * Records the highest event_sequence_id that was included in this rebuild.
 * This is used to compute lag = latest_in_log - last_rebuilt.
 *
 * @param lastRebuiltSeqId  MAX(event_sequence_id) from the events read in this cycle.
 */
export async function markRebuildFinished(
  userId:           string,
  accountId:        string,
  instrument:       string,
  lastRebuiltSeqId: number,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("mark_rebuild_finished", {
    p_user_id:                        userId,
    p_account_id:                     accountId,
    p_instrument:                     instrument,
    p_last_rebuilt_event_sequence_id: lastRebuiltSeqId,
  });
  if (error) {
    console.warn("[rebuildState] markRebuildFinished failed (non-fatal)", { error: error.message });
  }
}

/**
 * Mark that a full replay has started for a position.
 *
 * Sets replay_in_progress = true, replay_started_at = now.
 * The UI must show a distinct "Replaying…" state while this is true.
 */
export async function markReplayStarted(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("mark_replay_started", {
    p_user_id:    userId,
    p_account_id: accountId,
    p_instrument: instrument,
  });
  if (error) {
    console.warn("[rebuildState] markReplayStarted failed (non-fatal)", { error: error.message });
  }
}

/**
 * Mark that a full replay has failed with an unrecoverable error.
 *
 * Sets replay_status = 'failed', clears replay_in_progress.
 * The health endpoint will surface this as "Replay interrupted — recovering".
 * Recovery: call replayPosition() again (idempotent).
 *
 * Non-fatal: always call in a catch block alongside re-throwing the error.
 */
export async function markReplayFailed(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("mark_replay_failed", {
    p_user_id:    userId,
    p_account_id: accountId,
    p_instrument: instrument,
  });
  if (error) {
    // Still non-fatal — health endpoint will eventually detect stuck state via heartbeat timeout.
    console.warn("[rebuildState] markReplayFailed failed (non-fatal)", { error: error.message });
  }
}

/**
 * Mark that a full replay has completed.
 *
 * Clears replay_in_progress, sets last_rebuilt_event_sequence_id,
 * sets replay_status = 'completed'.
 */
export async function markReplayFinished(
  userId:           string,
  accountId:        string,
  instrument:       string,
  lastRebuiltSeqId: number,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("mark_replay_finished", {
    p_user_id:                        userId,
    p_account_id:                     accountId,
    p_instrument:                     instrument,
    p_last_rebuilt_event_sequence_id: lastRebuiltSeqId,
  });
  if (error) {
    console.warn("[rebuildState] markReplayFinished failed (non-fatal)", { error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Health / observability queries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get per-position health metrics for a user.
 *
 * Returns lag, stale status, and rebuild timing for every position
 * the user has events for.  Used by the /api/health endpoint and the
 * UI staleness detection layer.
 *
 * Calls the get_position_health(p_user_id) SECURITY DEFINER RPC.
 */
export async function getPositionHealth(userId: string): Promise<PositionHealthRow[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc("get_position_health", {
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`[rebuildState] get_position_health failed: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    instrument:                      row["instrument"] as string,
    account_id:                      row["account_id"] as string,
    latest_event_sequence_id:        Number(row["latest_event_sequence_id"]),
    last_rebuilt_event_sequence_id:  row["last_rebuilt_event_sequence_id"] != null
                                       ? Number(row["last_rebuilt_event_sequence_id"])
                                       : null,
    lag:                             Number(row["lag"]),
    rebuild_started_at:              row["rebuild_started_at"] as string | null,
    rebuild_finished_at:             row["rebuild_finished_at"] as string | null,
    rebuild_count:                   Number(row["rebuild_count"]),
    replay_in_progress:              row["replay_in_progress"] as boolean,
    replay_status:                   (row["replay_status"] as string) ?? "completed",
    replay_heartbeat_at:             row["replay_heartbeat_at"] as string | null,
    is_stale:                        row["is_stale"] as boolean,
    is_replay_stuck:                 (row["is_replay_stuck"] as boolean) ?? false,
  }));
}

/**
 * Get the maximum event_sequence_id in the event_log for a user.
 * This is the "latest event the system has seen" — the leading edge.
 *
 * Returns 0 if the user has no events.
 */
export async function getLatestEventSequenceId(userId: string): Promise<number> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("event_log")
    .select("event_sequence_id")
    .eq("user_id", userId)
    .order("event_sequence_id", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    // PGRST116 = no rows found — user has no events
    if (error.code === "PGRST116") return 0;
    throw new Error(`[rebuildState] getLatestEventSequenceId failed: ${error.message}`);
  }

  return Number((data as { event_sequence_id: number }).event_sequence_id);
}

/**
 * Get the rebuild state row for a single position.
 * Returns null if the position has never been rebuilt.
 */
export async function getRebuildState(
  userId:     string,
  accountId:  string,
  instrument: string,
): Promise<RebuildStateRow | null> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("position_rebuild_state")
    .select("*")
    .eq("user_id",    userId)
    .eq("account_id", accountId)
    .eq("instrument", instrument)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`[rebuildState] getRebuildState failed: ${error.message}`);
  }

  return data as RebuildStateRow;
}
