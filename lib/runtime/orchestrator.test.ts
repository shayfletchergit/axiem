/**
 * lib/runtime/orchestrator.test.ts
 *
 * Phase 2.5 — orchestration tests. Plain assertions, no framework.
 * Run with:  npx tsx lib/runtime/orchestrator.test.ts
 *
 * The pipeline is injected as mock black boxes; we assert HOW and WHEN the
 * orchestrator calls them — never any analytics value (it computes none).
 *
 * Coverage
 * ────────
 *   O1  fill burst → exactly ONE recompute
 *   O2  debounce → recompute only after the window fires
 *   O3  disconnect → state DISCONNECTED immediately
 *   O4  staleness → STALE at ≥30s, DISCONNECTED at ≥300s (time travel)
 *   O5  idempotency → output is the black-box report, unmodified
 *   O6  no double counting → fills during a recompute cause exactly one more
 *   O7  state transitions → LIVE → REBUILDING → LIVE
 *   O8  baseline only on first build + boundary; skipped mid-session; order kept
 */

import { RuntimeOrchestrator, type Pipeline, type Scheduler } from "./orchestrator";
import type { Transport, FillEvent } from "./transportAdapter";
import type { TrustedLiveReport } from "@/lib/agame/trust";

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✓  ${m}`); passed++; } else { console.error(`  ✗  ${m}`); failed++; }
}
function run(name: string, fn: () => Promise<void> | void): Promise<void> | void {
  console.log(`\n── ${name}`);
  return fn();
}

const USER = "u1", ACC = "ACC-A";

// ── canned black-box report (orchestrator must pass it through untouched) ─────
const REPORT: TrustedLiveReport = {
  session_id: "S1", system_state: "LIVE", message: null,
  data_freshness: { is_stale: false, last_update_ms: 0, age_seconds: 0, source: "live" },
  confidence: { baseline_strength: "HIGH", sample_size: 80, session_count: 80, stability_score: 0.9 },
  deviations: { trade_count: 0, pace: 0, size: 0, duration: 0 },
  flags: { overtrading: false, speed_escalation: false, size_escalation: false, session_drift: false },
  signal_quality_map: { trade_count: "STRONG", pace: "STRONG", size: "STRONG", duration: "STRONG", overall: "STRONG" },
  risk_score: 0,
  risk_context: { label: "composite behavioural deviation index", is_actionable: false, warning: null },
  interpretation: ["x"], baseline_reference: null, computed_at: "2025-01-01T00:00:00Z",
};

function makePipeline(gate?: Promise<void>) {
  const calls = { feat: 0, base: 0, report: 0, order: [] as string[] };
  const pipeline: Pipeline = {
    async rebuildSessionFeatures() { calls.feat++; calls.order.push("feat"); },
    async computeAgameBaseline() { calls.base++; calls.order.push("base"); },
    async computeTrustedLiveReport() {
      calls.report++; calls.order.push("report");
      if (gate) await gate;
      return REPORT;
    },
  };
  return { pipeline, calls };
}

// fake debounce timer: ignores ms; only the most recent survives clear/set
function makeScheduler() {
  const items = new Map<number, () => void>();
  let id = 0;
  const scheduler: Scheduler = {
    set: (fn) => { const i = ++id; items.set(i, fn); return i; },
    clear: (h) => { items.delete(h as number); },
  };
  return { scheduler, runDue: () => { const fns = [...items.values()]; items.clear(); fns.forEach((f) => f()); }, pending: () => items.size };
}

function makeTransport() {
  let fillCb: ((e: FillEvent) => void) | null = null;
  let discCb: (() => void) | null = null;
  let recCb: (() => void) | null = null;
  const transport: Transport = {
    onFill: (cb) => { fillCb = cb; return () => { fillCb = null; }; },
    onDisconnect: (cb) => { discCb = cb; return () => { discCb = null; }; },
    onReconnect: (cb) => { recCb = cb; return () => { recCb = null; }; },
  };
  return {
    transport,
    fill: (e: FillEvent) => fillCb?.(e),
    disconnect: () => discCb?.(),
    reconnect: () => recCb?.(),
  };
}

function fill(ts: number, sessionId?: string): FillEvent {
  return { userId: USER, accountId: ACC, ts, sessionId };
}

/** Flush the microtask + immediate-timer queue so a gated recompute parks at its gate. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function main(): Promise<void> {

// ── O1 ───────────────────────────────────────────────────────────────────────
await run("O1 fill burst → exactly ONE recompute", async () => {
  const { pipeline, calls } = makePipeline();
  const { scheduler, runDue, pending } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, debounceMs: 3000, now: () => 0 });

  for (let i = 0; i < 10; i++) orch.onFill(fill(i));
  assert(pending() === 1, "10 fills → only one armed timer (debounced)");
  runDue();
  await orch.drain();
  assert(calls.report === 1, "exactly one trusted-report recompute");
  assert(calls.feat === 1, "exactly one feature rebuild");
});

// ── O2 ───────────────────────────────────────────────────────────────────────
await run("O2 debounce → recompute only after window fires", async () => {
  const { pipeline, calls } = makePipeline();
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => 0 });

  orch.onFill(fill(1));
  assert(calls.report === 0, "no recompute before debounce fires");
  runDue();
  await orch.drain();
  assert(calls.report === 1, "recompute after debounce fires");
});

// ── O3 ───────────────────────────────────────────────────────────────────────
await run("O3 disconnect → DISCONNECTED immediately", async () => {
  const { pipeline } = makePipeline();
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => 0 });
  const t = makeTransport();
  orch.attach(t.transport);

  t.fill(fill(0)); runDue(); await orch.drain();
  assert(orch.getState(USER, ACC, 0) === "LIVE", "LIVE after a fresh recompute");
  t.disconnect();
  assert(orch.getState(USER, ACC, 0) === "DISCONNECTED", "DISCONNECTED immediately on transport drop");
});

// ── O4 ───────────────────────────────────────────────────────────────────────
await run("O4 staleness (time travel)", async () => {
  let clock = 0;
  const { pipeline } = makePipeline();
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => clock });

  orch.onFill(fill(0)); runDue(); await orch.drain();
  assert(orch.getState(USER, ACC, 0) === "LIVE", "fresh → LIVE");
  assert(orch.getState(USER, ACC, 31_000) === "STALE", "≥30s → STALE");
  assert(orch.getState(USER, ACC, 301_000) === "DISCONNECTED", "≥300s → DISCONNECTED");
});

// ── O5 ───────────────────────────────────────────────────────────────────────
await run("O5 idempotency → black-box report passed through unmodified", async () => {
  const { pipeline } = makePipeline();
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => 0 });

  orch.onFill(fill(0)); runDue(); await orch.drain();
  const r1 = orch.getReport(USER, ACC);
  orch.onFill(fill(1)); runDue(); await orch.drain();
  const r2 = orch.getReport(USER, ACC);
  assert(r1 === REPORT && r2 === REPORT, "stored report is the exact black-box object (no mutation/copy)");
  assert(JSON.stringify(r1) === JSON.stringify(r2), "identical output across recomputes");
});

// ── O6 ───────────────────────────────────────────────────────────────────────
await run("O6 no double counting (fills during a recompute)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { pipeline, calls } = makePipeline(gate);
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => 0 });

  orch.onFill(fill(0)); runDue();            // starts recompute…
  await tick();                              // …let it run up to the gated trusted-report call
  orch.onFill(fill(1)); orch.onFill(fill(2)); orch.onFill(fill(3)); // arrive mid-flight
  assert(calls.report === 1, "still exactly one recompute in flight");
  release(); await orch.drain();
  assert(calls.report === 1, "no extra recompute spawned mid-flight");
  runDue(); await orch.drain();              // the coalesced follow-up
  assert(calls.report === 2, "3 mid-flight fills → exactly ONE follow-up recompute");
});

// ── O7 ───────────────────────────────────────────────────────────────────────
await run("O7 state transitions LIVE → REBUILDING → LIVE", async () => {
  let clock = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { pipeline } = makePipeline(gate);
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => clock });

  orch.onFill(fill(0)); runDue();            // recompute begins, gated
  assert(orch.getState(USER, ACC, clock) === "REBUILDING", "REBUILDING while pipeline runs");
  release(); await orch.drain();
  assert(orch.getState(USER, ACC, clock) === "LIVE", "LIVE after recompute completes");
});

// ── O8 ───────────────────────────────────────────────────────────────────────
await run("O8 baseline conditional + step order", async () => {
  const { pipeline, calls } = makePipeline();
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => 0 });

  // first build → baseline computed; order feat→base→report
  orch.onFill(fill(0, "S1")); runDue(); await orch.drain();
  assert(calls.base === 1, "baseline computed on first build");
  assert(JSON.stringify(calls.order) === JSON.stringify(["feat", "base", "report"]), "order feat→base→report");

  // same session → baseline skipped; order feat→report
  calls.order.length = 0;
  orch.onFill(fill(1, "S1")); runDue(); await orch.drain();
  assert(calls.base === 1, "baseline NOT recomputed mid-session");
  assert(JSON.stringify(calls.order) === JSON.stringify(["feat", "report"]), "order feat→report (no baseline)");

  // new session id → boundary → baseline recomputed
  orch.onFill(fill(2, "S2")); runDue(); await orch.drain();
  assert(calls.base === 2, "baseline recomputed on session boundary");
});

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

}

void main();
