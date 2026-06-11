/**
 * lib/runtime/safetyGuard.ts
 *
 * Phase 2.6 — production safety layer (wraps outputs; changes no analytics).
 *
 * Classifies every output's reliability and wraps it so the UI can never
 * receive an unclassified value. Core principle:
 *   "If the system is unsure, it must say so explicitly."
 *
 * Never silently falls back to stale numbers: INVALID and UNKNOWN return
 * `data: null`. DEGRADED keeps the (already trust-flagged) data but marks it.
 */

import type { TrustedLiveReport } from "@/lib/agame/trust";
import type { SystemState } from "./systemState";

export type SafetyState = "OK" | "DEGRADED" | "INVALID" | "UNKNOWN";

export interface SafeLiveReport {
  data:      TrustedLiveReport | null;
  safety:    SafetyState;
  reason?:   string;
  timestamp: number;
}

export interface SafetyContext {
  connected:   boolean;
  systemState: SystemState;
  partial?:    boolean;   // a recompute partially failed
  now?:        number;
}

// Fields a complete trust report must carry.
const REQUIRED_FIELDS: Array<keyof TrustedLiveReport> = [
  "system_state", "data_freshness", "confidence", "deviations",
  "flags", "signal_quality_map", "risk_context", "computed_at",
];

function missingField(r: TrustedLiveReport): string | null {
  for (const k of REQUIRED_FIELDS) {
    if (r[k] === undefined || r[k] === null) return String(k);
  }
  return null;
}

function nonFiniteDeviation(d: TrustedLiveReport["deviations"]): string | null {
  for (const k of ["trade_count", "pace", "size", "duration"] as const) {
    const v = d[k];
    if (v !== null && !Number.isFinite(v)) return k;
  }
  return null;
}

function allDeviationsNull(d: TrustedLiveReport["deviations"]): boolean {
  return d.trade_count === null && d.pace === null && d.size === null && d.duration === null;
}

/**
 * Classify reliability. Precedence:
 *   UNKNOWN (no data / disconnected) → INVALID (integrity) → DEGRADED → OK.
 */
export function classifySafety(
  report: TrustedLiveReport | null,
  ctx: SafetyContext,
): { safety: SafetyState; reason?: string } {
  const { connected, systemState, partial } = ctx;

  // ── UNKNOWN — no trustworthy data to classify ───────────────────────────────
  if (!connected) return { safety: "UNKNOWN", reason: "transport unavailable" };
  if (systemState === "DISCONNECTED") return { safety: "UNKNOWN", reason: "system disconnected" };
  if (report == null) return { safety: "UNKNOWN", reason: "no report available" };
  if (report.session_id == null) return { safety: "UNKNOWN", reason: "no active session" };

  // ── INVALID — data integrity broken ─────────────────────────────────────────
  const miss = missingField(report);
  if (miss) return { safety: "INVALID", reason: `trust report missing field: ${miss}` };
  const nan = nonFiniteDeviation(report.deviations);
  if (nan) return { safety: "INVALID", reason: `non-finite deviation: ${nan}` };

  const expectsComparison =
    systemState === "LIVE" || systemState === "STALE" || systemState === "REBUILDING";
  if (expectsComparison && report.baseline_reference == null) {
    return { safety: "INVALID", reason: "baseline required but missing" };
  }
  if (expectsComparison && allDeviationsNull(report.deviations)) {
    return { safety: "INVALID", reason: "feature_vector missing for active session" };
  }

  // ── DEGRADED — running, but reduced reliability ──────────────────────────────
  if (partial) return { safety: "DEGRADED", reason: "partial recompute detected" };
  if (systemState === "CALIBRATING") return { safety: "DEGRADED", reason: "baseline calibrating" };
  if (report.confidence?.baseline_strength === "LOW") {
    return { safety: "DEGRADED", reason: "low baseline confidence" };
  }
  const age = report.data_freshness?.age_seconds ?? 0;
  if (age > 30 && age < 120) return { safety: "DEGRADED", reason: "data stale (30–120s)" };
  if (systemState !== "LIVE") return { safety: "DEGRADED", reason: `non-live state: ${systemState}` };

  // ── OK ───────────────────────────────────────────────────────────────────────
  return { safety: "OK" };
}

/**
 * Wrap a report into a SafeLiveReport. INVALID/UNKNOWN drop the data (never a
 * silent stale fallback); DEGRADED keeps the trust-flagged data.
 */
export function wrapSafe(report: TrustedLiveReport | null, ctx: SafetyContext): SafeLiveReport {
  const { safety, reason } = classifySafety(report, ctx);
  const data = safety === "INVALID" || safety === "UNKNOWN" ? null : report;
  return { data, safety, reason, timestamp: ctx.now ?? Date.now() };
}
