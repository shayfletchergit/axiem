/**
 * lib/agame/compute.test.ts
 *
 * Phase 1 — A-Game feature + baseline tests. Plain assertions, no framework.
 * Run with:  npx tsx lib/agame/compute.test.ts
 *
 * Coverage
 * ────────
 *   ST   stats: median / quantile / iqr
 *   F1   per-session feature computation (pace, size, burst, post-loss, outcome)
 *   A1   calibrating gate (< 12 eligible → no baseline values)
 *   A2   baseline uses TOP sessions only (median of best, not of all)
 *   A3   median-not-mean rule
 *   A4   determinism under shuffle
 *   A5   ineligible / null-expectancy sessions excluded
 *   D1   deviation: signed fractions; calibrating → nulls
 */

import { median, iqr, quantile } from "./stats";
import { computeSessionFeatures } from "@/lib/sessions/features";
import { computeAgameBaseline } from "./compute";
import { computeDeviation } from "./deviation";
import type { SessionForAgame } from "./types";
import type { SessionTrade } from "@/lib/sessions/types";

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✓  ${m}`); passed++; } else { console.error(`  ✗  ${m}`); failed++; }
}
function run(name: string, fn: () => void): void { console.log(`\n── ${name}`); fn(); }

const BASE = Date.UTC(2025, 5, 3, 14, 0, 0);
const iso = (sec: number) => new Date(BASE + sec * 1000).toISOString();

let _id = 0;
function tr(o: { open: number; close: number | null; size: number; pnl: number | null; status?: "ok" | "skipped"; inst?: string }): SessionTrade {
  _id += 1;
  return {
    id: `t-${_id}`,
    account_id: "ACC",
    instrument: o.inst ?? "ES",
    opened_at: iso(o.open),
    closed_at: o.close === null ? null : iso(o.close),
    max_size: o.size,
    net_pnl: o.pnl,
    direction: "long",
    reconstruction_status: o.status ?? "ok",
  };
}

// ── ST ───────────────────────────────────────────────────────────────────────
run("ST stats", () => {
  assert(median([1, 2, 3, 4]) === 2.5, "median of 4 = 2.5");
  assert(median([5, 1, 3]) === 3, "median of 3 = 3");
  assert(quantile([1, 2, 3, 4, 5], 0.25) === 2, "Q1 = 2");
  assert(iqr([1, 2, 3, 4, 5]) === 2, "IQR = Q3−Q1 = 4−2 = 2");
});

// ── F1 ───────────────────────────────────────────────────────────────────────
run("F1 per-session feature computation", () => {
  const { feature_vector: fv, outcome: oc } = computeSessionFeatures([
    tr({ open: 0,   close: 60,  size: 2, pnl: 100 }), // win
    tr({ open: 300, close: 360, size: 2, pnl: -50 }), // loss
    tr({ open: 420, close: 480, size: 4, pnl: 20 }),  // post-loss: +60s delay, 2x size
    tr({ open: 600, close: 660, size: 2, pnl: 10 }),  // win
  ]);
  assert(fv.trade_count === 4, "trade_count = 4");
  assert(fv.median_inter_trade_gap_seconds === 180, "median entry gap = 180s (gaps 300,120,180)");
  assert(fv.mean_inter_trade_gap_seconds === 200, "mean entry gap = 200s");
  assert(fv.median_position_size === 2, "median size = 2");
  assert(fv.mean_position_size === 2.5, "mean size = 2.5");
  assert(fv.size_variance === 0.75, "size variance = 0.75");
  assert(Math.abs((fv.entry_burst_ratio ?? 0) - 1 / 3) < 1e-3, "burst ratio ≈ 0.333 (1 of 3 gaps ≤120s)");
  assert(fv.post_loss_trade_delay_seconds === 60, "post-loss delay = 60s");
  assert(fv.post_loss_size_change_ratio === 2, "post-loss size ratio = 2x");
  assert(fv.session_duration_seconds === 660, "duration = 660s");
  assert(oc.net_pnl === 80, "net_pnl = 80");
  assert(oc.expectancy === 20, "expectancy = net_pnl/trade_count = 80/4 = 20");
  assert(oc.win_rate === 0.75, "win_rate = 3/4");
});

// ── A-Game fixtures ────────────────────────────────────────────────────────────
let _sk = 0;
function session(opts: { expectancy: number | null; tradeCount: number; pace: number; size: number; durMin: number; eligible?: boolean }): SessionForAgame {
  _sk += 1;
  const hasFeat = true;
  return {
    key: `s-${String(_sk).padStart(3, "0")}`,
    eligible_for_analysis: opts.eligible ?? true,
    feature_vector: hasFeat ? {
      trade_count: opts.tradeCount,
      session_duration_seconds: opts.durMin * 60,
      median_inter_trade_gap_seconds: opts.pace,
      mean_inter_trade_gap_seconds: opts.pace,
      median_position_size: opts.size,
      mean_position_size: opts.size,
      size_variance: 0.5,
      entry_burst_ratio: 0.2,
      post_loss_trade_delay_seconds: 120,
      post_loss_size_change_ratio: 1,
      instrument_count: 1,
    } : null,
    outcome: {
      net_pnl: (opts.expectancy ?? 0) * opts.tradeCount,
      net_pnl_adj: (opts.expectancy ?? 0) * opts.tradeCount,
      trade_count: opts.tradeCount,
      pnl_trades: opts.tradeCount,
      wins: 0, losses: 0,
      win_rate: 0.6,
      expectancy: opts.expectancy,
    },
  };
}

// ── A1 ───────────────────────────────────────────────────────────────────────
run("A1 calibrating gate (<12 eligible)", () => {
  const eleven = Array.from({ length: 11 }, () => session({ expectancy: 50, tradeCount: 6, pace: 300, size: 2, durMin: 90 }));
  const b = computeAgameBaseline("u", "ACC", eleven);
  assert(b.status === "calibrating", "11 sessions → calibrating");
  assert(b.median_trade_count === null, "no baseline values while calibrating");
  assert(b.session_count === 11, "session_count reported");
});

// ── A2 + A3 ───────────────────────────────────────────────────────────────────
run("A2/A3 baseline = median of TOP sessions only", () => {
  // 4 A-game sessions (high expectancy, tight pace=300, size=2, count=6)
  const top = Array.from({ length: 4 }, () => session({ expectancy: 100, tradeCount: 6, pace: 300, size: 2, durMin: 90 }));
  // 8 poor sessions (low expectancy, fast pace=60, size=5, count=20)
  const poor = Array.from({ length: 8 }, () => session({ expectancy: -20, tradeCount: 20, pace: 60, size: 5, durMin: 30 }));
  const b = computeAgameBaseline("u", "ACC", [...poor, ...top]);
  assert(b.status === "ready", "12 sessions → ready");
  assert(b.median_trade_count === 6, "median_trade_count reflects TOP sessions (6), not all (would be ~20)");
  assert(b.median_inter_trade_gap_seconds === 300, "pace reflects top sessions (300s)");
  assert(b.median_position_size === 2, "size reflects top sessions (2)");
  assert((b.median_expectancy ?? 0) === 100, "median expectancy = 100 (selection metric)");
});

// ── A4 ───────────────────────────────────────────────────────────────────────
run("A4 determinism under shuffle", () => {
  const ss = [
    ...Array.from({ length: 4 }, () => session({ expectancy: 100, tradeCount: 6, pace: 300, size: 2, durMin: 90 })),
    ...Array.from({ length: 8 }, () => session({ expectancy: -20, tradeCount: 20, pace: 60, size: 5, durMin: 30 })),
  ];
  const a = computeAgameBaseline("u", "ACC", ss);
  const shuffled = [...ss].reverse();
  const b = computeAgameBaseline("u", "ACC", shuffled);
  assert(JSON.stringify(a) === JSON.stringify(b), "same sessions → identical baseline regardless of order");
});

// ── A5 ───────────────────────────────────────────────────────────────────────
run("A5 ineligible / null-expectancy excluded", () => {
  const good = Array.from({ length: 12 }, () => session({ expectancy: 50, tradeCount: 6, pace: 300, size: 2, durMin: 90 }));
  const noisy = [
    ...good,
    session({ expectancy: null, tradeCount: 8, pace: 10, size: 99, durMin: 5 }),      // null expectancy
    session({ expectancy: 999, tradeCount: 1, pace: 1, size: 99, durMin: 1, eligible: false }), // ineligible
  ];
  const b = computeAgameBaseline("u", "ACC", noisy);
  assert(b.session_count === 12, "only the 12 eligible+valued sessions counted");
  assert(b.median_position_size === 2, "excluded sessions did not contaminate size");
});

// ── D1 ───────────────────────────────────────────────────────────────────────
run("D1 deviation signed fractions + calibrating nulls", () => {
  const ready = computeAgameBaseline("u", "ACC", [
    ...Array.from({ length: 4 }, () => session({ expectancy: 100, tradeCount: 10, pace: 300, size: 2, durMin: 90 })),
    ...Array.from({ length: 8 }, () => session({ expectancy: -20, tradeCount: 10, pace: 300, size: 2, durMin: 90 })),
  ]);
  const dev = computeDeviation(ready, {
    trade_count: 13,                       // +30% vs 10
    median_inter_trade_gap_seconds: 180,   // pace 40% faster → -40% vs 300
    median_position_size: 2,               // on baseline → 0
    session_duration_seconds: 90 * 60,     // on baseline → 0
  });
  assert(Math.abs((dev.trade_count ?? 0) - 0.3) < 1e-6, "trade_count +30%");
  assert(Math.abs((dev.pace ?? 0) + 0.4) < 1e-6, "pace -40%");
  assert(dev.size === 0, "size on baseline → 0%");

  const calibrating = computeAgameBaseline("u", "ACC", [session({ expectancy: 1, tradeCount: 5, pace: 1, size: 1, durMin: 1 })]);
  const devC = computeDeviation(calibrating, { trade_count: 5, median_inter_trade_gap_seconds: 1, median_position_size: 1, session_duration_seconds: 60 });
  assert(devC.trade_count === null && devC.pace === null, "calibrating → all deviations null");
});

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
