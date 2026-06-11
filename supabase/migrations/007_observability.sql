-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: reconstruction observability, replay safety, snapshot stub
-- ─────────────────────────────────────────────────────────────────────────────
-- Run via: supabase db push  (or paste into Supabase SQL editor)
-- Safe to re-run: all statements use IF NOT EXISTS / CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This migration adds:
--   1. position_rebuild_state  — tracks reconstruction freshness per position
--   2. RPCs for rebuild state lifecycle (started / finished / replay lock)
--   3. position_snapshots      — stub table for future snapshot optimisation
--   4. Health query helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. position_rebuild_state ─────────────────────────────────────────────────
--
-- One row per (user_id, account_id, instrument) triple.
-- Tracks the reconstruction freshness of the materialised trades for that position.
--
-- Freshness invariant:
--   lag = MAX(event_sequence_id WHERE user_id+account_id+instrument) - last_rebuilt_event_sequence_id
--   lag > 0  ↔  trades are stale and a rebuild is in progress or pending
--   lag = 0  ↔  trades are current
--   last_rebuilt IS NULL ↔  position has never been reconstructed
--
-- replay_in_progress / replay_started_at
--   Set while lib/replay.ts is running a full re-reduce for this position.
--   Ingestion continues during replay (event_log always accepts writes).
--   The UI must show a replay-in-progress indicator while this is true.

CREATE TABLE IF NOT EXISTS position_rebuild_state (
  user_id                          UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id                       TEXT         NOT NULL,
  instrument                       TEXT         NOT NULL,

  -- event_sequence_id of the last event that was included in the current
  -- materialised trades.  NULL = trades have never been built for this position.
  last_rebuilt_event_sequence_id   BIGINT,

  -- Wall-clock times of the most recent rebuild cycle.
  rebuild_started_at               TIMESTAMPTZ,
  rebuild_finished_at              TIMESTAMPTZ,

  -- Monotonically incrementing rebuild counter.  Allows the UI to detect when
  -- a new rebuild has completed (count changed) vs the same rebuild.
  rebuild_count                    INTEGER      NOT NULL DEFAULT 0,

  -- True while lib/replay.ts is executing a full re-reduce for this position.
  -- Acts as a soft advisory flag (not a hard lock — the DB advisory lock is used
  -- for actual serialisation).
  replay_in_progress               BOOLEAN      NOT NULL DEFAULT FALSE,
  replay_started_at                TIMESTAMPTZ,

  created_at                       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, account_id, instrument)
);

-- updated_at trigger reuses set_updated_at() from migration 005.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'position_rebuild_state_updated_at'
      AND tgrelid = 'position_rebuild_state'::regclass
  ) THEN
    CREATE TRIGGER position_rebuild_state_updated_at
      BEFORE UPDATE ON position_rebuild_state
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Index: health endpoint queries all positions for a user.
CREATE INDEX IF NOT EXISTS position_rebuild_state_user_idx
  ON position_rebuild_state (user_id);

-- RLS
ALTER TABLE position_rebuild_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'position_rebuild_state' AND policyname = 'position_rebuild_state_owner'
  ) THEN
    CREATE POLICY position_rebuild_state_owner ON position_rebuild_state
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;


-- ── 2. RPCs: rebuild state lifecycle ─────────────────────────────────────────

-- mark_rebuild_started
-- ─────────────────────
-- Called at the start of scheduleReconstruction (before advisory lock read).
-- Upserts the row, sets rebuild_started_at, clears rebuild_finished_at.
-- SECURITY DEFINER: called from the ingest pipeline which uses service role.

CREATE OR REPLACE FUNCTION mark_rebuild_started(
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
    rebuild_started_at, rebuild_finished_at
  ) VALUES (
    p_user_id, p_account_id, p_instrument,
    NOW(), NULL
  )
  ON CONFLICT (user_id, account_id, instrument) DO UPDATE SET
    rebuild_started_at   = NOW(),
    rebuild_finished_at  = NULL,
    updated_at           = NOW();
END;
$$;

COMMENT ON FUNCTION mark_rebuild_started IS
  'Called at the start of a reconstruction cycle. Sets rebuild_started_at, '
  'clears rebuild_finished_at. UI uses the NULL finished_at to show "Updating trades…".';


-- mark_rebuild_finished
-- ──────────────────────
-- Called after replace_position_trades completes successfully.
-- Records the highest event_sequence_id included in this rebuild.

CREATE OR REPLACE FUNCTION mark_rebuild_finished(
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
    rebuild_count
  ) VALUES (
    p_user_id, p_account_id, p_instrument,
    p_last_rebuilt_event_sequence_id,
    NOW(),
    1
  )
  ON CONFLICT (user_id, account_id, instrument) DO UPDATE SET
    last_rebuilt_event_sequence_id = p_last_rebuilt_event_sequence_id,
    rebuild_finished_at            = NOW(),
    rebuild_count                  = position_rebuild_state.rebuild_count + 1,
    updated_at                     = NOW();
END;
$$;

COMMENT ON FUNCTION mark_rebuild_finished IS
  'Called after a successful reconstruction write. Records the highest '
  'event_sequence_id covered and increments rebuild_count.';


-- mark_replay_started / mark_replay_finished
-- ────────────────────────────────────────────
-- Used by lib/replay.ts to flag that a full re-reduce is in progress.
-- The UI must surface this state to prevent user confusion during replay.

