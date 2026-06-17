/**
 * lib/rules/rail.test.ts
 *
 * Value Layer v1 — RAIL engine tests. Plain assertions, no framework.
 * Run with:  npx tsx lib/rules/rail.test.ts
 *
 * Coverage
 * ────────
 *   R1  fresh state: floor = peak − drawdown, full buffer
 *   R2  trailing follows peak (buffer stays full while winning)
 *   R3  floor locks at breakeven once peak ≥ lock_at
 *   R4  drawdown after lock depletes buffer → caution/danger/severity
 *   R5  bust: buffer ≤ 0 → violated, severity 1
 *   R6  intraday trailing reacts to open (unrealized) P&L
 *   R7  daily loss is the binding constraint when tighter than trailing
 *   R8  static drawdown floor is fixed (never trails)
 *   R9  day rollover folds prior-day profit into max_day_profit
 *   H1  heartbeat ladder
 */

import { applyEquityTick, computeRail, heartbeatFromSeverity } from "./rail";
import type { RuleProfile, EquityState, EquityTick } from "./types";

let passed = 0, failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

// ── Profiles ──────────────────────────────────────────────────────────────────
const APEX_50K: RuleProfile = {
  firm: "Apex", planLabel: "50K", sourcePresetId: "apex_50k",
  startingBalance: 50000, profitTarget: 3000, maxDrawdown: 2500,
  drawdownType: "trailing_intraday", drawdownLockAt: 52500, drawdownLockTo: 50000,
  dailyLossLimit: null, consistencyPct: 0.30, minTradingDays: 1, contractLimit: 10,
  verifiedOn: "2026-06-01",
};
const TOPSTEP_50K: RuleProfile = {
  firm: "Topstep", planLabel: "50K", sourcePresetId: "topstep_50k",
  startingBalance: 50000, profitTarget: 3000, maxDrawdown: 2000,
  drawdownType: "trailing_eod", drawdownLockAt: 52000, drawdownLockTo: 50000,
  dailyLossLimit: 1000, consistencyPct: null, minTradingDays: 2, contractLimit: 5,
  verifiedOn: "2026-06-01",
};
const TRADEIFY_50K: RuleProfile = {
  firm: "Tradeify", planLabel: "50K Advanced", sourcePresetId: "tradeify_50k",
  startingBalance: 50000, profitTarget: 3000, maxDrawdown: 2000,
  drawdownType: "static", drawdownLockAt: null, drawdownLockTo: null,
  dailyLossLimit: 1250, consistencyPct: null, minTradingDays: 1, contractLimit: 5,
  verifiedOn: "2026-06-01",
};

const tick = (over: Partial<EquityTick>): EquityTick => ({
  realizedBalance: 50000, openPnl: 0, dayKey: "2026-06-17", dayRealizedPnl: 0, now: 0, ...over,
});

// R1 — fresh
{
  const s = applyEquityTick(APEX_50K, null, tick({}));
  const r = computeRail(APEX_50K, s);
  assert("R1 floor", near(r.floor, 47500), `floor=${r.floor}`);
  assert("R1 buffer", near(r.bindingBuffer, 2500), `buf=${r.bindingBuffer}`);
  assert("R1 severity", r.accountSeverity === 0, `sev=${r.accountSeverity}`);
  assert("R1 status", r.status === "safe");
  assert("R1 binding=trailing", r.bindingRule === "trailing");
}

// R2 — trailing follows peak
{
  const s = applyEquityTick(APEX_50K, null, tick({ realizedBalance: 51000, dayRealizedPnl: 1000 }));
  const r = computeRail(APEX_50K, s);
  assert("R2 peak", near(r.peak, 51000), `peak=${r.peak}`);
  assert("R2 floor trails", near(r.floor, 48500), `floor=${r.floor}`);
  assert("R2 buffer full", near(r.bindingBuffer, 2500), `buf=${r.bindingBuffer}`);
}

// R3 — lock at breakeven
{
  const s = applyEquityTick(APEX_50K, null, tick({ realizedBalance: 53000, dayRealizedPnl: 3000 }));
  const r = computeRail(APEX_50K, s);
  assert("R3 locked", s.floorLocked === true);
  assert("R3 floor=lock_to", near(r.floor, 50000), `floor=${r.floor}`);
  assert("R3 buffer", near(r.bindingBuffer, 3000), `buf=${r.bindingBuffer}`);
}

