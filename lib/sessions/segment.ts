/**
 * lib/sessions/segment.ts
 *
 * Phase 0 — deterministic session segmentation.
 *
 * buildSessions() is a PURE function: given the same trades + options (and the
 * same `now`), it always returns identical sessions. No I/O, no client state,
 * no randomness. This is what makes sessions safe to recompute from `trades`
 * (which are themselves recomputable from `event_log`) — full replay-safety.
 *
 * ── How flat-state detection works ───────────────────────────────────────────
 * A reconstructed trade represents one position lifecycle for ONE instrument:
 * the account holds that position from `opened_at` until `closed_at`
 * (`closed_at = null` means the position is still open). The account is FLAT at
 * time t when NO trade (on ANY instrument) is active at t.
 *
 * We track a "frontier" = the maximum `closed_at` seen so far within the current
 * session. After the frontier, every trade in the session is closed, so the
 * account is flat. If ANY trade in the session is still open, the account never
 * returns to flat → the frontier is +∞ and the session cannot be split.
 *
 * ── How session boundaries are computed ──────────────────────────────────────
 * Walking trades in deterministic order, a NEW session starts before trade `t`
 * only when the account is flat (frontier finite) AND either:
 *    • idle gap = t.opened_at − frontier ≥ G, or
 *    • the CME trading-day boundary (17:00 CT) lies between frontier and t.
 * A boundary is never placed while a position is open (you cannot split an open
 * position) — this transparently handles long-running positions that span
 * what would otherwise be a gap or day boundary.
 *
 * ── How determinism is guaranteed ────────────────────────────────────────────
 *   1. Trades are sorted by (opened_at ASC, id ASC) inside this function, so
 *      out-of-order ingestion cannot affect the result.
 *   2. The frontier/gap/day-boundary logic is a pure function of stored
 *      timestamps (broker `fill_timestamp`, surfaced via trades).
 *   3. session_id is a content hash of (user, account, start_ts, first_trade_id)
 *      — stable across recomputations as long as the session's first trade is.
 *   4. Only the trailing session's open/provisional/closed status depends on
 *      `now`; every historical session is fully deterministic.
 */

