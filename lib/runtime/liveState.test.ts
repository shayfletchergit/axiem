/**
 * lib/runtime/liveState.test.ts
 *
 * Value Layer v1 — live open-P&L pipeline tests. Plain assertions, no framework.
 * Run with:  npx tsx lib/runtime/liveState.test.ts
 *
 * This file imports ONLY the in-memory layer + pure compute (no DB). It passing
 * with no Supabase env present is itself proof the tick path is DB-free.
 *
 * Coverage
 * ────────
 *   L1  hydrate → full buffer at flat open P&L
 *   L2  open P&L tick moves the buffer in-process (intraday trailing)
 *   L3  250ms batcher = latest-wins (N ticks → 1 drained state; re-drain empty)
 *   L4  realized change (trade close) updates equity instantly
 *   L5  computeOpenPnl is pure & correct (skips unknown marks)
 *   L6  normalizePositionEvent shape
 */

import { hydrate, applyTick, drainDirty, getRail, clearEntry } from "./liveState";
import { computeOpenPnl, normalizePositionEvent } from "@/lib/broker/positions";
import type { RuleProfile } from "@/lib/rules/types";

let passed = 0, failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

const APEX_50K: RuleProfile = {
  firm: "Apex", planLabel: "50K", sourcePresetId: "apex_50k",
  startingBalance: 50000, profitTarget: 3000, maxDrawdown: 2500,
  drawdownType: "trailing_intraday", drawdownLockAt: 52500, drawdownLockTo: 50000,
  dailyLossLimit: null, consistencyPct: 0.30, minTradingDays: 1, contractLimit: 10,
  verifiedOn: "2026-06-01",
};
const U = "user-1", A = "APEX-A", DAY = "2026-06-17";

function fresh() {
  clearEntry(U, A);
  return hydrate({
    userId: U, accountId: A, profile: APEX_50K,
    realizedBalance: 50000, dayRealizedPnl: 0, dayKey: DAY, prevEquityState: null,
  });
}

// L1 — hydrate
{
  const r = fresh();
  assert("L1 floor", near(r.floor, 47500), `floor=${r.floor}`);
  assert("L1 buffer full", near(r.bindingBuffer, 2500), `buf=${r.bindingBuffer}`);
  assert("L1 severity 0", r.accountSeverity === 0);
}

// L2 — open P&L tick moves the buffer (no DB)
{
  fresh();
  const r = applyTick(U, A, { openPnl: -2400, dayKey: DAY, now: 1 })!;
  assert("L2 equity reflects open", near(r.equity, 47600), `eq=${r.equity}`);
  assert("L2 buffer shrank", near(r.bindingBuffer, 100), `buf=${r.bindingBuffer}`);
  assert("L2 status danger", r.status === "danger", `status=${r.status}`);
  assert("L2 severity high", near(r.accountSeverity, 0.96), `sev=${r.accountSeverity}`);
  // recovery
  const r2 = applyTick(U, A, { openPnl: 0, dayKey: DAY, now: 2 })!;
  assert("L2 buffer recovers", near(r2.bindingBuffer, 2500), `buf=${r2.bindingBuffer}`);
}

// L3 — latest-wins batching
{
  fresh();
  drainDirty(); // clear the hydrate dirty flag
  applyTick(U, A, { openPnl: -100, dayKey: DAY, now: 10 });
  applyTick(U, A, { openPnl: -500, dayKey: DAY, now: 11 });
  applyTick(U, A, { openPnl: -900, dayKey: DAY, now: 12 });
  const drained = drainDirty();
  assert("L3 one entry per key", drained.length === 1, `len=${drained.length}`);
  assert("L3 latest wins", near(drained[0].rail.equity, 49100), `eq=${drained[0].rail.equity}`);
  assert("L3 re-drain empty", drainDirty().length === 0);
}

// L4 — realized change (trade closes) updates equity instantly
{
  fresh();
  const r = applyTick(U, A, { dayRealizedPnl: 300, openPnl: 0, dayKey: DAY, now: 20 })!;
  assert("L4 realized moved equity", near(r.equity, 50300), `eq=${r.equity}`);
  assert("L4 getRail matches", near(getRail(U, A)!.equity, 50300));
  clearEntry(U, A);
}

// L5 — computeOpenPnl pure
{
  const { openPnl, positions } = computeOpenPnl(
    [
      { symbol: "ESM6", netQty: 2,  avgEntryPrice: 5000 },
      { symbol: "NQM6", netQty: -1, avgEntryPrice: 18000 },
      { symbol: "CLM6", netQty: 1,  avgEntryPrice: 75 },   // no mark → skipped
    ],
    { ESM6: 5002, NQM6: 18001 },
    { ESM6: 50, NQM6: 20 },
  );
  // ES: 2 × (5002−5000) × 50 = +200 ; NQ: −1 × (18001−18000) × 20 = −20
  assert("L5 openPnl", near(openPnl, 180), `pnl=${openPnl}`);
  assert("L5 skips unknown mark", positions.length === 2, `n=${positions.length}`);
}

// L6 — normalized event
{
  const ev = normalizePositionEvent("APEX-A",
    [{ symbol: "ESM6", netQty: 1, avgEntryPrice: 5000 }],
    { ESM6: 5004 }, { pointValues: { ESM6: 50 }, dayRealizedPnl: 120, timestamp: 99 });
  assert("L6 accountId", ev.accountId === "APEX-A");
  assert("L6 openPnl", near(ev.openPnl, 200), `pnl=${ev.openPnl}`);
  assert("L6 carries dayRealized", ev.dayRealizedPnl === 120);
  assert("L6 timestamp", ev.timestamp === 99);
}

console.log(`\nliveState.test.ts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
