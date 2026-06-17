/**
 * lib/rules/rail.ts
 *
 * Value Layer v1 — Prop-Rule Rail engine (PURE, deterministic).
 *
 * Two pure functions, no I/O:
 *   • applyEquityTick — advance the running survival state (peak, lock, day) given
 *     a fresh realized/open P&L tick. Persist the result.
 *   • computeRail     — evaluate the rule profile against the ticked state and
 *     produce the RAIL snapshot (floor, buffers, binding constraint, severity).
 *
 * Survival model:
 *   equity = realized_balance + open_pnl                 (the "if I close now" number)
 *   floor  = static            : starting_balance − max_drawdown
 *            trailing (locked)  : drawdown_lock_to
 *            trailing (open)    : peak − max_drawdown
 *   floor locks once peak_equity ≥ drawdown_lock_at.
 *   binding_buffer = min(trailing_buffer, daily_buffer)  → the number on the Rail.
 *   account_severity = 1 − clamp(binding_buffer / binding_limit) → feeds Heartbeat.
 */

import type {
  RuleProfile, EquityState, EquityTick, RailState, RuleReadout, RailStatus, Heartbeat,
} from "./types";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round2  = (x: number) => Math.round(x * 100) / 100;
const round4  = (x: number) => Math.round(x * 1e4) / 1e4;

// ── Severity → status / heartbeat ladders ────────────────────────────────────

function statusFromFrac(frac: number, violated: boolean): RailStatus {
  if (violated) return "violated";
  if (frac < 0.15) return "danger";
  if (frac < 0.35) return "caution";
  return "safe";
}

/** Pure severity → heartbeat ladder, shared by behavioural and account severity. */
export function heartbeatFromSeverity(severity: number): Heartbeat {
  if (severity >= 0.9) return "CRITICAL";   // ≡ Risk-Escalation override
  if (severity >= 0.6) return "AGITATED";
  if (severity >= 0.3) return "ELEVATED";
  return "CALM";
}

const worst = (a: RailStatus, b: RailStatus): RailStatus => {
  const rank: Record<RailStatus, number> = { na: -1, safe: 0, caution: 1, danger: 2, violated: 3 };
  return rank[a] >= rank[b] ? a : b;
};

// ── Equity state advance ─────────────────────────────────────────────────────

/**
 * Advance the running survival state. Pure: (profile, prevState|null, tick) → next state.
 * Handles day rollover (folding the prior day's profit into max_day_profit),
 * peak tracking per drawdown_type, and floor-lock latching.
 */
export function applyEquityTick(
  profile: RuleProfile,
  prev: EquityState | null,
  tick: EquityTick,
): EquityState {
  const now = tick.now ?? Date.now();
  const openPnl = tick.openPnl ?? 0;
  const realizedBalance = tick.realizedBalance;
  const dayRealizedPnl = tick.dayRealizedPnl;

  let peakEquity:      number;
  let floorLocked:     boolean;
  let dayKey:          string;
  let dayStartBalance: number;
  let maxDayProfit:    number;

  if (!prev) {
    peakEquity      = Math.max(profile.startingBalance, realizedBalance + openPnl);
    floorLocked     = false;
    dayKey          = tick.dayKey;
    dayStartBalance = realizedBalance - dayRealizedPnl;
    maxDayProfit    = Math.max(0, dayRealizedPnl);
  } else {
    peakEquity      = prev.peakEquity;
    floorLocked     = prev.floorLocked;
    dayKey          = prev.dayKey ?? tick.dayKey;
    dayStartBalance = prev.dayStartBalance;
    maxDayProfit    = prev.maxDayProfit;

    if (dayKey !== tick.dayKey) {
      // New CME session day: bank the previous day's realized profit, reset day window.
      maxDayProfit    = Math.max(maxDayProfit, prev.dayRealizedPnl);
      dayKey          = tick.dayKey;
      dayStartBalance = prev.realizedBalance; // balance at the open of the new day
    }
  }

  const equity = realizedBalance + openPnl;

  // Peak basis depends on drawdown type: intraday trails on equity (incl. unrealized),
  // EOD trails on closed balance, static never trails (peak ≡ starting balance).
  const peakBasis =
    profile.drawdownType === "trailing_intraday" ? equity :
    profile.drawdownType === "trailing_eod"      ? realizedBalance :
                                                   profile.startingBalance;
  peakEquity = Math.max(peakEquity, peakBasis);

  if (!floorLocked && profile.drawdownLockAt != null && peakEquity >= profile.drawdownLockAt) {
    floorLocked = true;
  }

  // Consistency tracks the best single day; include today's running profit.
  maxDayProfit = Math.max(maxDayProfit, dayRealizedPnl);

  return {
    realizedBalance: round2(realizedBalance),
    openPnl:         round2(openPnl),
    peakEquity:      round2(peakEquity),
    floorLocked,
    dayKey,
    dayStartBalance: round2(dayStartBalance),
    dayRealizedPnl:  round2(dayRealizedPnl),
    maxDayProfit:    round2(maxDayProfit),
    updatedAt:       new Date(now).toISOString(),
  };
}

