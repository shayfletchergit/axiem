/**
 * lib/runtime/dashboardContract.ts
 *
 * Phase 2.6 — the ONLY boundary the frontend may consume.
 *
 * The UI must never read raw pipeline / orchestrator objects. Everything passes
 * through the safety guard, and every snapshot ALWAYS carries system state,
 * safety state, staleness, and confidence. No analytics happen here — this is a
 * presentation contract that re-shapes already-computed, already-safety-wrapped
 * values.
 */

import type { TrustedLiveReport } from "@/lib/agame/trust";
import type { SystemState } from "./systemState";
import type { WatermarkState } from "./watermark";
import type { RuntimeMetrics } from "./observability";
import type { RailState, Heartbeat } from "@/lib/rules/types";
import { wrapSafe, type SafeLiveReport, type SafetyState } from "./safetyGuard";

export interface DashboardSnapshot {
  system: {
    state:     SystemState;
    safety:    SafetyState;
    staleness: number;          // ms since last recompute (0 if unknown)
  };
  session: {
    id:     string;
    status: string;
  };
  behaviour: SafeLiveReport;    // always safety-classified
  confidence: {
    baseline:    number;        // 0–1 (presentation map of baseline strength)
    trust:       number;        // 0–1 (presentation map of safety state)
    dataQuality: number;        // 0–1 (freshness × overall signal quality)
  };
  rail: RailState | null;       // account-survival state; null until a rule profile is set
  heartbeat: Heartbeat;         // unified state = max(behavioural, account) severity
  debug?: {
    watermark: string | null;
    metrics:   RuntimeMetrics;
  };
}

export interface DashboardInput {
  report:       TrustedLiveReport | null;
  systemState:  SystemState;
  connected:    boolean;
  stalenessMs?: number | null;
  partial?:     boolean;
  watermark?:   WatermarkState;
  metrics?:     RuntimeMetrics;
  includeDebug?: boolean;
  now?:         number;
  rail?:        RailState | null;
  heartbeat?:   Heartbeat;
}

/**
 * Build the UI-safe snapshot. Always passes the report through the safety guard;
 * always populates system/safety/staleness/confidence.
 */
export function buildDashboardSnapshot(input: DashboardInput): DashboardSnapshot {
  const now = input.now ?? Date.now();
  const safe = wrapSafe(input.report, {
    connected: input.connected,
    systemState: input.systemState,
    partial: input.partial,
    now,
  });

  const report = input.report;
  const staleness =
    input.stalenessMs != null ? input.stalenessMs
    : report?.data_freshness ? Math.round(report.data_freshness.age_seconds * 1000)
    : 0;

  const snapshot: DashboardSnapshot = {
    system: {
      state:     input.systemState,
      safety:    safe.safety,
      staleness,
    },
    session: {
      id:     report?.session_id ?? "none",
      status: sessionStatus(report, input.systemState),
    },
    behaviour: safe,
    confidence: {
      baseline:    baselineConfidence(report),
      trust:       trustConfidence(safe.safety),
      dataQuality: dataQuality(report, staleness),
    },
    rail:      input.rail ?? null,
    heartbeat: input.heartbeat ?? "CALM",
  };

  if (input.includeDebug) {
    snapshot.debug = {
      watermark: input.watermark?.lastProcessedEventId ?? null,
      metrics:   input.metrics ?? emptyMetrics(),
    };
  }

  return snapshot;
}

// ── Presentation maps (0–1; NOT analytics) ───────────────────────────────────

function sessionStatus(report: TrustedLiveReport | null, state: SystemState): string {
  if (!report || report.session_id == null) return "none";
  if (state === "CALIBRATING") return "calibrating";
  return "active";
}

function baselineConfidence(report: TrustedLiveReport | null): number {
  switch (report?.confidence?.baseline_strength) {
    case "HIGH":   return 1;
    case "MEDIUM": return 0.66;
    case "LOW":    return 0.33;
    default:       return 0;
  }
}

function trustConfidence(safety: SafetyState): number {
  switch (safety) {
    case "OK":       return 1;
    case "DEGRADED": return 0.5;
    default:         return 0;   // INVALID / UNKNOWN
  }
}

function dataQuality(report: TrustedLiveReport | null, stalenessMs: number): number {
  if (!report) return 0;
  const freshness = stalenessMs <= 30_000 ? 1 : stalenessMs < 120_000 ? 0.5 : 0;
  const overall = report.signal_quality_map?.overall;
  const sig = overall === "STRONG" ? 1 : overall === "WEAK" ? 0.5 : 0;
  return Math.round(freshness * sig * 100) / 100;
}

function emptyMetrics(): RuntimeMetrics {
  return {
    fillsReceived: 0, fillsProcessed: 0, duplicatesIgnored: 0, debounceSuppressions: 0,
    baselineRecomputes: 0, trustRecomputes: 0,
    recomputeCount: 0, recomputeTotalMs: 0, recomputeLastMs: 0, recomputeMaxMs: 0, recomputeAvgMs: 0,
    staleEvents: 0, disconnectEvents: 0, recomputeFailures: 0,
  };
}
