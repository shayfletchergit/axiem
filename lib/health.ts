/**
 * lib/health.ts
 *
 * System health metrics aggregation.
 *
 * Used by GET /api/health to expose production-observable state:
 *   - Latest event sequence ID (leading edge of the event log)
 *   - Per-position reconstruction freshness and lag
 *   - Replay lock status
 *   - Whether any position is stale (needs UI indicator)
 *   - Ingestion-accessible event counts
 *
 * All data comes from the DB — no in-process state.
 * This means /api/health is correct even across process restarts.
 */

import { getPositionHealth, getLatestEventSequenceId } from "@/lib/db/rebuildState";
import { analysePositionHealth }                        from "@/lib/events/gapDetector";
import type { PositionDiagnostic }                      from "@/lib/events/gapDetector";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemHealth {
  /** Wall-clock time this snapshot was computed (ISO). */
  timestamp:                  string;

  /** MAX(event_sequence_id) across all event_log rows for this user. */
  latest_event_sequence_id:   number;

  /**
   * Aggregate rebuild lag across all positions:
   *   SUM of (latest_seq_id - last_rebuilt_seq_id) per position.
   * 0 = all positions are fully current.
   */
  total_rebuild_lag:          number;

  /** True if any position has stale trades. */
  is_stale:                   boolean;

  /** True if any position has a stuck rebuild or replay. */
  has_blocking_error:         boolean;

  /** True if any position is currently being replayed. */
  replay_in_progress:         boolean;

  /** Per-position diagnostic detail. */
  positions:                  PositionDiagnostic[];

  /**
   * Overall system status.
   *   "ok"           — all positions current, no errors.
   *   "updating"     — one or more positions are rebuilding (normal, transient).
   *   "replaying"    — one or more positions are being replayed.
   *   "error"        — a rebuild or replay is stuck; operator attention required.
   *   "degraded"     — stale but not stuck (lag exists, rebuild is queued).
   */
  status: "ok" | "updating" | "replaying" | "error" | "degraded";
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full system health snapshot for a user.
 *
 * Called by GET /api/health.  All DB reads are non-advisory (read-only),
 * so this is safe to call at any frequency without affecting reconstruction.
 *
 * @param userId  Authenticated Supabase user UUID.
 */
export async function getSystemHealth(userId: string): Promise<SystemHealth> {
  const nowMs = Date.now();

  // Parallel reads — health data doesn't need to be atomic
  const [latestSeqId, healthRows] = await Promise.all([
    getLatestEventSequenceId(userId),
    getPositionHealth(userId),
  ]);

  const diagnostic = analysePositionHealth(healthRows, nowMs);

  const totalRebuildLag = healthRows.reduce((sum, row) => sum + (row.lag ?? 0), 0);
  const anyReplayInProgress = healthRows.some((r) => r.replay_in_progress);

  // Compute overall status
  let status: SystemHealth["status"];
  if (diagnostic.hasBlockingError) {
    status = "error";
  } else if (anyReplayInProgress) {
    status = "replaying";
  } else if (diagnostic.stalePositions.some(
    (p) => p.uiStatus === "updating" || p.uiStatus === "rebuilding",
  )) {
    status = "updating";
  } else if (diagnostic.hasStaleState) {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    timestamp:                 new Date(nowMs).toISOString(),
    latest_event_sequence_id:  latestSeqId,
    total_rebuild_lag:         totalRebuildLag,
    is_stale:                  diagnostic.hasStaleState,
    has_blocking_error:        diagnostic.hasBlockingError,
    replay_in_progress:        anyReplayInProgress,
    positions:                 diagnostic.allPositions,
    status,
  };
}
