-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: rebuild_locks + replay_status + heartbeat
-- ─────────────────────────────────────────────────────────────────────────────
-- Run via: supabase db push  (or paste into Supabase SQL editor)
-- Safe to re-run: all statements use IF NOT EXISTS / CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This migration adds:
--   1. rebuild_locks       — persistent cross-instance reconstruction lock
--   2. replay_status       — self-healing replay state machine
--   3. replay_heartbeat_at — liveness signal for in-progress replays
--   4. RPCs for lock lifecycle and stale detection
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. rebuild_locks ─────────────────────────────────────────────────────────
--
-- Persistent, DB-backed coordination table.
-- One row per (user_id, account_id, instrument) position.
--
-- Purpose
-- ───────
-- The in-process pendingRebuilds Set in ingest.ts handles burst coalescing
-- within one process, but is invisible to other instances and evaporates on restart.
-- rebuild_locks is the CROSS-PROCESS SOURCE OF TRUTH for reconstruction state.
--
-- Rules
-- ─────
--   - Only one instance may hold 'running' status per position at a time.
--   - A lock is considered STALE if status = 'running' AND
--     now() - updated_at > 2 minutes (process crashed mid-reconstruction).
--   - Stale locks are auto-released by try_acquire_rebuild_lock.
--   - Correctness guarantee: the advisory lock inside read_events_for_reconstruction
--     serialises the actual read phase. This table is for observability + stale recovery.
--
-- Interaction with advisory lock
-- ──────────────────────────────
-- rebuild_locks is acquired BEFORE calling read_events_for_reconstruction.
-- The advisory lock (inside that RPC) handles the actual read serialisation.
-- The two layers are complementary:
--   - rebuild_locks: persistent, observable, cross-instance, stale-recoverable.
--   - advisory lock: in-transaction, low-latency, handles within-RPC serialisation.

CREATE TABLE IF NOT EXISTS rebuild_locks (
  user_id     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id  TEXT         NOT NULL,
  instrument  TEXT         NOT NULL,
  -- 'running' = reconstruction in progress; 'idle' = no active reconstruction.
  status      TEXT         NOT NULL DEFAULT 'idle'
                             CHECK (status IN ('running', 'idle')),
  -- Wall-clock time when status last became 'running'. Used for stale detection.
  locked_at   TIMESTAMPTZ,
  -- Updated on every lock operation. Stale if now() - updated_at > STALE_THRESHOLD.
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id, instrument)
);

CREATE INDEX IF NOT EXISTS rebuild_locks_user_idx
  ON rebuild_locks (user_id);

ALTER TABLE rebuild_locks ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'rebuild_locks' AND policyname = 'rebuild_locks_owner'
  ) THEN
    CREATE POLICY rebuild_locks_owner ON rebuild_locks
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;


-- ── 2. try_acquire_rebuild_lock ──────────────────────────────────────────────
--
-- Attempts to acquire the rebuild lock for a position.
-- Returns TRUE if acquired, FALSE if another instance holds a fresh lock.
--
-- Stale lock auto-release
-- ────────────────────────
-- If the lock is held (status = 'running') but updated_at is older than
-- STALE_THRESHOLD_SECS seconds, the lock is considered stale (process crashed).
-- We atomically release-and-reacquire it.
--
-- Atomicity
-- ─────────
-- The conditional UPDATE is atomic: only one concurrent caller will succeed
-- when the lock is idle or stale — the other will see rows_affected = 0.
-- This uses Postgres row-level locking naturally.
--
-- SECURITY DEFINER: called by the ingest pipeline via service client.

