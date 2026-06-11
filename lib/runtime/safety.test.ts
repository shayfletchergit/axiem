/**
 * lib/runtime/safety.test.ts
 *
 * Phase 2.6 — production safety + reliability tests. Plain assertions, no framework.
 * Run with:  npx tsx lib/runtime/safety.test.ts
 *
 * Coverage
 * ────────
 *   S1  NaN injection → INVALID (data nulled)
 *   S2  stale (30–120s) → DEGRADED (data kept, flagged)
 *   S3  disconnect → UNKNOWN
 *   S4  duplicate event → ignored via watermark
 *   S5  recompute success → watermark advances (unit + orchestrator)
 *   S6  partial pipeline failure → DEGRADED (no silent stale numbers)
 *   S7  dashboard contract ALWAYS returns safety + system + confidence
 *   S8  duplicate fill end-to-end → ignored, single recompute
 *   S9  baseline missing / feature_vector missing → INVALID
 */

import { classifySafety, wrapSafe } from "./safetyGuard";
import { WatermarkTracker } from "./watermark";
import { buildDashboardSnapshot } from "./dashboardContract";
import { RuntimeOrchestrator, type Pipeline, type Scheduler } from "./orchestrator";
import { resetRuntimeMetrics, getRuntimeMetrics } from "./observability";
import type { TrustedLiveReport } from "@/lib/agame/trust";
import type { SystemState } from "./systemState";
import type { FillEvent } from "./transportAdapter";

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✓  ${m}`); passed++; } else { console.error(`  ✗  ${m}`); failed++; }
}
function run(name: string, fn: () => Promise<void> | void) { console.log(`\n── ${name}`); return fn(); }

// ── fixtures ──────────────────────────────────────────────────────────────────
function report(over: Partial<TrustedLiveReport> = {}): TrustedLiveReport {
  return {
    session_id: "S1", system_state: "LIVE", message: null,
    data_freshness: { is_stale: false, last_update_ms: 0, age_seconds: 0, source: "live" },
    confidence: { baseline_strength: "HIGH", sample_size: 80, session_count: 80, stability_score: 0.9 },
    deviations: { trade_count: 0.1, pace: -0.1, size: 0.05, duration: 0.0 },
    flags: { overtrading: false, speed_escalation: false, size_escalation: false, session_drift: false },
    signal_quality_map: { trade_count: "STRONG", pace: "STRONG", size: "STRONG", duration: "STRONG", overall: "STRONG" },
    risk_score: 12,
    risk_context: { label: "composite behavioural deviation index", is_actionable: false, warning: null },
    interpretation: ["x"],
    baseline_reference: { median_trade_count: 10, median_inter_trade_gap_seconds: 300, median_position_size: 2, median_session_duration_minutes: 90 },
    computed_at: "2025-01-01T00:00:00Z",
    ...over,
  };
}
const ctx = (over: Partial<{ connected: boolean; systemState: SystemState; partial: boolean }> = {}) =>
  ({ connected: true, systemState: "LIVE" as SystemState, ...over });

async function main(): Promise<void> {

// ── S1 ───────────────────────────────────────────────────────────────────────
await run("S1 NaN injection → INVALID", () => {
  const r = report({ deviations: { trade_count: NaN, pace: 0, size: 0, duration: 0 } });
  const safe = wrapSafe(r, ctx());
  assert(safe.safety === "INVALID", "NaN deviation → INVALID");
  assert(safe.data === null, "INVALID nulls the data (no corrupt numbers to UI)");
  assert((safe.reason ?? "").includes("non-finite"), "reason explains non-finite");
  const inf = wrapSafe(report({ deviations: { trade_count: Infinity, pace: 0, size: 0, duration: 0 } }), ctx());
  assert(inf.safety === "INVALID", "Infinity deviation → INVALID");
});

// ── S2 ───────────────────────────────────────────────────────────────────────
await run("S2 stale (30–120s) → DEGRADED", () => {
  const r = report({ data_freshness: { is_stale: true, last_update_ms: 0, age_seconds: 60, source: "cached" } });
  const safe = wrapSafe(r, ctx());
  assert(safe.safety === "DEGRADED", "age 60s → DEGRADED");
  assert(safe.data !== null, "DEGRADED keeps (flagged) data");
});

// ── S3 ───────────────────────────────────────────────────────────────────────
await run("S3 disconnect → UNKNOWN", () => {
  const safe = wrapSafe(report(), ctx({ connected: false, systemState: "DISCONNECTED" }));
  assert(safe.safety === "UNKNOWN", "disconnected → UNKNOWN");
  assert(safe.data === null, "UNKNOWN nulls the data (no silent stale numbers)");
});

// ── S4 ───────────────────────────────────────────────────────────────────────
await run("S4 duplicate event → ignored via watermark", () => {
  const wm = new WatermarkTracker();
  const k = "u:ACC";
  assert(wm.isNewEvent(k, "E1") === true, "first sighting is new");
  assert(wm.accept(k, "E1", 1) === true, "first accept succeeds");
  assert(wm.isNewEvent(k, "E1") === false, "staged event no longer new");
  assert(wm.accept(k, "E1", 1) === false, "duplicate accept rejected");
  wm.commit(k);
  assert(wm.isNewEvent(k, "E1") === false, "committed event stays not-new (replay ignored)");
});

// ── S5 ───────────────────────────────────────────────────────────────────────
await run("S5 recompute success → watermark advances", () => {
  const wm = new WatermarkTracker();
  const k = "u:ACC";
  wm.accept(k, "E7", 700);
  wm.commit(k);
  const w = wm.getWatermark(k);
  assert(w.lastProcessedEventId === "E7", "watermark advanced to committed event");
  assert(w.lastProcessedTimestamp === 700, "timestamp recorded");
});

// ── S6 ───────────────────────────────────────────────────────────────────────
await run("S6 partial pipeline failure → DEGRADED (no silent stale)", async () => {
  resetRuntimeMetrics();
  let clock = 0;
  let throwOnReport = false;
  const REPORT = report();
  const pipeline: Pipeline = {
    async rebuildSessionFeatures() {},
    async computeAgameBaseline() {},
    async computeTrustedLiveReport() { if (throwOnReport) throw new Error("boom"); return REPORT; },
  };
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => clock });

  orch.onFill(fill(0, "E1")); runDue(); await orch.drain();
  assert(orch.getSafeReport("u1", "ACC-A", clock).safety === "OK", "healthy recompute → OK");

  throwOnReport = true;
  orch.onFill(fill(1, "E2")); runDue(); await orch.drain();
  const safe = orch.getSafeReport("u1", "ACC-A", clock);
  assert(safe.safety === "DEGRADED", "partial failure → DEGRADED");
  assert(getRuntimeMetrics().recomputeFailures === 1, "failure counted in observability");
});

// ── S7 ───────────────────────────────────────────────────────────────────────
await run("S7 dashboard contract ALWAYS carries safety + system + confidence", () => {
  const nullSnap = buildDashboardSnapshot({ report: null, systemState: "DISCONNECTED", connected: false });
  assert(nullSnap.system.safety === "UNKNOWN", "null report → UNKNOWN safety present");
  assert(nullSnap.behaviour.safety === "UNKNOWN", "behaviour carries safety even when null");
  assert(typeof nullSnap.system.staleness === "number", "staleness always a number");
  assert(typeof nullSnap.confidence.baseline === "number" && typeof nullSnap.confidence.dataQuality === "number", "confidence always present");
  assert(nullSnap.behaviour.data === null, "null/unknown → no data leaked");

  const okSnap = buildDashboardSnapshot({ report: report(), systemState: "LIVE", connected: true });
  assert(okSnap.system.safety === "OK", "valid live → OK");
  assert(okSnap.behaviour.safety === "OK" && okSnap.behaviour.data !== null, "OK exposes safety-wrapped data");
  assert(okSnap.confidence.trust === 1, "trust confidence 1 when OK");

  const dbg = buildDashboardSnapshot({ report: report(), systemState: "LIVE", connected: true, includeDebug: true, metrics: getRuntimeMetrics(), watermark: { lastProcessedEventId: "E1", lastProcessedTimestamp: 1 } });
  assert(dbg.debug?.watermark === "E1", "debug includes watermark when requested");
});

// ── S8 ───────────────────────────────────────────────────────────────────────
await run("S8 duplicate fill end-to-end → ignored, single recompute", async () => {
  resetRuntimeMetrics();
  const calls = { report: 0 };
  const pipeline: Pipeline = {
    async rebuildSessionFeatures() {},
    async computeAgameBaseline() {},
    async computeTrustedLiveReport() { calls.report++; return report(); },
  };
  const { scheduler, runDue } = makeScheduler();
  const orch = new RuntimeOrchestrator({ pipeline, scheduler, now: () => 0 });

  orch.onFill(fill(0, "DUP")); orch.onFill(fill(0, "DUP")); // same eventId twice
  runDue(); await orch.drain();
  assert(getRuntimeMetrics().duplicatesIgnored === 1, "duplicate fill ignored by watermark");
  assert(calls.report === 1, "single recompute despite duplicate");
  assert(orch.getWatermarkState("u1", "ACC-A").lastProcessedEventId === "DUP", "watermark committed the event");
});

// ── S9 ───────────────────────────────────────────────────────────────────────
await run("S9 missing baseline / features → INVALID", () => {
  const noBaseline = wrapSafe(report({ baseline_reference: null }), ctx());
  assert(noBaseline.safety === "INVALID", "active session, no baseline → INVALID");

  const noFeatures = wrapSafe(report({ deviations: { trade_count: null, pace: null, size: null, duration: null } }), ctx());
  assert(noFeatures.safety === "INVALID", "active session, all deviations null → INVALID (features missing)");

  // calibrating legitimately has no baseline → DEGRADED, not INVALID
  const calibrating = wrapSafe(
    report({ baseline_reference: null, deviations: { trade_count: null, pace: null, size: null, duration: null }, system_state: "CALIBRATING" }),
    ctx({ systemState: "CALIBRATING" }),
  );
  assert(calibrating.safety === "DEGRADED", "calibrating (no baseline) → DEGRADED, not INVALID");
});

// ── classify direct sanity ─────────────────────────────────────────────────────
await run("classify direct sanity", () => {
  assert(classifySafety(report(), ctx()).safety === "OK", "clean LIVE → OK");
  assert(classifySafety(report(), ctx({ systemState: "REBUILDING" })).safety === "DEGRADED", "REBUILDING → DEGRADED");
  assert(classifySafety(report({ confidence: { baseline_strength: "LOW", sample_size: 5, session_count: 5, stability_score: 0.4 } }), ctx()).safety === "DEGRADED", "LOW confidence → DEGRADED");
});

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

}

// ── shared test helpers ────────────────────────────────────────────────────────
function makeScheduler() {
  const items = new Map<number, () => void>();
  let id = 0;
  const scheduler: Scheduler = {
    set: (fn) => { const i = ++id; items.set(i, fn); return i; },
    clear: (h) => { items.delete(h as number); },
  };
  return { scheduler, runDue: () => { const fns = [...items.values()]; items.clear(); fns.forEach((f) => f()); } };
}
function fill(ts: number, eventId?: string): FillEvent {
  return { userId: "u1", accountId: "ACC-A", ts, eventId, sessionId: "S1" };
}

void main();