DROP FUNCTION IF EXISTS mark_replay_started;
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
    replay_in_progress, replay_started_at
  ) VALUES (
    p_user_id, p_account_id, p_instrument,
    TRUE, NOW()
  )
  ON CONFLICT (user_id, account_id, instrument) DO UPDATE SET
    replay_in_progress = TRUE,
    replay_started_at  = NOW(),
    updated_at         = NOW();
END;
$$;

DROP FUNCTION IF EXISTS mark_replay_finished;
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
    replay_started_at
  ) VALUES (
    p_user_id, p_account_id, p_instrument,
    p_last_rebuilt_event_sequence_id,
    NOW(),
    1,
    FALSE,
    NULL
  )
  ON CONFLICT (user_id, account_id, instrument) DO UPDATE SET
    last_rebuilt_event_sequence_id = p_last_rebuilt_event_sequence_id,
    rebuild_finished_at            = NOW(),
    rebuild_count                  = position_rebuild_state.rebuild_count + 1,
    replay_in_progress             = FALSE,
    replay_started_at              = NULL,
    updated_at                     = NOW();
END;
$$;


-- ── 3. Health query: get_position_health ─────────────────────────────────────
--
-- Returns per-position health metrics for a user:
--   instrument, account_id,
--   latest_event_sequence_id   (MAX in event_log for this position)
--   last_rebuilt_event_sequence_id
--   lag                        (latest - last_rebuilt; negative means never rebuilt)
--   rebuild_started_at
--   rebuild_finished_at
--   rebuild_count
--   replay_in_progress
--
-- SECURITY DEFINER: health endpoint is called by authenticated service client.

DROP FUNCTION IF EXISTS get_position_health;
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
  is_stale                        BOOLEAN
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
    -- lag: how many sequence IDs behind the rebuild is.
    -- If never rebuilt, treat as lag = latest (all events unprocessed).
    MAX(e.event_sequence_id) - COALESCE(r.last_rebuilt_event_sequence_id, 0) AS lag,
    r.rebuild_started_at,
    r.rebuild_finished_at,
    COALESCE(r.rebuild_count, 0)                   AS rebuild_count,
    COALESCE(r.replay_in_progress, FALSE)           AS replay_in_progress,
    -- is_stale: true if trades don't reflect all known events
    (MAX(e.event_sequence_id) > COALESCE(r.last_rebuilt_event_sequence_id, -1)) AS is_stale
  FROM event_log e
  LEFT JOIN position_rebuild_state r
    ON  r.user_id    = e.user_id
    AND r.account_id = e.account_id
    AND r.instrument = e.instrument
  WHERE e.user_id = p_user_id
  GROUP BY e.instrument, e.account_id,
           r.last_rebuilt_event_sequence_id, r.rebuild_started_at,
           r.rebuild_finished_at, r.rebuild_count, r.replay_in_progress;
END;
$$;

COMMENT ON FUNCTION get_position_health IS
  'Returns per-position reconstruction freshness for the health endpoint and UI staleness detection. '
  'lag > 0 means trades are stale. is_stale = true means the UI must show "Updating trades…".';


-- ── 4. position_snapshots (stub — future snapshot optimisation) ───────────────
--
-- SNAPSHOT MIGRATION PATH
-- ───────────────────────
-- When event_log grows large (>10k events per user), full reduce-on-every-read
-- becomes expensive.  The snapshot optimisation makes reconstruction O(events
-- since snapshot) instead of O(all events).
--
-- Design:
--   1. Periodically (e.g. every 100 events, or on a schedule) save the full
--      ReducerOutput for a position to position_snapshots.
--   2. readEventsForPosition() is replaced by:
--        a. Load latest snapshot for position.
--        b. Read only events WHERE event_sequence_id > snapshot.last_event_sequence_id.
--        c. Reduce snapshot.state + incremental events.
--   3. Snapshots are never the source of truth — they are a cache.
--      replay_position() can be called at any time to regenerate from scratch.
--   4. A snapshot is invalidated by bumping last_event_sequence_id on write.
--
-- The stub table below reserves the schema. Activate it in a future migration
-- by wiring readEventsForPositionSince() (already in lib/db/eventLog.ts) to
-- the ingest reconstruction pipeline.
--
-- IMPORTANT: Do NOT write to this table until the snapshot activation migration.
-- Reading from it before it has data will return zero rows, causing
-- readEventsForPositionSince(0, ...) which is equivalent to full reduce — safe.

CREATE TABLE IF NOT EXISTS position_snapshots (
  user_id                  UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id               TEXT         NOT NULL,
  instrument               TEXT         NOT NULL,
  -- The event_sequence_id of the last event included in this snapshot.
  -- Reconstruction reads events WHERE event_sequence_id > this value.
  last_event_sequence_id   BIGINT       NOT NULL,
  -- Serialised ReducerOutput.  JSON null values cast to SQL NULL on extraction.
  state                    JSONB        NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Only one active snapshot per position.
  PRIMARY KEY (user_id, account_id, instrument)
);

-- RLS
ALTER TABLE position_snapshots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'position_snapshots' AND policyname = 'position_snapshots_owner'
  ) THEN
    CREATE POLICY position_snapshots_owner ON position_snapshots
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
