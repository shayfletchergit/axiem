/**
 * lib/runtime/systemState.ts
 *
 * Phase 2.5 — system state machine (orchestration glue ONLY).
 *
 * Pure bookkeeping. Contains NO analytics, NO trading math. It only classifies
 * the orchestration runtime into one of five states from three inputs:
 * transport connectivity, whether a recompute is running, whether the baseline
 * is calibrating (a read-only condition fed in from the last trusted report),
 * and how old the last recompute is.
 */

export type SystemState =
  | "LIVE"
  | "REBUILDING"
  | "CALIBRATING"
  | "STALE"
  | "DISCONNECTED";

// ── Staleness thresholds (exact, per spec) ───────────────────────────────────
export const STALE_WARN_MS  = 30_000;   // ≥30s  → STALE (warning)
export const STALE_HARD_MS  = 120_000;  // ≥120s → STALE (hard)
export const DISCONNECT_MS  = 300_000;  // ≥300s OR transport down → DISCONNECTED

export type StaleSeverity = "none" | "warning" | "hard";

export interface SystemStateSnapshot {
  state:            SystemState;
  connected:        boolean;
  rebuilding:       boolean;
  calibrating:      boolean;
  last_recompute_ts: number | null;
  age_ms:           number | null;
  stale_severity:   StaleSeverity;
}

export interface SystemStateOptions {
  staleWarnMs?:  number;
  staleHardMs?:  number;
  disconnectMs?: number;
}

/**
 * One manager per (user, account). Holds runtime flags and derives the state.
 * No math, no analytics — pure classification of orchestration health.
 */
export class SystemStateManager {
  private connected = true;
  private rebuilding = false;
  private calibrating = false;
  private lastRecomputeTs: number | null = null;

  private readonly warnMs: number;
  private readonly hardMs: number;
  private readonly disconnectMs: number;

  constructor(opts: SystemStateOptions = {}) {
    this.warnMs = opts.staleWarnMs ?? STALE_WARN_MS;
    this.hardMs = opts.staleHardMs ?? STALE_HARD_MS;
    this.disconnectMs = opts.disconnectMs ?? DISCONNECT_MS;
  }

  // ── Inputs (set by the orchestrator / transport — never analytics) ──────────
  setConnected(v: boolean): void   { this.connected = v; }
  setRebuilding(v: boolean): void  { this.rebuilding = v; }
  setCalibrating(v: boolean): void { this.calibrating = v; }
  markRecompute(ts: number): void  { this.lastRecomputeTs = ts; }

  // ── Derivation ──────────────────────────────────────────────────────────────
  /**
   * Precedence (exact): DISCONNECTED overrides everything (transport down OR
   * age ≥ 300s) → REBUILDING (recompute running) → CALIBRATING (baseline not
   * ready) → STALE (age ≥ 30s, or never recomputed) → LIVE.
   */
  getState(now: number): SystemState {
    if (!this.connected) return "DISCONNECTED";

    const age = this.lastRecomputeTs == null ? null : now - this.lastRecomputeTs;
    if (age != null && age >= this.disconnectMs) return "DISCONNECTED";

    if (this.rebuilding) return "REBUILDING";
    if (this.calibrating) return "CALIBRATING";

    if (age == null) return "STALE";          // never recomputed yet
    if (age >= this.warnMs) return "STALE";
    return "LIVE";
  }

  staleSeverity(now: number): StaleSeverity {
    if (this.lastRecomputeTs == null) return "hard";
    const age = now - this.lastRecomputeTs;
    if (age >= this.hardMs) return "hard";
    if (age >= this.warnMs) return "warning";
    return "none";
  }

  snapshot(now: number): SystemStateSnapshot {
    return {
      state:             this.getState(now),
      connected:         this.connected,
      rebuilding:        this.rebuilding,
      calibrating:       this.calibrating,
      last_recompute_ts: this.lastRecomputeTs,
      age_ms:            this.lastRecomputeTs == null ? null : now - this.lastRecomputeTs,
      stale_severity:    this.staleSeverity(now),
    };
  }
}