// ── Rail evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate the rule profile against a ticked equity state. Pure, no I/O.
 * Returns the RAIL snapshot for the UI plus the (echoed) next equity state.
 */
export function computeRail(profile: RuleProfile, state: EquityState): RailState {
  const equity = state.realizedBalance + state.openPnl;

  // ── Trailing / static drawdown floor ──
  const floor =
    profile.drawdownType === "static"
      ? profile.startingBalance - profile.maxDrawdown
      : state.floorLocked && profile.drawdownLockTo != null
        ? profile.drawdownLockTo
        : state.peakEquity - profile.maxDrawdown;

  const trailingBuffer = equity - floor;
  const trailingFrac   = clamp01(trailingBuffer / profile.maxDrawdown);
  const trailing: RuleReadout = {
    label:  "Trailing Drawdown",
    value:  round2(equity),
    limit:  round2(floor),
    buffer: round2(trailingBuffer),
    status: statusFromFrac(trailingFrac, trailingBuffer <= 0),
  };

  // ── Daily loss limit ──
  let daily: RuleReadout;
  let dailyBuffer = Number.POSITIVE_INFINITY;
  let dailyFrac   = 1;
  if (profile.dailyLossLimit != null) {
    const dayPnl = state.dayRealizedPnl + state.openPnl; // today, mark-to-market
    dailyBuffer  = profile.dailyLossLimit + dayPnl;       // room before −limit
    dailyFrac    = clamp01(dailyBuffer / profile.dailyLossLimit);
    daily = {
      label:  "Daily Loss",
      value:  round2(dayPnl),
      limit:  round2(-profile.dailyLossLimit),
      buffer: round2(dailyBuffer),
      status: statusFromFrac(dailyFrac, dailyBuffer <= 0),
    };
  } else {
    daily = { label: "Daily Loss", value: 0, limit: null, buffer: null, status: "na" };
  }

  // ── Binding constraint (the number on the Rail) ──
  const bindingRule: "trailing" | "daily" = dailyBuffer < trailingBuffer ? "daily" : "trailing";
  const bindingBuffer = Math.min(trailingBuffer, dailyBuffer);
  const bindingFrac   = bindingRule === "daily" ? dailyFrac : trailingFrac;
  const accountSeverity = round4(1 - clamp01(bindingFrac));

  // ── Profit target (progress toward PASS) ──
  let target: RuleReadout;
  let targetAbs: number | null = null;
  let targetProgress: number | null = null;
  if (profile.profitTarget != null) {
    const profit = state.realizedBalance - profile.startingBalance;
    targetAbs = profile.startingBalance + profile.profitTarget;
    targetProgress = clamp01(profit / profile.profitTarget);
    target = {
      label:  "Profit Target",
      value:  round2(profit),
      limit:  round2(profile.profitTarget),
      buffer: round2(profile.profitTarget - profit), // remaining to PASS
      status: profit >= profile.profitTarget ? "safe" : "na",
    };
  } else {
    target = { label: "Profit Target", value: 0, limit: null, buffer: null, status: "na" };
  }

  // ── Consistency (no single day > pct of total profit) ──
  let consistency: RuleReadout;
  if (profile.consistencyPct != null) {
    const totalProfit = Math.max(0, state.realizedBalance - profile.startingBalance);
    const ratio = totalProfit > 0 ? state.maxDayProfit / totalProfit : 0;
    consistency = {
      label:  "Consistency",
      value:  round4(ratio),
      limit:  profile.consistencyPct,
      buffer: round4(profile.consistencyPct - ratio),
      // informational: a breach blocks payout, it does not bust the account
      status: totalProfit <= 0 ? "na" : ratio > profile.consistencyPct ? "caution" : "safe",
    };
  } else {
    consistency = { label: "Consistency", value: 0, limit: null, buffer: null, status: "na" };
  }

  const status = worst(trailing.status, daily.status);

  return {
    equity:            round2(equity),
    floor:             round2(floor),
    peak:              round2(state.peakEquity),
    target:            targetAbs != null ? round2(targetAbs) : null,
    bindingBuffer:     round2(bindingBuffer),
    bindingBufferFrac: round4(bindingFrac),
    bindingRule,
    targetProgress:    targetProgress != null ? round4(targetProgress) : null,
    accountSeverity,
    status,
    rules: { trailing, daily, target, consistency },
    nextEquityState:   state,
    profile: { firm: profile.firm, planLabel: profile.planLabel, verifiedOn: profile.verifiedOn },
  };
}
