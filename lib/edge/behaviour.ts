/**
 * lib/edge/behaviour.ts
 *
 * Value Layer v1 — EDGE behavioural fingerprint (PURE).
 *
 * Derives, from a TrustedLiveReport, the behavioural state used to (a) label each
 * trade for the eventual behaviour→P&L proof, and (b) feed the combined Heartbeat
 * alongside account severity. No analytics are recomputed — deviations and
 * risk_score are consumed read-only.
 */

import { heartbeatFromSeverity } from "@/lib/rules/rail";
import type { Heartbeat } from "@/lib/rules/types";
import type { TrustedLiveReport } from "@/lib/agame/trust";

/** |deviation| at/above this is treated as "off-baseline" on that dimension. */
export const OFF_THRESHOLD = 0.2;
/** Deviation magnitude mapped to full severity. */
const DEV_FULL = 0.6;

export type DevDim = "trade_count" | "pace" | "size" | "duration";
const DIMS: DevDim[] = ["trade_count", "pace", "size", "duration"];

export interface BehaviourFingerprint {
  heartbeat:      Heartbeat;
  dev_trade_count: number | null;
  dev_pace:        number | null;
  dev_size:        number | null;
  dev_duration:    number | null;
  off_dims:       DevDim[];
  risk_score:     number | null;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Behavioural severity (0–1): the worse of normalised deviation magnitude and
 * normalised risk score. Mirrors the RAIL severity scale so they can be combined.
 */
export function behaviourSeverity(report: TrustedLiveReport): number {
  const devs = report.deviations;
  const worst = DIMS.reduce((m, d) => {
    const v = devs[d];
    return v == null ? m : Math.max(m, Math.abs(v));
  }, 0);
  const sevFromDev = clamp01(worst / DEV_FULL);
  const sevFromRisk = clamp01((report.risk_score ?? 0) / 100);
  return round4(Math.max(sevFromDev, sevFromRisk));
}

/** Behavioural heartbeat (account severity is folded in at the call site). */
export function behaviourHeartbeat(report: TrustedLiveReport): Heartbeat {
  return heartbeatFromSeverity(behaviourSeverity(report));
}

/** The fingerprint stamped on a trade at (approximately) its entry. */
export function buildFingerprint(report: TrustedLiveReport): BehaviourFingerprint {
  const devs = report.deviations;
  const off_dims = DIMS.filter((d) => {
    const v = devs[d];
    return v != null && Math.abs(v) >= OFF_THRESHOLD;
  });
  return {
    heartbeat:       behaviourHeartbeat(report),
    dev_trade_count: devs.trade_count == null ? null : round4(devs.trade_count),
    dev_pace:        devs.pace == null ? null : round4(devs.pace),
    dev_size:        devs.size == null ? null : round4(devs.size),
    dev_duration:    devs.duration == null ? null : round4(devs.duration),
    off_dims,
    risk_score:      report.risk_score,
  };
}
