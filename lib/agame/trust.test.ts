/**
 * lib/agame/trust.test.ts
 *
 * Phase 2 — Trust Layer tests. Plain assertions, no framework.
 * Run with:  npx tsx lib/agame/trust.test.ts
 *
 * Coverage
 * ────────
 *   T1   CALIBRATING state (no baseline) — risk suppressed (null, not 0)
 *   T2   DISCONNECTED → stale detection, risk suppressed, frozen warning
 *   T3   LOW confidence suppresses STRONG signals
 *   T4   signal_quality transitions (HIGH/MEDIUM/LOW + null deviation)
 *   T5   risk_context never implies action (no imperatives, is_actionable false)
 *   T6   stale session does NOT change deviation logic (passthrough identical)
 *   T7   baseline strength classification (LOW/MEDIUM/HIGH + unstable override)
 *   T8   STALE keeps frozen numeric risk; DISCONNECTED/CALIBRATING null it
 */

import { applyTrustLayer } from "./trust";
import type { AgameBaselineCore, LiveDeviationReport } from "./types";

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✓  ${m}`); passed++; } else { console.error(`  ✗  ${m}`); failed++; }
}
function run(name: string, fn: () => void): void { console.log(`\n── ${name}`); fn(); }

const NOW = Date.parse("2025-06-03T16:00:00Z");

function baseline(over: Partial<AgameBaselineCore> = {}): AgameBaselineCore {
  return {
    user_id: "u", account_id: "ACC", status: "ready",
    session_count: 80, min_session_threshold: 12,
    confidence_score: 0.9, baseline_stability_score: 0.85, data_coverage_ratio: 0.95,
    avg_trade_count: 10, median_trade_count: 10, trade_count_iqr: 2,
    avg_inter_trade_gap_seconds: 300, median_inter_trade_gap_seconds: 300, pace_iqr: 60,
    avg_session_duration_minutes: 90, median_session_duration_minutes: 90,
    avg_position_size: 2, median_position_size: 2, size_variance: 0.5,
    post_loss_trade_delay_seconds: 120, post_loss_size_change_ratio: 1, entry_burst_ratio: 0.2,
    avg_expectancy: 50, median_expectancy: 50, win_rate: 0.6,
    ...over,
  };
}

function report(over: Partial<LiveDeviationReport> = {}): LiveDeviationReport {
  return {
    session_id: "sess-1",
    baseline_ready: true,
    deviations: { trade_count: 0.3, pace: -0.4, size: 0.2, duration: -0.1 },
    flags: { overtrading: false, speed_escalation: false, size_escalation: false, session_drift: false },
    risk_score: 27,
    interpretation: ["Trade frequency is 30% above A-Game baseline."],
    computed_at: new Date(NOW).toISOString(),
    ...over,
  };
}

// fresh runtime: connected, not rebuilding, snapshot just now
const fresh = { now: NOW, connected: true, rebuilding: false, last_update_ms: NOW };

// ── T1 ───────────────────────────────────────────────────────────────────────
run("T1 CALIBRATING — risk suppressed to null", () => {
  const calibratingReport = report({
    baseline_ready: false,
    deviations: { trade_count: null, pace: null, size: null, duration: null },
    risk_score: 0,
    interpretation: ["A-Game baseline is still calibrating; live comparison unavailable."],
  });
  const t = applyTrustLayer(calibratingReport, baseline({ status: "calibrating" }), fresh);
  assert(t.system_state === "CALIBRATING", "system_state CALIBRATING");
  assert(t.risk_score === null, "risk_score suppressed to null (NOT 0)");
  assert(t.message === "Insufficient data to establish A-Game baseline.", "calibrating message");
  assert(t.signal_quality_map.trade_count === "INSUFFICIENT_DATA", "signals INSUFFICIENT_DATA");
  assert(t.risk_context.is_actionable === false, "risk not actionable");
  assert(t.baseline_reference === null, "no baseline reference while calibrating");
});

// ── T2 ───────────────────────────────────────────────────────────────────────
run("T2 DISCONNECTED → stale + suppressed + frozen warning", () => {
  const t = applyTrustLayer(report(), baseline(), { ...fresh, connected: false });
  assert(t.system_state === "DISCONNECTED", "system_state DISCONNECTED");
  assert(t.data_freshness.is_stale === true, "is_stale true when disconnected");
  assert(t.risk_score === null, "risk_score suppressed on dead feed");
  assert((t.risk_context.warning ?? "").includes("frozen"), "warning mentions frozen values");
});

// ── T3 ───────────────────────────────────────────────────────────────────────
run("T3 LOW confidence suppresses STRONG", () => {
  // 15 sessions → LOW (below MEDIUM floor) → signals INSUFFICIENT_DATA, never STRONG
  const t = applyTrustLayer(report(), baseline({ session_count: 15 }), fresh);
  assert(t.confidence.baseline_strength === "LOW", "strength LOW (<20)");
  assert(t.signal_quality_map.trade_count !== "STRONG", "no STRONG signal on LOW confidence");
  assert(t.signal_quality_map.trade_count === "INSUFFICIENT_DATA", "below-threshold → INSUFFICIENT_DATA");
});

// ── T4 ───────────────────────────────────────────────────────────────────────
run("T4 signal_quality transitions", () => {
  const high = applyTrustLayer(report(), baseline({ session_count: 80, baseline_stability_score: 0.85 }), fresh);
  assert(high.signal_quality_map.trade_count === "STRONG", "HIGH conf → STRONG");

  const med = applyTrustLayer(report(), baseline({ session_count: 40, baseline_stability_score: 0.6 }), fresh);
  assert(med.signal_quality_map.trade_count === "WEAK", "MEDIUM conf → WEAK");

  const unstable = applyTrustLayer(report(), baseline({ session_count: 80, baseline_stability_score: 0.3 }), fresh);
  assert(unstable.confidence.baseline_strength === "LOW", "unstable → LOW even at 80 sessions");
  assert(unstable.signal_quality_map.trade_count === "WEAK", "unstable (≥20) → WEAK");

  const nullDev = applyTrustLayer(
    report({ deviations: { trade_count: null, pace: -0.4, size: 0.2, duration: -0.1 } }),
    baseline({ session_count: 80, baseline_stability_score: 0.85 }),
    fresh,
  );
  assert(nullDev.signal_quality_map.trade_count === "INSUFFICIENT_DATA", "null deviation → INSUFFICIENT_DATA");
  assert(nullDev.signal_quality_map.pace === "STRONG", "other signals unaffected");
});

// ── T5 ───────────────────────────────────────────────────────────────────────
run("T5 risk_context never implies action", () => {
  const states = [
    applyTrustLayer(report(), baseline(), fresh),
    applyTrustLayer(report(), baseline({ status: "calibrating" }), fresh),
    applyTrustLayer(report(), baseline(), { ...fresh, connected: false }),
    applyTrustLayer(report(), baseline({ session_count: 15 }), fresh),
  ];
  for (const t of states) {
    assert(t.risk_context.is_actionable === false, `is_actionable false (${t.system_state})`);
    assert(t.risk_context.label === "composite behavioural deviation index", `fixed non-authoritative label (${t.system_state})`);
    const w = (t.risk_context.warning ?? "").toLowerCase();
    assert(!/\b(stop|should|must|reduce|exit|don't|do not|sell|buy|cut)\b/.test(w), `no imperative in warning (${t.system_state})`);
  }
});

// ── T6 ───────────────────────────────────────────────────────────────────────
run("T6 stale session does not change deviation logic", () => {
  const r = report();
  const live  = applyTrustLayer(r, baseline(), fresh);
  const stale = applyTrustLayer(r, baseline(), { ...fresh, last_update_ms: NOW - 10 * 60 * 1000 }); // 10 min old
  assert(stale.system_state === "STALE", "old snapshot → STALE");
  assert(JSON.stringify(live.deviations) === JSON.stringify(stale.deviations), "deviations identical (passthrough, untouched)");
  assert(JSON.stringify(live.flags) === JSON.stringify(stale.flags), "flags identical (passthrough)");
});

// ── T7 ───────────────────────────────────────────────────────────────────────
run("T7 baseline strength classification", () => {
  const low = applyTrustLayer(report(), baseline({ session_count: 12, baseline_stability_score: 0.8 }), fresh);
  assert(low.confidence.baseline_strength === "LOW", "12 sessions → LOW");
  const med = applyTrustLayer(report(), baseline({ session_count: 35, baseline_stability_score: 0.6 }), fresh);
  assert(med.confidence.baseline_strength === "MEDIUM", "35 sessions stable → MEDIUM");
  const high = applyTrustLayer(report(), baseline({ session_count: 70, baseline_stability_score: 0.75 }), fresh);
  assert(high.confidence.baseline_strength === "HIGH", "70 sessions + stable → HIGH");
  const highButUnstable = applyTrustLayer(report(), baseline({ session_count: 70, baseline_stability_score: 0.4 }), fresh);
  assert(highButUnstable.confidence.baseline_strength === "LOW", "70 sessions but unstable → LOW");
});

// ── T8 ───────────────────────────────────────────────────────────────────────
run("T8 risk presentation by state", () => {
  const liveR = applyTrustLayer(report({ risk_score: 41 }), baseline(), fresh);
  assert(liveR.system_state === "LIVE" && liveR.risk_score === 41, "LIVE → numeric risk shown");

  const staleR = applyTrustLayer(report({ risk_score: 41 }), baseline(), { ...fresh, last_update_ms: NOW - 10 * 60 * 1000 });
  assert(staleR.system_state === "STALE" && staleR.risk_score === 41, "STALE → frozen numeric kept (with warning)");
  assert((staleR.risk_context.warning ?? "").includes("stale"), "stale warning present");

  const rebuildR = applyTrustLayer(report({ risk_score: 41 }), baseline(), { ...fresh, rebuilding: true });
  assert(rebuildR.system_state === "REBUILDING" && rebuildR.risk_score === 41, "REBUILDING → frozen numeric kept");
  assert(rebuildR.data_freshness.source === "cached", "rebuilding source = cached");
});

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
