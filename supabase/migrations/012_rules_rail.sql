-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012: Prop-Rule Rail + Behaviour labeling (Value Layer v1)
-- ─────────────────────────────────────────────────────────────────────────────
-- Run via: supabase db push  (or paste into the Supabase SQL editor)
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT throughout.
--
-- ADDITIVE & NON-DESTRUCTIVE. Adds four tables + RPCs. Touches nothing else.
--
--   rule_presets          – shared catalog of firm/plan rule sets (reference data)
--   account_rules         – the rule profile bound to one (user, account)
--   account_equity_state  – running survival state (peak, floor, day, buffers)
--   trade_behaviour       – behavioural fingerprint captured at each trade's entry
--
-- Trust note: RAIL is deterministic math on hard firm limits, so it must never be
-- wrong. Preset numbers are *representative defaults* and carry verified_on +
-- source_url so they can be audited and corrected as data, never as a deploy. The
-- user confirms their plan in Settings before RAIL is authoritative.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. rule_presets — shared firm/plan catalog (reference data, not per-user)
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rule_presets (
  id                 TEXT         PRIMARY KEY,          -- 'apex_50k', 'topstep_50k'
  firm               TEXT         NOT NULL,
  plan_label         TEXT         NOT NULL,
  account_size       NUMERIC(14,2) NOT NULL,
  starting_balance   NUMERIC(14,2) NOT NULL,
  profit_target      NUMERIC(14,2),                     -- NULL once funded/live
  max_drawdown       NUMERIC(14,2) NOT NULL,            -- the threshold amount
  drawdown_type      TEXT         NOT NULL
                       CHECK (drawdown_type IN ('trailing_intraday','trailing_eod','static')),
  drawdown_lock_at   NUMERIC(14,2),                     -- peak equity at which the floor locks
  drawdown_lock_to   NUMERIC(14,2),                     -- locked floor value (e.g. starting balance)
  daily_loss_limit   NUMERIC(14,2),                     -- NULL if the firm has none (e.g. Apex)
  consistency_pct    NUMERIC(5,4),                      -- e.g. 0.3000; NULL if none
  min_trading_days   INTEGER,
  contract_limit     INTEGER,
  source_url         TEXT,                              -- the firm's published rulebook
  verified_on        DATE         NOT NULL,             -- when these numbers were last confirmed
  active             BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Reference data: readable by any authenticated user; writes via service role only.
ALTER TABLE rule_presets ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'rule_presets' AND policyname = 'rule_presets_read'
  ) THEN
    CREATE POLICY rule_presets_read ON rule_presets
      FOR SELECT USING (auth.role() = 'authenticated');
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. account_rules — the rule profile for one (user, account)
-- ═════════════════════════════════════════════════════════════════════════════
-- Denormalised on purpose: picking a preset COPIES its values here, so a later
-- change to a preset never silently alters a trader's tracked limits. The
-- effective profile is exactly this row. source_preset_id records provenance.
CREATE TABLE IF NOT EXISTS account_rules (
  user_id            UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id         TEXT         NOT NULL,
  firm               TEXT         NOT NULL,
  plan_label         TEXT         NOT NULL,
  source_preset_id   TEXT         REFERENCES rule_presets(id),  -- NULL = custom
  starting_balance   NUMERIC(14,2) NOT NULL,
  profit_target      NUMERIC(14,2),
  max_drawdown       NUMERIC(14,2) NOT NULL,
  drawdown_type      TEXT         NOT NULL
                       CHECK (drawdown_type IN ('trailing_intraday','trailing_eod','static')),
  drawdown_lock_at   NUMERIC(14,2),
  drawdown_lock_to   NUMERIC(14,2),
  daily_loss_limit   NUMERIC(14,2),
  consistency_pct    NUMERIC(5,4),
  min_trading_days   INTEGER,
  contract_limit     INTEGER,
  verified_on        DATE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT account_rules_pk PRIMARY KEY (user_id, account_id)
);

