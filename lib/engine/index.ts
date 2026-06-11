import type { Trade, EFDResult, PLBResult, SCIResult, BSSResult, Baseline } from "../types";

// ── EFD: Entry Frequency Drift ──
export function calcEFD(trades: Trade[], baseline: Baseline): EFDResult {
  if (trades.length < 2) return { state: "insufficient", rawMins: null, score: 0 };
  const gaps: number[] = [];
  for (let i = 1; i < trades.length; i++) {
    gaps.push((trades[i].entryMs - trades[i - 1].entryMs) / 60000);
  }
  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const baselineMins = baseline.interval / 60000;
  const ratio = avgGap / baselineMins;
  const state: EFDResult["state"] = ratio < 0.35 ? "critical" : ratio < 0.65 ? "warning" : "ok";
  return { state, rawMins: Math.round(avgGap), score: ratio };
}

// ── PLB: Post-Loss Behaviour ──
export function calcPLB(trades: Trade[]): PLBResult {
  const losses = trades.filter(t => t.r < -0.1);
  if (!losses.length) return { state: "insufficient", score: 0 };
  let reactiveCount = 0;
  losses.forEach(loss => {
    const lossIdx = trades.indexOf(loss);
    const next = trades[lossIdx + 1];
    if (next) {
      const gapMins = (next.entryMs - loss.exitMs) / 60000;
      if (gapMins < 5) reactiveCount++;
    }
  });
  const reactivePct = reactiveCount / losses.length;
  const state: PLBResult["state"] = reactivePct > 0.6 ? "critical" : reactivePct > 0.3 ? "warning" : "ok";
  return { state, score: reactivePct };
}

// ── SCI: Sizing Consistency Index ──
export function calcSCI(trades: Trade[], baseline: Baseline): SCIResult {
  if (!trades.length) return { state: "insufficient", label: "--", rawValue: null };
  const sizes = trades.map(t => t.size);
  const avg = sizes.reduce((s, v) => s + v, 0) / sizes.length;
  const devPct = Math.abs(avg - baseline.size) / baseline.size;
  const state: SCIResult["state"] = devPct > 0.4 ? "critical" : devPct > 0.18 ? "warning" : "ok";
  return {
    state,
    label: `${avg.toFixed(1)} ct`,
    rawValue: avg,
  };
}

// ── BSS: Behavioural State Score ──
export function calcBSS(efd: EFDResult, plb: PLBResult, sci: SCIResult): BSSResult {
  if (efd.state === "insufficient" && plb.state === "insufficient") {
    return { score: null, state: "insufficient" };
  }
  const efdPenalty = efd.state === "critical" ? 0.9 : efd.state === "warning" ? 0.45 : 0;
  const plbPenalty = plb.state === "critical" ? 0.9 : plb.state === "warning" ? 0.45 : 0;
  const sciPenalty = sci.state === "critical" ? 0.9 : sci.state === "warning" ? 0.45 : 0;
  const raw = 100 - (efdPenalty * 35 + plbPenalty * 45 + sciPenalty * 20);
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  const state: BSSResult["state"] = score >= 70 ? "ok" : score >= 50 ? "warning" : "critical";
  return { score, state };
}

// ── Format helpers ──
export function fmtT(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
export function fmtD(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
export function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Signal health (0–100) ──
export function sigHealth(state: string): number {
  return state === "critical" ? 10 : state === "warning" ? 50 : state === "ok" ? 94 : 65;
}

