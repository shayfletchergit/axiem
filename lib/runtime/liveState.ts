/**
 * lib/runtime/liveState.ts
 *
 * Value Layer v1 — the authoritative IN-MEMORY live layer for RAIL.
 *
 * This is the single source of truth for live updates (NOT Postgres). Per
 * (user, account) it holds the running survival state — realized balance, open
 * P&L, equity, peak — and the latest computed RailState. Open-P&L ticks mutate
 * it and re-run the pure RAIL math in-process; nothing here touches the DB.
 *
 * Lifecycle:
 *   route hydrates an entry once (DB reads happen in the route, passed in here)
 *   → ticks update memory only (pure, < 1ms)
 *   → a 250 ms batcher drains dirty entries and publishes the latest per key.
 *
 * globalThis-backed so it survives Next.js HMR and is shared across route
 * invocations within a single server instance. (Multi-instance scale-out swaps
 * the pubsub layer for Redis; this memory layer stays per-instance by design.)
 */

import { applyEquityTick, computeRail } from "@/lib/rules/rail";
import type { RuleProfile, EquityState, RailState } from "@/lib/rules/types";

export interface HydrateInput {
  userId:           string;
  accountId:        string;
  profile:          RuleProfile;
  realizedBalance:  number;          // startingBalance + lifetime realized net (from DB, once)
  dayRealizedPnl:   number;          // today's realized net (from DB, once)
  dayKey:           string;          // current CME session day
  prevEquityState:  EquityState | null; // persisted state (continues the peak/lock)
}

export interface TickInput {
  openPnl?:        number;           // current unrealized; defaults to last known
  dayRealizedPnl?: number;           // today's realized; provide when a trade closes
  dayKey:          string;           // server-derived CME day (handles rollover)
  now?:            number;
}

interface LiveEntry {
  userId:    string;
  accountId: string;
  profile:   RuleProfile;
  /** balance excluding today's realized — fixed at hydrate so day P&L can move live. */
  baseBalanceBeforeToday: number;
  equity:    EquityState;            // running (peak/lock/day advance in memory)
  rail:      RailState;
  dirty:     boolean;
  lastTickAt: number;
}

type Store = Map<string, LiveEntry>;
const g = globalThis as typeof globalThis & { _axiemLiveState?: Store };
if (!g._axiemLiveState) g._axiemLiveState = new Map();
const store = g._axiemLiveState;

export const keyFor = (userId: string, accountId: string) => `${userId}::${accountId}`;
export const hasEntry = (userId: string, accountId: string) => store.has(keyFor(userId, accountId));

/** Initialise the live entry from already-fetched DB values. Idempotent-safe. */
export function hydrate(input: HydrateInput): RailState {
  const { userId, accountId, profile, realizedBalance, dayRealizedPnl, dayKey, prevEquityState } = input;
  const equity = applyEquityTick(profile, prevEquityState, {
    realizedBalance, openPnl: prevEquityState?.openPnl ?? 0, dayKey, dayRealizedPnl, now: Date.now(),
  });
  const rail = computeRail(profile, equity);
  store.set(keyFor(userId, accountId), {
    userId, accountId, profile,
    baseBalanceBeforeToday: realizedBalance - dayRealizedPnl,
    equity, rail, dirty: true, lastTickAt: Date.now(),
  });
  return rail;
}

/**
 * Apply a live tick (open P&L and/or a realized change). Pure memory + pure RAIL
 * math — no DB, no trade-history recompute. Returns the new RailState, or null if
 * the entry hasn't been hydrated yet (caller should hydrate first).
 */
export function applyTick(userId: string, accountId: string, tick: TickInput): RailState | null {
  const entry = store.get(keyFor(userId, accountId));
  if (!entry) return null;

  const now = tick.now ?? Date.now();
  const rolledOver = entry.equity.dayKey != null && entry.equity.dayKey !== tick.dayKey;

  const openPnl = tick.openPnl ?? entry.equity.openPnl;
  const dayRealizedPnl =
    tick.dayRealizedPnl != null ? tick.dayRealizedPnl
    : rolledOver               ? 0
    :                            entry.equity.dayRealizedPnl;

  // realized balance moves only when day-realized changes (i.e. a trade closes).
  const realizedBalance = entry.baseBalanceBeforeToday + dayRealizedPnl;

  entry.equity = applyEquityTick(entry.profile, entry.equity, {
    realizedBalance, openPnl, dayKey: tick.dayKey, dayRealizedPnl, now,
  });
  entry.rail = computeRail(entry.profile, entry.equity);
  entry.dirty = true;
  entry.lastTickAt = now;
  return entry.rail;
}

/** Latest RailState for an entry (for the dashboard poll to merge), or null. */
export function getRail(userId: string, accountId: string): RailState | null {
  return store.get(keyFor(userId, accountId))?.rail ?? null;
}

/**
 * Drain all dirty entries (latest-wins) for the 250 ms batcher. Returns the
 * newest RailState per key and clears the dirty flag — many ticks collapse to one
 * broadcast per interval.
 */
export function drainDirty(): Array<{ userId: string; accountId: string; rail: RailState }> {
  const out: Array<{ userId: string; accountId: string; rail: RailState }> = [];
  for (const entry of store.values()) {
    if (!entry.dirty) continue;
    entry.dirty = false;
    out.push({ userId: entry.userId, accountId: entry.accountId, rail: entry.rail });
  }
  return out;
}

/** Drop an entry (e.g. account switch / disconnect). */
export function clearEntry(userId: string, accountId: string): void {
  store.delete(keyFor(userId, accountId));
}
