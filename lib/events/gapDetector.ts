/**
 * lib/events/gapDetector.ts
 *
 * Failure-mode visibility: detect reconstruction lag and sequence gaps.
 *
 * Key distinction
 * ───────────────
 * event_sequence_id is a GLOBAL DB sequence (not per-user, not per-position).
 * Gaps in the global sequence are expected and normal (rolled-back transactions
 * advance the sequence counter but leave no row).  You CANNOT use global sequence
 * continuity to detect missing fills — that would produce constant false positives.
 *
 * What we CAN detect
 * ───────────────────
 * 1. Reconstruction lag:
 *      latest_event_sequence_id (in event_log for a position)
 *    > last_rebuilt_event_sequence_id (in position_rebuild_state)
 *    → trades are stale; a rebuild is pending or in progress.
 *
 * 2. Rebuild stuck:
 *    rebuild_started_at is set but rebuild_finished_at is null AND
 *    NOW() - rebuild_started_at > threshold
 *    → reconstruction may have crashed mid-run.
 *
 * 3. Replay stuck:
 *    replay_in_progress = true AND
 *    NOW() - replay_started_at > threshold
 *    → replay may have crashed (REPLAY-2 violation: replay_in_progress not cleared).
 *
 * 4. SSE lag:
 *    Not detectable server-side (SSE is push-only).
 *    The client should compare the last event_sequence_id received via SSE
 *    against the health endpoint's latest_event_sequence_id.
 *    If they differ for > threshold, the client should reconnect.
 */

import type { PositionHealthRow } from "@/lib/db/rebuildState";

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** If a rebuild has been running for longer than this, flag it as stuck. */
const REBUILD_STUCK_THRESHOLD_MS = 30_000;  // 30 seconds

/** If replay has been running for longer than this, flag it as stuck. */
const REPLAY_STUCK_THRESHOLD_MS = 120_000;  // 2 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type FailureMode =
  | "stale_trades"         // lag > 0 — trades don't reflect all known events
  | "rebuild_stuck"        // rebuild started but not finished within threshold
  | "replay_stuck"         // replay_in_progress = true and stale beyond threshold
  | "never_built";         // position has events but has never been reconstructed

export interface PositionDiagnostic {
  instrument:   string;
  accountId:    string;
  lag:          number;
  isStale:      boolean;
  failures:     FailureMode[];
  /** Human-readable status for UI display. */
  uiStatus:     "current" | "updating" | "rebuilding" | "replay_stuck" | "error";
}

export interface SystemDiagnostic {
  /** All positions that are not fully current. */
  stalePositions:  PositionDiagnostic[];
  /** All positions including current ones. */
  allPositions:    PositionDiagnostic[];
  /** True if any position has a stuck rebuild or replay. */
  hasBlockingError: boolean;
  /** True if any position is stale (lag > 0). */
  hasStaleState:   boolean;
  /** Timestamp this diagnostic was computed. */
  computedAt:      string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse position health rows and produce structured diagnostics.
 *
 * Pure function — takes PositionHealthRow[] from getPositionHealth() and
 * returns a SystemDiagnostic.  No DB calls, no side effects.
 *
 * @param rows    Output of getPositionHealth(userId).
 * @param nowMs   Current wall-clock in milliseconds (default: Date.now()).
 *                Parameterised for deterministic testing.
 */
export function analysePositionHealth(
  rows:  PositionHealthRow[],
  nowMs: number = Date.now(),
): SystemDiagnostic {
  const allPositions: PositionDiagnostic[] = rows.map((row) =>
    diagnosePosition(row, nowMs),
  );

  const stalePositions = allPositions.filter((p) => p.failures.length > 0);
  const hasBlockingError = stalePositions.some(
    (p) => p.failures.includes("rebuild_stuck") || p.failures.includes("replay_stuck"),
  );
  const hasStaleState = stalePositions.some((p) => p.isStale);

  return {
    stalePositions,
    allPositions,
    hasBlockingError,
    hasStaleState,
    computedAt: new Date(nowMs).toISOString(),
  };
}

function diagnosePosition(
  row:   PositionHealthRow,
  nowMs: number,
): PositionDiagnostic {
  const failures: FailureMode[] = [];

  // Never built
  if (row.last_rebuilt_event_sequence_id === null) {
    failures.push("never_built");
  }

  // Stale trades (lag > 0)
  if (row.is_stale) {
    failures.push("stale_trades");
  }

  // Rebuild stuck: started but not finished within threshold
  if (row.rebuild_started_at && !row.rebuild_finished_at) {
    const startedMs = new Date(row.rebuild_started_at).getTime();
    if (nowMs - startedMs > REBUILD_STUCK_THRESHOLD_MS) {
      failures.push("rebuild_stuck");
    }
  }

  // Replay stuck
  if (row.replay_in_progress) {
    // Use rebuild_started_at as a proxy for when replay began
    // (the DB stores replay_started_at separately but may not be in PositionHealthRow)
    // If replay has been in-progress since before the threshold, it's stuck.
    if (row.rebuild_started_at) {
      const startedMs = new Date(row.rebuild_started_at).getTime();
      if (nowMs - startedMs > REPLAY_STUCK_THRESHOLD_MS) {
        failures.push("replay_stuck");
      }
    }
  }

  // Determine UI status
  let uiStatus: PositionDiagnostic["uiStatus"];
  if (failures.includes("replay_stuck")) {
    uiStatus = "replay_stuck";
  } else if (failures.includes("rebuild_stuck")) {
    uiStatus = "error";
  } else if (row.replay_in_progress) {
    uiStatus = "rebuilding";
  } else if (row.is_stale || (row.rebuild_started_at && !row.rebuild_finished_at)) {
    uiStatus = "updating";
  } else {
    uiStatus = "current";
  }

  return {
    instrument:  row.instrument,
    accountId:   row.account_id,
    lag:         row.lag,
    isStale:     row.is_stale,
    failures,
    uiStatus,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE lag detection (client-side contract — documented here for completeness)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SSE Lag Detection (client responsibility)
 *
 * The server pushes "rebuild_state" events with `last_rebuilt_event_sequence_id`.
 * The client must:
 *   1. Track the last `last_rebuilt_event_sequence_id` received via SSE.
 *   2. Periodically poll /api/health to get the server-side latest sequence.
 *   3. If (health.latest_event_sequence_id - client_last_seen) > LAG_THRESHOLD:
 *      → Show "Connection may be delayed" indicator.
 *      → Reconnect the SSE stream.
 *
 * The server does NOT detect SSE lag because SSE is push-only — there is no
 * acknowledgement mechanism.  The client is the only party that knows whether
 * it received an event.
 *
 * Suggested client LAG_THRESHOLD: 3 events (3 fills behind without SSE update
 * indicates the connection is stale and should reconnect).
 */
export const SSE_LAG_RECOMMENDATION = {
  description:  "Client should reconnect SSE if event_sequence_id lag exceeds threshold",
  threshold:    3,
  pollInterval: 5_000,  // ms — how often client polls /api/health
} as const;