CREATE OR REPLACE FUNCTION try_acquire_rebuild_lock(
  p_user_id    UUID,
  p_account_id TEXT,
  p_instrument TEXT,
  p_stale_secs INTEGER DEFAULT 120  -- 2 minutes
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  -- Upsert the row if it doesn't exist yet (first time this position is seen).
  INSERT INTO rebuild_locks (user_id, account_id, instrument, status, locked_at, updated_at)
  VALUES (p_user_id, p_account_id, p_instrument, 'idle', NULL, NOW())
  ON CONFLICT (user_id, account_id, instrument) DO NOTHING;

  -- Attempt to acquire: update to 'running' only if currently idle OR stale.
  -- Stale = running but updated_at older than stale threshold.
  UPDATE rebuild_locks SET
    status     = 'running',
    locked_at  = NOW(),
    updated_at = NOW()
  WHERE user_id    = p_user_id
    AND account_id = p_account_id
    AND instrument = p_instrument
    AND (
      status = 'idle'
      OR (status = 'running' AND NOW() - updated_at > make_interval(secs => p_stale_secs))
    );

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

COMMENT ON FUNCTION try_acquire_rebuild_lock IS
  'Non-blocking lock acquisition for reconstruction. Returns TRUE if acquired. '
  'Auto-releases stale locks (running for > p_stale_secs seconds without heartbeat). '
  'Called before scheduling reconstruction; complements the advisory lock in the read RPC.';


-- ── 3. release_rebuild_lock ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION release_rebuild_lock(
  p_user_id    UUID,
  p_account_id TEXT,
  p_instrument TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE rebuild_locks SET
    status     = 'idle',
    locked_at  = NULL,
    updated_at = NOW()
  WHERE user_id    = p_user_id
    AND account_id = p_account_id
    AND instrument = p_instrument;
END;
$$;


-- ── 4. heartbeat_rebuild_lock ────────────────────────────────────────────────
--
-- Prevents stale detection for long-running operations (large replays).
-- Called periodically during replay (e.g., every 30 seconds or per batch).

CREATE OR REPLACE FUNCTION heartbeat_rebuild_lock(
  p_user_id    UUID,
  p_account_id TEXT,
  p_instrument TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE rebuild_locks SET
    updated_at = NOW()
  WHERE user_id    = p_user_id
    AND account_id = p_account_id
    AND instrument = p_instrument
    AND status     = 'running';
END;
$$;


-- ── 5. Add replay_status + replay_heartbeat_at to position_rebuild_state ─────
--
-- Upgrades position_rebuild_state (created in migration 007) with:
--   replay_status        — enum for self-healing replay state machine
--   replay_heartbeat_at  — liveness signal; stale if > 2 min behind NOW()
--
-- replay_status transitions:
--   (absent) → running   on replay start
--   running  → completed on replay finish
--   running  → failed    on replay exception
--   running  → stale     detected by health endpoint when heartbeat is old
--   stale    → running   on retry replay
--   failed   → running   on retry replay
--
-- The health endpoint surfaces 'stale' and 'failed' as "Replay interrupted — recovering".

ALTER TABLE position_rebuild_state
  ADD COLUMN IF NOT EXISTS replay_status TEXT
    DEFAULT 'completed'
    CHECK (replay_status IN ('running', 'completed', 'stale', 'failed')),
  ADD COLUMN IF NOT EXISTS replay_heartbeat_at TIMESTAMPTZ;


-- ── 6. mark_replay_started: update to set replay_status ──────────────────────

CREATE OR REPLACE FUNCTION mark_replay_started(
  p_user_id    UUID,
  p_account_id TEXT,
  p_instrument TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO position_rebuild_state (
    user_id, account_id, instrument,
    replay_in_progress, replay_started_at,
    replay_status, replay_heartbeat_at
  ) VALUES (
    p_user_id, p_account_id, p_instrument,
    TRUE, NOW(),
    'running', NOW()
  )
  ON CONFLICT (user_id, account_id, instrument) DO UPDATE SET
    replay_in_progress  = TRUE,
    replay_started_at   = NOW(),
    replay_status       = 'running',
    replay_heartbeat_at = NOW(),
    updated_at          = NOW();
END;
$$;


-- ── 7. heartbeat_replay: keep replay alive during large replay operations ─────

CREATE OR REPLACE FUNCTION heartbeat_replay(
  p_user_id    UUID,
  p_account_id TEXT,
  p_instrument TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE position_rebuild_state SET
    replay_heartbeat_at = NOW(),
    updated_at          = NOW()
  WHERE user_id    = p_user_id
    AND account_id = p_account_id
    AND instrument = p_instrument
    AND replay_status = 'running';
END;
$$;


-- ── 8. mark_replay_finished: updated to set replay_status = completed ─────────

CREATE OR REPLACE FUNCTION mark_replay_finished(
  p_user_id                         UUID,
  p_account_id                      TEXT,
  p_instrument                      TEXT,
  p_last_rebuilt_event_sequence_id  BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO position_rebuild_state (
    user_id, account_id, instrument,
    last_rebuilt_event_sequence_id,
    rebuild_finished_at,
    rebuild_count,
    replay_in_progress,
    replay_started_at,
    replay_status,
    replay_heartbeat_at
  ) VALUES (
    p_user_id, p_account_id, p_instrument,
    p_last_rebuilt_event_sequence_id,
    NOW(), 1,
    FALSE, NULL,
    'completed', NULL
  )
  ON CONFLICT (user_id, account_id, instrument) DO UPDATE SET
    last_rebuilt_event_sequence_id = p_last_rebuilt_event_sequence_id,
    rebuild_finished_at            = NOW(),
    rebuild_count                  = position_rebuild_state.rebuild_count + 1,
    replay_in_progress             = FALSE,
    replay_started_at              = NULL,
    replay_status                  = 'completed',
    replay_heartbeat_at            = NULL,
    updated_at                     = NOW();
END;
$$;


-- ── 9. mark_replay_failed: for explicit failure recording ────────────────────

CREATE OR REPLACE FUNCTION mark_replay_failed(
  p_user_id    UUID,
  p_account_id TEXT,
  p_instrument TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO position_rebuild_state (
    user_id, account_id, instrument,
    replay_in_progress,
    replay_status,
    replay_heartbeat_at
  ) VALUES (
    p_user_id, p_account_id, p_instrument,
    FALSE,
    'failed',
    NULL
  )
  ON CONFLICT (user_id, account_id, instrument) DO UPDATE SET
    replay_in_progress  = FALSE,
    replay_status       = 'failed',
    replay_heartbeat_at = NULL,
    updated_at          = NOW();
END;
$$;


-- ── 10. get_position_health: update stale detection to use replay_status ──────
--
-- Re-creates the function from migration 007 with replay_status + stale logic.
-- A replay is STALE if replay_status = 'running' AND heartbeat > 2 min old.
-- The function auto-detects this and includes it in the result.

CREATE OR REPLACE FUNCTION get_position_health(p_user_id UUID)
RETURNS TABLE (
  instrument                      TEXT,
  account_id                      TEXT,
  latest_event_sequence_id        BIGINT,
  last_rebuilt_event_sequence_id  BIGINT,
  lag                             BIGINT,
  rebuild_started_at              TIMESTAMPTZ,
  rebuild_finished_at             TIMESTAMPTZ,
  rebuild_count                   INTEGER,
  replay_in_progress              BOOLEAN,
  replay_status                   TEXT,
  replay_heartbeat_at             TIMESTAMPTZ,
  is_stale                        BOOLEAN,
  -- True if replay_status = 'running' AND heartbeat is older than 2 minutes.
  is_replay_stuck                 BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.instrument,
    e.account_id,
    MAX(e.event_sequence_id)                       AS latest_event_sequence_id,
    r.last_rebuilt_event_sequence_id,
    MAX(e.event_sequence_id) - COALESCE(r.last_rebuilt_event_sequence_id, 0) AS lag,
    r.rebuild_started_at,
    r.rebuild_finished_at,
    COALESCE(r.rebuild_count, 0)                   AS rebuild_count,
    COALESCE(r.replay_in_progress, FALSE)           AS replay_in_progress,
    COALESCE(r.replay_status, 'completed')          AS replay_status,
    r.replay_heartbeat_at,
    (MAX(e.event_sequence_id) > COALESCE(r.last_rebuilt_event_sequence_id, -1)) AS is_stale,
    -- Replay is stuck if status = 'running' and heartbeat hasn't updated in 2 min
    (
      COALESCE(r.replay_status, 'completed') = 'running'
      AND r.replay_heartbeat_at IS NOT NULL
      AND NOW() - r.replay_heartbeat_at > INTERVAL '2 minutes'
    ) AS is_replay_stuck
  FROM event_log e
  LEFT JOIN position_rebuild_state r
    ON  r.user_id    = e.user_id
    AND r.account_id = e.account_id
    AND r.instrument = e.instrument
  WHERE e.user_id = p_user_id
  GROUP BY e.instrument, e.account_id,
           r.last_rebuilt_event_sequence_id, r.rebuild_started_at,
           r.rebuild_finished_at, r.rebuild_count, r.replay_in_progress,
           r.replay_status, r.replay_heartbeat_at;
END;
$$;

COMMENT ON FUNCTION get_position_health IS
  'Returns per-position reconstruction and replay health. '
  'is_replay_stuck = true triggers "Replay interrupted — recovering" UI state. '
  'is_stale = true triggers "Updating trades…" UI state.';
