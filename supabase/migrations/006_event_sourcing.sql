-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: event_log table — the sole source of truth
-- ─────────────────────────────────────────────────────────────────────────────
-- Run via: supabase db push  (or paste into Supabase SQL editor)
-- Safe to re-run: all statements use IF NOT EXISTS / CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Architecture
-- ────────────
-- The event_log is append-only and immutable.  All derived state
-- (executions, trades, positions, behavior) is regenerable by replaying
-- events in event_sequence_id order.
--
-- Ordering invariant (EV-3)
-- ──────────────────────────
-- event_sequence_id BIGINT GENERATED ALWAYS AS IDENTITY provides a
-- strictly monotonic, per-database sequence.  This is the ONLY ordering
-- dimension used by the reconstruction pipeline.  fill_timestamp (broker
-- clock) is stored as payload metadata and is never used for ordering.
--
-- Deduplication invariant (EV-4)
-- ────────────────────────────────
-- broker_event_hash = `${broker}:${accountId}:${brokerExecId}` is the
-- UNIQUE dedup key per user.  A duplicate insert fails with error 23505;
-- the app layer treats this as a clean no-op.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── event_log ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_log (
  -- DB-assigned strictly-monotonic ordering key.
  -- GENERATED ALWAYS means the app layer cannot supply or override this value.
  -- It advances even for aborted transactions — gaps are normal and expected.
  event_sequence_id  BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  id                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  user_id            UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Broker identifier: "tradovate" for MVP.  Used in broker_event_hash.
  broker             TEXT         NOT NULL,

  -- Broker account ID.  TEXT for portability (Tradovate uses integers but
  -- other brokers may use strings).
  account_id         TEXT         NOT NULL,

  -- Canonical instrument symbol (e.g. "ESM5").  May be contractId string for
  -- MVP if the extension hasn't resolved it yet.
  instrument         TEXT         NOT NULL,

  -- Event type discriminator.
  event_type         TEXT         NOT NULL
                       CHECK (event_type IN ('execution', 'correction', 'position_reset')),

  -- Deduplication key: `${broker}:${accountId}:${brokerExecId}`.
  -- UNIQUE(user_id, broker_event_hash) is the sole dedup mechanism.
  -- The app layer does ON CONFLICT / detects 23505 and silently ignores duplicates.
  broker_event_hash  TEXT         NOT NULL,

  -- Typed event payload as JSONB.
  -- For execution: { broker_exec_id, account_id, symbol, side, qty, price,
  --                  fill_timestamp, order_id }
  -- JSON null values for nullable fields round-trip as SQL NULL via ->> cast.
  payload            JSONB        NOT NULL DEFAULT '{}',

  -- Original broker object, verbatim.  Never modified.  Retained for audit /
  -- schema change recovery.
  raw_payload        JSONB        NOT NULL DEFAULT '{}',

  -- Wall-clock time this row was written.
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT event_log_user_hash_uniq UNIQUE (user_id, broker_event_hash)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Reconstruction read path: covers WHERE user_id + instrument + account_id
-- with ORDER BY event_sequence_id ASC.
CREATE INDEX IF NOT EXISTS event_log_reconstruction_idx
  ON event_log (user_id, instrument, account_id, event_sequence_id ASC);

-- Replay path: read all events for a user in sequence order.
CREATE INDEX IF NOT EXISTS event_log_user_seq_idx
  ON event_log (user_id, event_sequence_id ASC);

-- Dedup lookup (covered by the UNIQUE constraint, but explicit for clarity):
-- UNIQUE(user_id, broker_event_hash) above creates an implicit index.

-- ── RPC: read_events_for_reconstruction ──────────────────────────────────────
--
-- Advisory-locked, sorted read of all events for one position.
--
-- Advisory lock mechanism
-- ────────────────────────
-- pg_advisory_xact_lock(key1 int4, key2 int4) acquires a transaction-scoped
-- lock.  Two concurrent calls with the same (p_user_id, p_instrument,
-- p_account_id) serialise: the second waits until the first's transaction
-- ends.  The second call then reads at least as many events as the first
-- (monotonically increasing snapshot).
--
-- This serialisation ensures that concurrent reconstruction attempts always
-- converge: the last writer wins (via replace_position_trades DELETE+INSERT),
-- and the last writer had the most events.
--
-- SECURITY DEFINER: runs as function owner (postgres) to bypass RLS.
-- The app layer has authenticated the caller before invoking this RPC.

CREATE OR REPLACE FUNCTION read_events_for_reconstruction(
  p_user_id    UUID,
  p_instrument TEXT,
  p_account_id TEXT
)
RETURNS SETOF event_log
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Serialise concurrent reconstruction for the same position.
  -- hashtext(text) → int4.  Two keys reduces false-sharing between positions.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_user_id::text),
    hashtext(p_instrument || E'\x00' || p_account_id)
  );

  -- Return events in strict event_sequence_id order (EV-3).
  -- ORDER BY fill_timestamp is intentionally absent — event_sequence_id only.
  RETURN QUERY
    SELECT *
    FROM   event_log
    WHERE  user_id    = p_user_id
      AND  instrument = p_instrument
      AND  account_id = p_account_id
    ORDER BY event_sequence_id ASC;
END;
$$;

COMMENT ON FUNCTION read_events_for_reconstruction IS
  'Advisory-locked read of event_log for one position. '
  'Serialises concurrent reconstruction triggers for (user, instrument, account). '
  'Returns rows in strict event_sequence_id ASC order (EV-3). '
  'fill_timestamp is payload metadata; it is never used for ordering here.';


-- ── RPC: replay_position ─────────────────────────────────────────────────────
--
-- Full replay for a single position: delete all derived trades and signal
-- the app layer to run reconstruction from scratch.
--
-- The RPC itself only clears derived state — the TypeScript replay pathway
-- (lib/replay.ts) calls this, then calls readEventsForPosition + reduce +
-- reconstruct + replace to regenerate trades.
--
-- SECURITY DEFINER: same reasoning as above.

CREATE OR REPLACE FUNCTION replay_position(
  p_user_id    UUID,
  p_instrument TEXT,
  p_account_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Clear derived trades for this position.
  -- The trades table is a materialised view of reconstruction output;
  -- deleting here is safe — all source data is in event_log.
  DELETE FROM trades
  WHERE  user_id    = p_user_id
    AND  symbol     = p_instrument
    AND  account_id = p_account_id;
END;
$$;

COMMENT ON FUNCTION replay_position IS
  'Delete all derived trades for a position so it can be reconstructed from scratch. '
  'Called by lib/replay.ts before re-running the full event reduce + reconstruct cycle. '
  'event_log rows are never deleted — they are the source of truth.';


-- ── Row Level Security ────────────────────────────────────────────────────────
-- RPCs run as SECURITY DEFINER and bypass RLS.
-- Direct client queries (dashboard, admin panel) are filtered by user_id.

ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'event_log' AND policyname = 'event_log_owner'
  ) THEN
    CREATE POLICY event_log_owner ON event_log
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
