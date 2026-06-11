/**
 * lib/agame/liveDeviation.test.ts
 *
 * Phase 1.5 — Live Behaviour Deviation Engine tests. Plain assertions, no framework.
 * Run with:  npx tsx lib/agame/liveDeviation.test.ts
 *
 * Coverage
 * ────────
 *   L1   deviation calculations
 *   L2   flags trigger correctly
 *   L3   flags stay off within range
 *   L4   boundary: baseline 0 / null → null deviation, no false flag
 *   L5   calibrating baseline → not ready, nulls, risk 0
 *   L6   no active session
 *   L7   active session with no materialised features
 *   L8   risk score is directional + deterministic
 *   L9   deterministic output (fixed now)
 *   L10  selectActiveSession (session switching)
 *   L11  interpretation is factual / non-prescriptive
 */

import { computeLiveDeviation, selectActiveSession } from "./liveDeviation";
import type { AgameBaselineCore, ActiveSessionInput } from "./types";
import type { SessionFeatureVector } from "@/lib/sessions/types";

let passed = 0, failed = 0;
function assert(c: boolean, m: string): void {
  if (c) { console.log(`  ✓  ${m}`); passed++; } else { console.error(`  ✗  ${m}`); failed++; }
}
function close(a: number | null, b: number, m: string, tol = 1e-6): void {
  assert(a != null && Math.abs(a - b) < tol, `${m} (got ${a})`);
}
function run(name: string, fn: () => void): void { console.log(`\n── ${name}`); fn(); }

const NOW = Date.parse("2025-06-03T16:00:00Z");

function baseline(over: Partial<AgameBaselineCore> = {}): AgameBaselineCore {
  return {
    user_id: "u", account_id: "ACC", status: "ready",
    session_count: 20, min_session_threshold: 12,
    confidence_score: 0.8, baseline_stability_score: 0.7, data_coverage_ratio: 0.9,
    avg_trade_count: 10, median_trade_count: 10, trade_count_iqr: 2,
    avg_inter_trade_gap_seconds: 300, median_inter_trade_gap_seconds: 300, pace_iqr: 60,
    avg_session_duration_minutes: 90, median_session_duration_minutes: 90,
    avg_position_size: 2, median_position_size: 2, size_variance: 0.5,
    post_loss_trade_delay_seconds: 120, post_loss_size_change_ratio: 1, entry_burst_ratio: 0.2,
    avg_expectancy: 50, median_expectancy: 50, win_rate: 0.6,
    ...over,
  };
}

function sess(fv: Partial<SessionFeatureVector> | null, over: Partial<ActiveSessionInput> = {}): ActiveSessionInput {
  const feature_vector = fv === null ? null : {
    trade_count: 10, session_duration_seconds: 90 * 60,
    median_inter_trade_gap_seconds: 300, mean_inter_trade_gap_seconds: 300,
    median_position_size: 2, mean_position_size: 2, size_variance: 0.5,
    entry_burst_ratio: 0.2, post_loss_trade_delay_seconds: 120,
    post_loss_size_change_ratio: 1, instrument_count: 1,
    ...fv,
  };
  return { session_id: "sess-1", status: "open", start_ts: "2025-06-03T14:00:00Z", feature_vector, ...over };
}

// ── L1 ───────────────────────────────────────────────────────────────────────
run("L1 deviation calculations", () => {
  const r = computeLiveDeviation(
    sess({ trade_count: 13, median_inter_trade_gap_seconds: 180, median_position_size: 2.4, session_duration_seconds: 72 * 60 }),
    baseline(),
    NOW,
  );
  close(r.deviations.trade_count, 0.30, "trade_count +30%");
  close(r.deviations.pace, -0.40, "pace −40% (faster)");
  close(r.deviations.size, 0.20, "size +20%");
  close(r.deviations.duration, -0.20, "duration −20%");
  assert(r.baseline_ready === true, "baseline_ready true");
});

// ── L2 ───────────────────────────────────────────────────────────────────────
run("L2 flags trigger correctly", () => {
  const r = computeLiveDeviation(
    sess({ trade_count: 13, median_inter_trade_gap_seconds: 200, median_position_size: 2.5, session_duration_seconds: 90 * 60 }),
    baseline(),
    NOW,
  );
  assert(r.flags.overtrading,      "overtrading (13 > 10×1.25=12.5)");
  assert(r.flags.speed_escalation, "speed_escalation (200 < 300×0.75=225)");
  assert(r.flags.size_escalation,  "size_escalation (2.5 > 2×1.2=2.4)");

  const drift = computeLiveDeviation(
    sess({ trade_count: 14, median_inter_trade_gap_seconds: 150 }), // +40% count, −50% pace
    baseline(),
    NOW,
  );
  assert(drift.flags.session_drift, "session_drift (≥2 features >30%)");
});

// ── L3 ───────────────────────────────────────────────────────────────────────
run("L3 flags stay off within range", () => {
  const r = computeLiveDeviation(
    sess({ trade_count: 10, median_inter_trade_gap_seconds: 300, median_position_size: 2, session_duration_seconds: 90 * 60 }),
    baseline(),
    NOW,
  );
  assert(!r.flags.overtrading && !r.flags.speed_escalation && !r.flags.size_escalation && !r.flags.session_drift, "no flags on-baseline");
  assert(r.risk_score === 0, "risk 0 on-baseline");
  assert(r.interpretation[0].includes("within A-Game baseline"), "factual within-range statement");
});

