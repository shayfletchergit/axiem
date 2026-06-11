-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 011: recompute support (Phase B integration — wiring only)
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive, non-destructive. Adds ONE read-only RPC the sweep worker uses to
-- find which (user, account) pairs have trades newer than their last session
-- build. No analytics, no new source of truth.
-- ─────────────────────────────────────────────────────────────────────────────

-- get_dirty_accounts()
-- ────────────────────
-- Returns (user_id, account_id) where the account has trades updated after its
-- most recent session build (or has never been built), EXCLUDING accounts with
-- a replay in progress (avoids the delete-then-rebuild torn-read window).
--
-- Called only by the server-side sweep via the service-role client (global scope).
-- Never exposed to end users.

CREATE OR REPLACE FUNCTION get_dirty_accounts()
RETURNS TABLE (user_id UUID, account_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH t AS (
    SELECT tr.user_id, tr.account_id, MAX(tr.updated_at) AS last_trade
    FROM   trades tr
    GROUP  BY tr.user_id, tr.account_id
  ),
  s AS (
    SELECT se.user_id, se.account_id, MAX(se.computed_at) AS last_session
    FROM   sessions se
    GROUP  BY se.user_id, se.account_id
  )
  SELECT t.user_id, t.account_id
  FROM   t
  LEFT JOIN s
    ON  s.user_id    = t.user_id
    AND s.account_id = t.account_id
  WHERE (s.last_session IS NULL OR t.last_trade > s.last_session)
    AND NOT EXISTS (
      SELECT 1 FROM position_rebuild_state r
      WHERE  r.user_id    = t.user_id
        AND  r.account_id = t.account_id
        AND  r.replay_in_progress = TRUE
    );
$$;

COMMENT ON FUNCTION get_dirty_accounts IS
  'Accounts whose trades are newer than their last session build (or never built), '
  'excluding replay-in-progress accounts. Used by the recompute sweep worker. '
  'Read-only; no analytics; service-role only.';