ALTER TABLE account_rules ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'account_rules' AND policyname = 'account_rules_owner'
  ) THEN
    CREATE POLICY account_rules_owner ON account_rules
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. account_equity_state — running survival state (one row per user+account)
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS account_equity_state (
  user_id            UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id         TEXT         NOT NULL,
  realized_balance   NUMERIC(14,2) NOT NULL,            -- starting + Σ realized pnl
  open_pnl           NUMERIC(14,2) NOT NULL DEFAULT 0,  -- unrealized of open positions
  peak_equity        NUMERIC(14,2) NOT NULL,            -- running max per drawdown_type
  floor_locked       BOOLEAN      NOT NULL DEFAULT FALSE,
  day_key            TEXT,                              -- CME session day this row's day_* refers to
  day_start_balance  NUMERIC(14,2) NOT NULL,
  day_realized_pnl   NUMERIC(14,2) NOT NULL DEFAULT 0,
  max_day_profit     NUMERIC(14,2) NOT NULL DEFAULT 0,  -- best single-day profit (consistency rule)
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT account_equity_state_pk PRIMARY KEY (user_id, account_id)
);

ALTER TABLE account_equity_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'account_equity_state' AND policyname = 'account_equity_state_owner'
  ) THEN
    CREATE POLICY account_equity_state_owner ON account_equity_state
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. trade_behaviour — behavioural fingerprint captured at trade entry
-- ═════════════════════════════════════════════════════════════════════════════
-- Keyed by the STABLE natural key (user, account, symbol, opened_at). Trades are
-- derived from executions and are wiped+rebuilt on every reconstruction, so the
-- trade UUID is NOT stable — opened_at (first entry fill ts) is. The fingerprint
-- is immutable once written; only pnl is back-filled when the trade closes.
CREATE TABLE IF NOT EXISTS trade_behaviour (
  user_id        UUID          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id     TEXT          NOT NULL,
  symbol         TEXT          NOT NULL,
  opened_at      TIMESTAMPTZ   NOT NULL,           -- natural-key component (trade entry)
  heartbeat      TEXT          NOT NULL,           -- CALM | ELEVATED | AGITATED | CRITICAL at entry
  dev_trade_count NUMERIC(8,4),                    -- signed deviation vector at entry
  dev_pace       NUMERIC(8,4),
  dev_size       NUMERIC(8,4),
  dev_duration   NUMERIC(8,4),
  off_dims       TEXT[]        NOT NULL DEFAULT '{}', -- dims beyond threshold at entry
  risk_score     NUMERIC(6,2),                      -- composite deviation index at entry (0–100)
  pnl            NUMERIC(14,6),                     -- net_pnl, filled on close (NULL = still open)
  labeled_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT trade_behaviour_pk PRIMARY KEY (user_id, account_id, symbol, opened_at)
);

CREATE INDEX IF NOT EXISTS trade_behaviour_user_account_idx
  ON trade_behaviour (user_id, account_id, opened_at DESC);

