/**
 * lib/rules/types.ts
 *
 * Value Layer v1 — Prop-Rule Rail types.
 *
 * RAIL is account-survival math: deterministic evaluation of a trader's hard
 * firm limits (trailing/static drawdown, daily loss, profit target, consistency)
 * against live equity. No inference, no analytics — just arithmetic on known
 * numbers, which is why it is the trust anchor of the product.
 */

export type DrawdownType = "trailing_intraday" | "trailing_eod" | "static";

/** The effective rule profile bound to one (user, account). Mirrors account_rules. */
export interface RuleProfile {
  firm:             string;
  planLabel:        string;
  sourcePresetId:   string | null;
  startingBalance:  number;
  profitTarget:     number | null;
  maxDrawdown:      number;
  drawdownType:     DrawdownType;
  drawdownLockAt:   number | null;   // peak equity at which the floor stops trailing
  drawdownLockTo:   number | null;   // the locked floor value (e.g. starting balance)
  dailyLossLimit:   number | null;
  consistencyPct:   number | null;   // e.g. 0.30
  minTradingDays:   number | null;
  contractLimit:    number | null;
  verifiedOn:       string | null;   // ISO date the numbers were confirmed
}

/** A firm/plan catalog entry. Mirrors rule_presets. */
export interface RulePreset extends RuleProfile {
  id:           string;
  accountSize:  number;
  sourceUrl:    string | null;
  active:       boolean;
}

/** Persisted running survival state. Mirrors account_equity_state. */
export interface EquityState {
  realizedBalance:  number;          // starting + Σ realized pnl
  openPnl:          number;          // unrealized of open positions (0 until broker tick wired)
  peakEquity:       number;          // running max per drawdown_type
  floorLocked:      boolean;
  dayKey:           string | null;   // CME session day the day_* fields refer to
  dayStartBalance:  number;
  dayRealizedPnl:   number;
  maxDayProfit:     number;          // best single-day profit (consistency rule)
  updatedAt:        string;
}

/** Inputs for one equity tick (from the pipeline / dashboard). */
export interface EquityTick {
  realizedBalance: number;           // starting + Σ realized pnl (authoritative)
  openPnl?:        number;           // unrealized; default 0
  dayKey:          string;           // current CME session day key (e.g. "2026-06-17")
  dayRealizedPnl:  number;           // realized pnl since this session day's open
  now?:            number;
}

/** Per-rule readout. `buffer` = distance (in account currency) before violation. */
export interface RuleReadout {
  label:   string;
  value:   number;          // current measured value (equity, day pnl, profit, ratio×100…)
  limit:   number | null;   // the threshold (null = rule not in this plan)
  buffer:  number | null;   // headroom before violation (null = N/A)
  status:  RailStatus;
}

export type RailStatus = "safe" | "caution" | "danger" | "violated" | "na";
export type Heartbeat  = "CALM" | "ELEVATED" | "AGITATED" | "CRITICAL";

/** The computed RAIL snapshot handed to the UI (and fed into Heartbeat). */
export interface RailState {
  equity:           number;
  floor:            number;          // BUST line
  peak:             number;
  target:           number | null;   // PASS line (absolute balance)
  bindingBuffer:    number;          // the number on the Rail = min(trailing, daily)
  bindingBufferFrac: number;         // 0–1 of the binding limit (drives gauge + heartbeat)
  bindingRule:      "trailing" | "daily";
  targetProgress:   number | null;   // 0–1 toward profit target
  accountSeverity:  number;          // 0–1; 1 = at the wall (feeds Heartbeat)
  status:           RailStatus;
  rules: {
    trailing:    RuleReadout;
    daily:       RuleReadout;
    target:      RuleReadout;
    consistency: RuleReadout;
  };
  nextEquityState:  EquityState;     // persist this back (peak/lock/day advanced)
  profile: {
    firm:       string;
    planLabel:  string;
    verifiedOn: string | null;
  };
}