// ── L4 ───────────────────────────────────────────────────────────────────────
run("L4 boundary: baseline 0 / null", () => {
  const zero = computeLiveDeviation(
    sess({ trade_count: 5 }),
    baseline({ median_trade_count: 0 }),
    NOW,
  );
  assert(zero.deviations.trade_count === null, "div-by-zero baseline → null deviation");
  assert(zero.flags.overtrading === false, "zero baseline does not trip overtrading");

  const nul = computeLiveDeviation(
    sess({ median_position_size: 99 }),
    baseline({ median_position_size: null }),
    NOW,
  );
  assert(nul.deviations.size === null, "null baseline → null deviation");
  assert(nul.flags.size_escalation === false, "null baseline does not trip size flag");
});

// ── L5 ───────────────────────────────────────────────────────────────────────
run("L5 calibrating baseline", () => {
  const r = computeLiveDeviation(sess({ trade_count: 50 }), baseline({ status: "calibrating" }), NOW);
  assert(r.baseline_ready === false, "baseline_ready false");
  assert(r.deviations.trade_count === null, "deviations null while calibrating");
  assert(r.risk_score === 0, "risk 0 while calibrating");
  assert(r.interpretation[0].toLowerCase().includes("calibrating"), "states calibrating");
});

// ── L6 ───────────────────────────────────────────────────────────────────────
run("L6 no active session", () => {
  const r = computeLiveDeviation(null, baseline(), NOW);
  assert(r.session_id === null, "session_id null");
  assert(r.interpretation[0] === "No active session.", "states no active session");
  assert(r.risk_score === 0, "risk 0");
});

// ── L7 ───────────────────────────────────────────────────────────────────────
run("L7 active session without materialised features", () => {
  const r = computeLiveDeviation(sess(null, { session_id: "s9" }), baseline(), NOW);
  assert(r.session_id === "s9", "session_id preserved");
  assert(r.deviations.trade_count === null, "no deviations without features");
  assert(r.interpretation[0].includes("no materialised features"), "states features missing");
});

// ── L8 ───────────────────────────────────────────────────────────────────────
run("L8 risk score directional + deterministic", () => {
  // +40% count, −50% pace (faster), size/duration on-baseline.
  // risk = 0.4×0.3 + 0.5×0.3 = 0.12 + 0.15 = 0.27 → 27
  const r = computeLiveDeviation(sess({ trade_count: 14, median_inter_trade_gap_seconds: 150 }), baseline(), NOW);
  assert(r.risk_score === 27, "risk_score = 27 (weighted, directional)");

  // Safe-direction deviations add nothing: slower pace + shorter duration.
  const safe = computeLiveDeviation(
    sess({ trade_count: 10, median_inter_trade_gap_seconds: 600, session_duration_seconds: 45 * 60 }),
    baseline(),
    NOW,
  );
  assert(safe.risk_score === 0, "slower pace / shorter session add no risk");
});

// ── L9 ───────────────────────────────────────────────────────────────────────
run("L9 deterministic output", () => {
  const s = sess({ trade_count: 13, median_inter_trade_gap_seconds: 180 });
  const a = computeLiveDeviation(s, baseline(), NOW);
  const b = computeLiveDeviation(s, baseline(), NOW);
  assert(JSON.stringify(a) === JSON.stringify(b), "identical output for identical inputs (fixed now)");
});

// ── L10 ──────────────────────────────────────────────────────────────────────
run("L10 selectActiveSession (session switching)", () => {
  const rows = [
    { session_id: "a", status: "closed",      start_ts: "2025-06-03T18:00:00Z" },
    { session_id: "b", status: "open",        start_ts: "2025-06-03T14:00:00Z" },
    { session_id: "c", status: "provisional", start_ts: "2025-06-03T16:00:00Z" },
  ];
  assert(selectActiveSession(rows)?.session_id === "c", "latest open/provisional wins, ignores closed");

  assert(selectActiveSession([{ session_id: "x", status: "closed", start_ts: "2025-06-03T10:00:00Z" }]) === null, "all closed → null");

  const tie = [
    { session_id: "p", status: "open", start_ts: "2025-06-03T14:00:00Z" },
    { session_id: "q", status: "open", start_ts: "2025-06-03T14:00:00Z" },
  ];
  assert(selectActiveSession(tie)?.session_id === "q", "deterministic tiebreak by session_id");
});

// ── L11 ──────────────────────────────────────────────────────────────────────
run("L11 interpretation factual / non-prescriptive", () => {
  const reports = [
    computeLiveDeviation(sess({ trade_count: 14, median_inter_trade_gap_seconds: 150, median_position_size: 3 }), baseline(), NOW),
    computeLiveDeviation(sess({ trade_count: 6, session_duration_seconds: 130 * 60 }), baseline(), NOW),
  ];
  const text = reports.flatMap((r) => r.interpretation).join(" ").toLowerCase();
  assert(!/\b(should|stop|must|don't|do not|emotional|panic|calm)\b/.test(text), "no prescriptive/psychological language");
  assert(reports[0].interpretation.some((s) => s.includes("Trade frequency is")), "uses factual phrasing");
});

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