import { createHash } from "crypto";
import {
  type Session,
  type SessionTrade,
  type SessionStatus,
  type SessionGroup,
  type SegmentOptions,
  DEFAULT_GAP_MS,
  DEFAULT_MIN_ELIGIBLE_TRADES,
  EXCHANGE_TZ,
  SESSION_ROLL_HOUR_CT,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Segment a flat list of trades into sessions.
 *
 * Pure, deterministic, replay-safe. Sessions are scoped per account; trades
 * across all instruments within an account share sessions.
 *
 * @returns Sessions sorted by (account_id, start_ts). Every input trade belongs
 *          to exactly one session.
 */
export function buildSessions(
  userId: string,
  trades: SessionTrade[],
  opts: SegmentOptions = {},
): Session[] {
  return assignSessions(userId, trades, opts).map((g) => g.session);
}

/**
 * Like buildSessions, but also returns the trades belonging to each session.
 * Used by the feature layer (lib/sessions/features.ts) so per-session metrics
 * can be computed without re-deriving the segmentation. Same determinism
 * guarantees as buildSessions.
 *
 * @param userId  Owner of the trades (used for session_id + the user_id field).
 * @param trades  All trades to segment. May span accounts/instruments, may be
 *                unsorted, may include open and `skipped` trades.
 * @param opts    Tunable gap / eligibility / day-boundary / now.
 */
export function assignSessions(
  userId: string,
  trades: SessionTrade[],
  opts: SegmentOptions = {},
): SessionGroup[] {
  const gapMs       = opts.gapMs ?? DEFAULT_GAP_MS;
  const minEligible = opts.minEligibleTrades ?? DEFAULT_MIN_ELIGIBLE_TRADES;
  const splitOnDay  = opts.splitOnDayBoundary ?? true;
  const now         = opts.now ?? Date.now();

  if (trades.length === 0) return [];

  // Sessions are per-account. Group first, segment each account independently.
  const byAccount = new Map<string, SessionTrade[]>();
  for (const t of trades) {
    const arr = byAccount.get(t.account_id);
    if (arr) arr.push(t);
    else byAccount.set(t.account_id, [t]);
  }

  const groups: SessionGroup[] = [];
  for (const [accountId, accTrades] of byAccount) {
    segmentAccount(userId, accountId, accTrades, gapMs, minEligible, splitOnDay, now, groups);
  }

  // Deterministic output order.
  groups.sort((a, b) =>
    a.session.account_id !== b.session.account_id
      ? cmp(a.session.account_id, b.session.account_id)
      : cmp(a.session.start_ts, b.session.start_ts),
  );
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-account segmentation
// ─────────────────────────────────────────────────────────────────────────────

interface OpenSession {
  trades:     SessionTrade[];
  startMs:    number;
  frontierMs: number;        // max closed_at ms; +Infinity if any trade is open
  maxActMs:   number;        // max(opened/closed) seen — used as end_ts when open
  firstId:    string;
  lastId:     string;
  hasOpen:    boolean;
}

function segmentAccount(
  userId: string,
  accountId: string,
  accTrades: SessionTrade[],
  gapMs: number,
  minEligible: number,
  splitOnDay: boolean,
  now: number,
  out: SessionGroup[],
): void {
  // Deterministic ordering: opened_at ASC, then id ASC as a stable tiebreak.
  const sorted = [...accTrades].sort((a, b) => {
    const ao = Date.parse(a.opened_at);
    const bo = Date.parse(b.opened_at);
    if (ao !== bo) return ao - bo;
    return cmp(a.id, b.id);
  });

  let cur: OpenSession | null = null;

  const flush = (s: OpenSession): void => {
    out.push({ session: finalize(userId, accountId, s, gapMs, minEligible, now), trades: s.trades });
  };

  for (const t of sorted) {
    const openedMs = Date.parse(t.opened_at);
    const closedMs = t.closed_at ? Date.parse(t.closed_at) : null;

    if (cur === null) {
      cur = startSession(t, openedMs, closedMs);
      continue;
    }

    // A boundary is only possible at a flat point (frontier finite = no open
    // position carried into this trade).
    let boundary = false;
    if (cur.frontierMs !== Infinity) {
      const idleGap = openedMs - cur.frontierMs;
      const dayCross =
        splitOnDay && tradingDayKey(cur.frontierMs) !== tradingDayKey(openedMs);
      if (idleGap >= gapMs || dayCross) boundary = true;
    }

    if (boundary) {
      flush(cur);
      cur = startSession(t, openedMs, closedMs);
    } else {
      extendSession(cur, t, openedMs, closedMs);
    }
  }

  if (cur !== null) flush(cur);
}

function startSession(t: SessionTrade, openedMs: number, closedMs: number | null): OpenSession {
  const isOpen = closedMs === null;
  return {
    trades:     [t],
    startMs:    openedMs,
    frontierMs: isOpen ? Infinity : (closedMs as number),
    maxActMs:   Math.max(openedMs, closedMs ?? openedMs),
    firstId:    t.id,
    lastId:     t.id,
    hasOpen:    isOpen,
  };
}

function extendSession(cur: OpenSession, t: SessionTrade, openedMs: number, closedMs: number | null): void {
  cur.trades.push(t);
  cur.lastId  = t.id;
  cur.maxActMs = Math.max(cur.maxActMs, openedMs, closedMs ?? openedMs);
  if (closedMs === null) {
    // An open position means the account is no longer guaranteed flat anywhere
    // after this point in the session → frontier becomes +∞.
    cur.hasOpen    = true;
    cur.frontierMs = Infinity;
  } else if (cur.frontierMs !== Infinity) {
    cur.frontierMs = Math.max(cur.frontierMs, closedMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalisation
// ─────────────────────────────────────────────────────────────────────────────

function finalize(
  userId: string,
  accountId: string,
  s: OpenSession,
  gapMs: number,
  minEligible: number,
  now: number,
): Session {
  let status: SessionStatus;
  let endMs:  number;

  if (s.hasOpen || s.frontierMs === Infinity) {
    // A position is still open → the session is live.
    status = "open";
    endMs  = s.maxActMs;
  } else {
    endMs = s.frontierMs;
    // Flat: not final until G has elapsed without a new trade.
    status = now - endMs < gapMs ? "provisional" : "closed";
  }

  const startIso = new Date(s.startMs).toISOString();

  return {
    session_id:            deterministicSessionId(userId, accountId, startIso, s.firstId),
    user_id:               userId,
    account_id:            accountId,
    start_ts:              startIso,
    end_ts:                new Date(endMs).toISOString(),
    trade_count:           s.trades.length,
    first_trade_id:        s.firstId,
    last_trade_id:         s.lastId,
    status,
    eligible_for_analysis: s.trades.length >= minEligible,
    feature_vector:        null,   // Phase 1
    outcome:               null,   // Phase 1
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic, stable session id derived from content (UUIDv5-style).
 * Same (user, account, start_ts, first_trade_id) → same id on every recompute.
 */
function deterministicSessionId(
  userId: string,
  accountId: string,
  startIso: string,
  firstTradeId: string,
): string {
  const seed = `axiem.session.v1|${userId}|${accountId}|${startIso}|${firstTradeId}`;
  const hex = createHash("sha1").update(seed).digest("hex");
  const c = hex.slice(0, 32).split("");
  c[12] = "5"; // version 5
  c[16] = ((parseInt(c[16], 16) & 0x3) | 0x8).toString(16); // RFC-4122 variant
  const u = c.join("");
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
}

/**
 * CME trading-day key (YYYY-MM-DD) for a timestamp. Equity-index futures roll
 * at 17:00 CT, so a timestamp at/after 17:00 CT belongs to the next day's
 * session. DST-safe (resolves wall-clock via the exchange timezone).
 */
function tradingDayKey(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EXCHANGE_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  let y = get("year");
  let mo = get("month");
  let d = get("day");
  const h = get("hour") % 24; // Intl can emit "24" at midnight in some envs

  if (h >= SESSION_ROLL_HOUR_CT) {
    const next = new Date(Date.UTC(y, mo - 1, d));
    next.setUTCDate(next.getUTCDate() + 1);
    y = next.getUTCFullYear();
    mo = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