ALTER TABLE trade_behaviour ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'trade_behaviour' AND policyname = 'trade_behaviour_owner'
  ) THEN
    CREATE POLICY trade_behaviour_owner ON trade_behaviour
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- RPCs (SECURITY DEFINER — called by the service-role pipeline / API)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── set_account_rules: upsert the rule profile for (user, account). ───────────
DROP FUNCTION IF EXISTS set_account_rules(UUID, TEXT, JSONB);
CREATE OR REPLACE FUNCTION set_account_rules(
  p_user_id    UUID,
  p_account_id TEXT,
  p_rules      JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO account_rules (
    user_id, account_id, firm, plan_label, source_preset_id,
    starting_balance, profit_target, max_drawdown, drawdown_type,
    drawdown_lock_at, drawdown_lock_to, daily_loss_limit, consistency_pct,
    min_trading_days, contract_limit, verified_on, updated_at
  ) VALUES (
    p_user_id, p_account_id,
    (p_rules->>'firm')::text,
    (p_rules->>'plan_label')::text,
    (p_rules->>'source_preset_id')::text,
    (p_rules->>'starting_balance')::numeric,
    (p_rules->>'profit_target')::numeric,
    (p_rules->>'max_drawdown')::numeric,
    (p_rules->>'drawdown_type')::text,
    (p_rules->>'drawdown_lock_at')::numeric,
    (p_rules->>'drawdown_lock_to')::numeric,
    (p_rules->>'daily_loss_limit')::numeric,
    (p_rules->>'consistency_pct')::numeric,
    (p_rules->>'min_trading_days')::int,
    (p_rules->>'contract_limit')::int,
    (p_rules->>'verified_on')::date,
    NOW()
  )
  ON CONFLICT (user_id, account_id) DO UPDATE SET
    firm             = EXCLUDED.firm,
    plan_label       = EXCLUDED.plan_label,
    source_preset_id = EXCLUDED.source_preset_id,
    starting_balance = EXCLUDED.starting_balance,
    profit_target    = EXCLUDED.profit_target,
    max_drawdown     = EXCLUDED.max_drawdown,
    drawdown_type    = EXCLUDED.drawdown_type,
    drawdown_lock_at = EXCLUDED.drawdown_lock_at,
    drawdown_lock_to = EXCLUDED.drawdown_lock_to,
    daily_loss_limit = EXCLUDED.daily_loss_limit,
    consistency_pct  = EXCLUDED.consistency_pct,
    min_trading_days = EXCLUDED.min_trading_days,
    contract_limit   = EXCLUDED.contract_limit,
    verified_on      = EXCLUDED.verified_on,
    updated_at       = NOW();
END; $$;

-- ── upsert_account_equity_state: persist running survival state. ──────────────
DROP FUNCTION IF EXISTS upsert_account_equity_state(UUID, TEXT, JSONB);
CREATE OR REPLACE FUNCTION upsert_account_equity_state(
  p_user_id    UUID,
  p_account_id TEXT,
  p_state      JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO account_equity_state (
    user_id, account_id, realized_balance, open_pnl, peak_equity, floor_locked,
    day_key, day_start_balance, day_realized_pnl, max_day_profit, updated_at
  ) VALUES (
    p_user_id, p_account_id,
    (p_state->>'realized_balance')::numeric,
    COALESCE((p_state->>'open_pnl')::numeric, 0),
    (p_state->>'peak_equity')::numeric,
    COALESCE((p_state->>'floor_locked')::boolean, FALSE),
    (p_state->>'day_key')::text,
    (p_state->>'day_start_balance')::numeric,
    COALESCE((p_state->>'day_realized_pnl')::numeric, 0),
    COALESCE((p_state->>'max_day_profit')::numeric, 0),
    NOW()
  )
  ON CONFLICT (user_id, account_id) DO UPDATE SET
    realized_balance  = EXCLUDED.realized_balance,
    open_pnl          = EXCLUDED.open_pnl,
    peak_equity       = EXCLUDED.peak_equity,
    floor_locked      = EXCLUDED.floor_locked,
    day_key           = EXCLUDED.day_key,
    day_start_balance = EXCLUDED.day_start_balance,
    day_realized_pnl  = EXCLUDED.day_realized_pnl,
    max_day_profit    = EXCLUDED.max_day_profit,
    updated_at        = NOW();
END; $$;

-- ── upsert_trade_behaviour: batch upsert fingerprints by natural key. ─────────
-- Fingerprint columns are written once (first sighting) and preserved on
-- conflict; only pnl is allowed to back-fill as a trade closes.
DROP FUNCTION IF EXISTS upsert_trade_behaviour(UUID, JSONB);
CREATE OR REPLACE FUNCTION upsert_trade_behaviour(
  p_user_id UUID,
  p_rows    JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF jsonb_array_length(p_rows) = 0 THEN RETURN; END IF;

  INSERT INTO trade_behaviour (
    user_id, account_id, symbol, opened_at, heartbeat,
    dev_trade_count, dev_pace, dev_size, dev_duration,
    off_dims, risk_score, pnl
  )
  SELECT
    p_user_id,
    (r->>'account_id')::text,
    (r->>'symbol')::text,
    (r->>'opened_at')::timestamptz,
    (r->>'heartbeat')::text,
    (r->>'dev_trade_count')::numeric,
    (r->>'dev_pace')::numeric,
    (r->>'dev_size')::numeric,
    (r->>'dev_duration')::numeric,
    ARRAY(SELECT jsonb_array_elements_text(r->'off_dims')),
    (r->>'risk_score')::numeric,
    (r->>'pnl')::numeric
  FROM jsonb_array_elements(p_rows) AS r
  ON CONFLICT (user_id, account_id, symbol, opened_at) DO UPDATE SET
    -- fingerprint is immutable; only the outcome back-fills
    pnl = COALESCE(EXCLUDED.pnl, trade_behaviour.pnl);
END; $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- Seed: rule_presets — major US futures prop firms.
-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠ REPRESENTATIVE DEFAULTS. Prop-firm rules change with plans/promos. Each row
--   carries verified_on + source_url; confirm against the firm's current rulebook
--   before treating RAIL as authoritative. The user re-confirms in Settings.
--   Drawdown semantics: floor = (floor_locked ? lock_to : peak - max_drawdown);
--   floor locks once peak_equity >= drawdown_lock_at.
INSERT INTO rule_presets
  (id, firm, plan_label, account_size, starting_balance, profit_target, max_drawdown,
   drawdown_type, drawdown_lock_at, drawdown_lock_to, daily_loss_limit, consistency_pct,
   min_trading_days, contract_limit, source_url, verified_on)
VALUES
  -- Apex Trader Funding — trailing intraday (on unrealized), locks at breakeven, 30% consistency, no daily loss
  ('apex_25k',  'Apex Trader Funding','25K',  25000, 25000, 1500,  1500, 'trailing_intraday', 26500, 25000, NULL, 0.30, 1,  4,  'https://apextraderfunding.com', '2026-06-01'),
  ('apex_50k',  'Apex Trader Funding','50K',  50000, 50000, 3000,  2500, 'trailing_intraday', 52500, 50000, NULL, 0.30, 1,  10, 'https://apextraderfunding.com', '2026-06-01'),
  ('apex_75k',  'Apex Trader Funding','75K',  75000, 75000, 4250,  2750, 'trailing_intraday', 77750, 75000, NULL, 0.30, 1,  12, 'https://apextraderfunding.com', '2026-06-01'),
  ('apex_100k', 'Apex Trader Funding','100K',100000,100000, 6000,  3000, 'trailing_intraday',103000,100000, NULL, 0.30, 1,  14, 'https://apextraderfunding.com', '2026-06-01'),
  ('apex_150k', 'Apex Trader Funding','150K',150000,150000, 9000,  5000, 'trailing_intraday',155000,150000, NULL, 0.30, 1,  17, 'https://apextraderfunding.com', '2026-06-01'),
  ('apex_250k', 'Apex Trader Funding','250K',250000,250000,15000,  6500, 'trailing_intraday',256500,250000, NULL, 0.30, 1,  27, 'https://apextraderfunding.com', '2026-06-01'),
  ('apex_300k', 'Apex Trader Funding','300K',300000,300000,20000,  7500, 'trailing_intraday',307500,300000, NULL, 0.30, 1,  35, 'https://apextraderfunding.com', '2026-06-01'),
  -- Topstep — trailing end-of-day, has daily loss limit, locks at starting balance
  ('topstep_50k', 'Topstep','50K', 50000, 50000, 3000, 2000, 'trailing_eod',  52000, 50000, 1000, NULL, 2, 5,  'https://www.topstep.com', '2026-06-01'),
  ('topstep_100k','Topstep','100K',100000,100000,6000, 3000, 'trailing_eod', 103000,100000, 2000, NULL, 2, 10, 'https://www.topstep.com', '2026-06-01'),
  ('topstep_150k','Topstep','150K',150000,150000,9000, 4500, 'trailing_eod', 154500,150000, 3000, NULL, 2, 15, 'https://www.topstep.com', '2026-06-01'),
  -- Take Profit Trader — end-of-day drawdown, no daily loss limit
  ('tpt_50k',  'Take Profit Trader','50K',  50000, 50000, 3000, 2000, 'trailing_eod', 52000, 50000, NULL, NULL, 1, 5,  'https://takeprofittrader.com', '2026-06-01'),
  ('tpt_100k', 'Take Profit Trader','100K',100000,100000,6000, 3000, 'trailing_eod',103000,100000, NULL, NULL, 1, 10, 'https://takeprofittrader.com', '2026-06-01'),
  -- MyFundedFutures (Expert) — end-of-day drawdown + daily loss limit
  ('mffu_50k', 'MyFundedFutures','50K Expert', 50000, 50000, 3000, 2000, 'trailing_eod', 52000, 50000, 1100, NULL, 1, 5,  'https://myfundedfutures.com', '2026-06-01'),
  ('mffu_100k','MyFundedFutures','100K Expert',100000,100000,6000, 3000,'trailing_eod',103000,100000, 2200, NULL, 1, 10, 'https://myfundedfutures.com', '2026-06-01'),
  -- Tradeify (Advanced) — static drawdown + daily loss limit
  ('tradeify_50k', 'Tradeify','50K Advanced', 50000, 50000, 3000, 2000, 'static', NULL, NULL, 1250, NULL, 1, 5,  'https://tradeify.co', '2026-06-01'),
  ('tradeify_100k','Tradeify','100K Advanced',100000,100000,6000, 3000, 'static', NULL, NULL, 2500, NULL, 1, 10, 'https://tradeify.co', '2026-06-01'),
  -- Bulenox — end-of-day trailing
  ('bulenox_50k',  'Bulenox','50K',  50000, 50000, 3000, 2500, 'trailing_eod', 52500, 50000, NULL, NULL, 1, 10, 'https://bulenox.com', '2026-06-01'),
  ('bulenox_100k', 'Bulenox','100K',100000,100000,6000, 3000, 'trailing_eod',103000,100000, NULL, NULL, 1, 12, 'https://bulenox.com', '2026-06-01'),
  -- Elite Trader Funding — end-of-day trailing (Fast Track family)
  ('etf_50k',  'Elite Trader Funding','50K',  50000, 50000, 3000, 2500, 'trailing_eod', 52500, 50000, NULL, NULL, 1, 10, 'https://elitetraderfunding.com', '2026-06-01'),
  ('etf_100k', 'Elite Trader Funding','100K',100000,100000,6000, 3000, 'trailing_eod',103000,100000, NULL, NULL, 1, 12, 'https://elitetraderfunding.com', '2026-06-01'),
  -- Earn2Trade (Trader Career Path / Gauntlet) — trailing + daily loss limit
  ('e2t_25k',  'Earn2Trade','Gauntlet 25K',  25000, 25000, 1750, 1500, 'trailing_eod', 26500, 25000, 550,  NULL, 10, 3, 'https://www.earn2trade.com', '2026-06-01'),
  ('e2t_50k',  'Earn2Trade','Gauntlet 50K',  50000, 50000, 3000, 2000, 'trailing_eod', 52000, 50000, 1200, NULL, 10, 5, 'https://www.earn2trade.com', '2026-06-01')
ON CONFLICT (id) DO UPDATE SET
  firm             = EXCLUDED.firm,
  plan_label       = EXCLUDED.plan_label,
  account_size     = EXCLUDED.account_size,
  starting_balance = EXCLUDED.starting_balance,
  profit_target    = EXCLUDED.profit_target,
  max_drawdown     = EXCLUDED.max_drawdown,
  drawdown_type    = EXCLUDED.drawdown_type,
  drawdown_lock_at = EXCLUDED.drawdown_lock_at,
  drawdown_lock_to = EXCLUDED.drawdown_lock_to,
  daily_loss_limit = EXCLUDED.daily_loss_limit,
  consistency_pct  = EXCLUDED.consistency_pct,
  min_trading_days = EXCLUDED.min_trading_days,
  contract_limit   = EXCLUDED.contract_limit,
  source_url       = EXCLUDED.source_url,
  verified_on      = EXCLUDED.verified_on;
