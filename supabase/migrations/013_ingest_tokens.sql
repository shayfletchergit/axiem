-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013: ingest_tokens (browser-extension producer auth)
-- ─────────────────────────────────────────────────────────────────────────────
-- Run via: supabase db push  (or paste into the Supabase SQL editor)
-- Safe to re-run: IF NOT EXISTS throughout.
--
-- The live open-P&L producer runs in a browser extension on the prop platform's
-- origin, where the Supabase session cookie won't attach. It authenticates to
-- /api/rail/ingest with a long-lived BEARER token instead.
--
-- Security: only the SHA-256 hash of the token is stored; the plaintext is shown
-- once at mint time and never persisted. Tokens are revocable (revoked_at) and
-- per-user. Validation is cached in-memory so the hot ingest path hits the DB at
-- most once per token per TTL — never per tick.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingest_tokens (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash    TEXT         NOT NULL UNIQUE,     -- sha256 hex of the plaintext token
  token_prefix  TEXT         NOT NULL,            -- first chars, for display only
  label         TEXT,                              -- user-supplied ("Chrome — desk")
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ingest_tokens_user_idx ON ingest_tokens (user_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE ingest_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ingest_tokens' AND policyname = 'ingest_tokens_owner'
  ) THEN
    CREATE POLICY ingest_tokens_owner ON ingest_tokens
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;
