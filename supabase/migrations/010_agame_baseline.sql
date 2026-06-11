-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010: agame_baseline (Phase 1 — Behavioural Intelligence)
-- ─────────────────────────────────────────────────────────────────────────────
-- Run via: supabase db push  (or paste into the Supabase SQL editor)
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- ADDITIVE & NON-DESTRUCTIVE
-- ──────────────────────────
-- Adds ONE derived table + ONE upsert RPC. Touches nothing else. The baseline
-- is a pure, recomputable median fingerprint of a (user, account)'s top
-- sessions — derived ONLY from `sessions` (their feature_vector + outcome),
-- never from trades.
--
--     sessions (derived) → agame_baseline (derived, this table)
--
-- One row per (user_id, account_id). Recompute any time; the row is replaced.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agame_baseline (
  id                                UUID         PRIMARY KEY,   -- deterministic, app-supplied
  user_id                           UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id                        TEXT         NOT NULL,

  status                            TEXT         NOT NULL DEFAULT 'calibrating'
                                      CHECK (status IN ('calibrating', 'ready')),

  -- Metadata
  session_count                     INTEGER      NOT NULL DEFAULT 0,
  min_session_threshold             INTEGER      NOT NULL DEFAULT 12,
  confidence_score                  DOUBLE PRECISION NOT NULL DEFAULT 0,
  baseline_stability_score          DOUBLE PRECISION NOT NULL DEFAULT 0,
  data_coverage_ratio               DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- Structural baseline (medians of top sessions). NULL while calibrating.
  avg_trade_count                   DOUBLE PRECISION,
  median_trade_count                DOUBLE PRECISION,
  trade_count_iqr                   DOUBLE PRECISION,

  avg_inter_trade_gap_seconds       DOUBLE PRECISION,
  median_inter_trade_gap_seconds    DOUBLE PRECISION,
  pace_iqr                          DOUBLE PRECISION,

  avg_session_duration_minutes      DOUBLE PRECISION,
  median_session_duration_minutes   DOUBLE PRECISION,

  avg_position_size                 DOUBLE PRECISION,
  median_position_size              DOUBLE PRECISION,
  size_variance                     DOUBLE PRECISION,

  post_loss_trade_delay_seconds     DOUBLE PRECISION,
  post_loss_size_change_ratio       DOUBLE PRECISION,

  entry_burst_ratio                 DOUBLE PRECISION,

  -- Outcome (selection only; reported for transparency).
  avg_expectancy                    DOUBLE PRECISION,
  median_expectancy                 DOUBLE PRECISION,
  win_rate                          DOUBLE PRECISION,

  computed_at                       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT agame_baseline_user_account_uniq UNIQUE (user_id, account_id)
);

CREATE INDEX IF NOT EXISTS agame_baseline_user_idx ON agame_baseline (user_id);


-- ── RPC: upsert_agame_baseline ────────────────────────────────────────────────
--
-- Replaces the single baseline row for (user, account). Idempotent: re-running
-- with the same sessions yields the same row. JSON null → SQL NULL.
--
-- SECURITY DEFINER: called by the recompute pathway via the service-role client.

CREATE OR REPLACE FUNCTION upsert_agame_baseline(
  p_user_id    UUID,
  p_account_id TEXT,
  p_baseline   JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO agame_baseline (
    id, user_id, account_id, status,
    session_count, min_session_threshold, confidence_score,
    baseline_stability_score, data_coverage_ratio,
    avg_trade_count, median_trade_count, trade_count_iqr,
    avg_inter_trade_gap_seconds, median_inter_trade_gap_seconds, pace_iqr,
    avg_session_duration_minutes, median_session_duration_minutes,
    avg_position_size, median_position_size, size_variance,
    post_loss_trade_delay_seconds, post_loss_size_change_ratio,
    entry_burst_ratio,
    avg_expectancy, median_expectancy, win_rate,
    computed_at
  ) VALUES (
    (p_baseline->>'id')::uuid,
    p_user_id,
    p_account_id,
    (p_baseline->>'status')::text,
    (p_baseline->>'session_count')::int,
    (p_baseline->>'min_session_threshold')::int,
    (p_baseline->>'confidence_score')::double precision,
    (p_baseline->>'baseline_stability_score')::double precision,
    (p_baseline->>'data_coverage_ratio')::double precision,
    (p_baseline->>'avg_trade_count')::double precision,
    (p_baseline->>'median_trade_count')::double precision,
    (p_baseline->>'trade_count_iqr')::double precision,
    (p_baseline->>'avg_inter_trade_gap_seconds')::double precision,
    (p_baseline->>'median_inter_trade_gap_seconds')::double precision,
    (p_baseline->>'pace_iqr')::double precision,
    (p_baseline->>'avg_session_duration_minutes')::double precision,
    (p_baseline->>'median_session_duration_minutes')::double precision,
    (p_baseline->>'avg_position_size')::double precision,
    (p_baseline->>'median_position_size')::double precision,
    (p_baseline->>'size_variance')::double precision,
    (p_baseline->>'post_loss_trade_delay_seconds')::double precision,
    (p_baseline->>'post_loss_size_change_ratio')::double precision,
    (p_baseline->>'entry_burst_ratio')::double precision,
    (p_baseline->>'avg_expectancy')::double precision,
    (p_baseline->>'median_expectancy')::double precision,
    (p_baseline->>'win_rate')::double precision,
    NOW()
  )
  ON CONFLICT (user_id, account_id) DO UPDATE SET
    id                              = EXCLUDED.id,
    status                          = EXCLUDED.status,
    session_count                   = EXCLUDED.session_count,
    min_session_threshold           = EXCLUDED.min_session_threshold,
    confidence_score                = EXCLUDED.confidence_score,
    baseline_stability_score        = EXCLUDED.baseline_stability_score,
    data_coverage_ratio             = EXCLUDED.data_coverage_ratio,
    avg_trade_count                 = EXCLUDED.avg_trade_count,
    median_trade_count              = EXCLUDED.median_trade_count,
    trade_count_iqr                 = EXCLUDED.trade_count_iqr,
    avg_inter_trade_gap_seconds     = EXCLUDED.avg_inter_trade_gap_seconds,
    median_inter_trade_gap_seconds  = EXCLUDED.median_inter_trade_gap_seconds,
    pace_iqr                        = EXCLUDED.pace_iqr,
    avg_session_duration_minutes    = EXCLUDED.avg_session_duration_minutes,
    median_session_duration_minutes = EXCLUDED.median_session_duration_minutes,
    avg_position_size               = EXCLUDED.avg_position_size,
    median_position_size            = EXCLUDED.median_position_size,
    size_variance                   = EXCLUDED.size_variance,
    post_loss_trade_delay_seconds   = EXCLUDED.post_loss_trade_delay_seconds,
    post_loss_size_change_ratio     = EXCLUDED.post_loss_size_change_ratio,
    entry_burst_ratio               = EXCLUDED.entry_burst_ratio,
    avg_expectancy                  = EXCLUDED.avg_expectancy,
    median_expectancy               = EXCLUDED.median_expectancy,
    win_rate                        = EXCLUDED.win_rate,
    computed_at                     = NOW();
END;
$$;

COMMENT ON FUNCTION upsert_agame_baseline IS
  'Replaces the A-Game baseline row for (user, account). Idempotent. '
  'Derived ONLY from sessions.feature_vector/outcome — recomputable any time.';


-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE agame_baseline ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'agame_baseline' AND policyname = 'agame_baseline_owner'
  ) THEN
    CREATE POLICY agame_baseline_owner ON agame_baseline
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