// R4 — drawdown after lock
{
  const locked = applyEquityTick(APEX_50K, null, tick({ realizedBalance: 53000, dayRealizedPnl: 3000 }));
  const s = applyEquityTick(APEX_50K, locked, tick({ realizedBalance: 50500, dayRealizedPnl: 500 }));
  const r = computeRail(APEX_50K, s);
  assert("R4 floor stays locked", near(r.floor, 50000), `floor=${r.floor}`);
  assert("R4 buffer", near(r.bindingBuffer, 500), `buf=${r.bindingBuffer}`);
  assert("R4 frac", near(r.bindingBufferFrac, 0.2), `frac=${r.bindingBufferFrac}`);
  assert("R4 status caution", r.status === "caution", `status=${r.status}`);
  assert("R4 severity", near(r.accountSeverity, 0.8), `sev=${r.accountSeverity}`);
}

// R5 — bust
{
  const locked = applyEquityTick(APEX_50K, null, tick({ realizedBalance: 53000, dayRealizedPnl: 3000 }));
  const s = applyEquityTick(APEX_50K, locked, tick({ realizedBalance: 49900, dayRealizedPnl: -100 }));
  const r = computeRail(APEX_50K, s);
  assert("R5 violated", r.status === "violated", `status=${r.status}`);
  assert("R5 severity 1", r.accountSeverity === 1, `sev=${r.accountSeverity}`);
  assert("R5 buffer negative", r.bindingBuffer < 0, `buf=${r.bindingBuffer}`);
}

// R6 — intraday open P&L moves the buffer
{
  const s = applyEquityTick(APEX_50K, null, tick({ realizedBalance: 50000, openPnl: -2400, dayRealizedPnl: 0 }));
  const r = computeRail(APEX_50K, s);
  assert("R6 equity incl open", near(r.equity, 47600), `eq=${r.equity}`);
  assert("R6 buffer", near(r.bindingBuffer, 100), `buf=${r.bindingBuffer}`);
  assert("R6 danger", r.status === "danger", `status=${r.status}`);
}

// R7 — daily binding
{
  const s = applyEquityTick(TOPSTEP_50K, null, tick({ realizedBalance: 49100, dayRealizedPnl: -900 }));
  const r = computeRail(TOPSTEP_50K, s);
  assert("R7 daily buffer", near(r.rules.daily.buffer ?? -1, 100), `buf=${r.rules.daily.buffer}`);
  assert("R7 binding=daily", r.bindingRule === "daily", `binding=${r.bindingRule}`);
  assert("R7 severity 0.9", near(r.accountSeverity, 0.9), `sev=${r.accountSeverity}`);
  assert("R7 heartbeat CRITICAL", heartbeatFromSeverity(r.accountSeverity) === "CRITICAL");
}

// R8 — static floor never trails
{
  const s = applyEquityTick(TRADEIFY_50K, null, tick({ realizedBalance: 53000, dayRealizedPnl: 3000 }));
  const r = computeRail(TRADEIFY_50K, s);
  assert("R8 static floor", near(r.floor, 48000), `floor=${r.floor}`); // 50000 − 2000
  assert("R8 buffer grows", near(r.rules.trailing.buffer ?? 0, 5000), `buf=${r.rules.trailing.buffer}`);
}

// R9 — day rollover
{
  const day1 = applyEquityTick(APEX_50K, null, tick({ realizedBalance: 50800, dayRealizedPnl: 800 }));
  const day2 = applyEquityTick(APEX_50K, day1, tick({ realizedBalance: 50800, dayRealizedPnl: 0, dayKey: "2026-06-18" }));
  assert("R9 maxDayProfit folded", near(day2.maxDayProfit, 800), `max=${day2.maxDayProfit}`);
  assert("R9 dayStart advanced", near(day2.dayStartBalance, 50800), `start=${day2.dayStartBalance}`);
  assert("R9 dayKey advanced", day2.dayKey === "2026-06-18");
}

// H1 — heartbeat ladder
{
  assert("H1 calm", heartbeatFromSeverity(0.1) === "CALM");
  assert("H1 elevated", heartbeatFromSeverity(0.4) === "ELEVATED");
  assert("H1 agitated", heartbeatFromSeverity(0.7) === "AGITATED");
  assert("H1 critical", heartbeatFromSeverity(0.95) === "CRITICAL");
}

console.log(`\nrail.test.ts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
