/**
 * lib/runtime/orchestrator.ts
 *
 * Phase 2.5 — runtime orchestrator (GLUE ONLY).
 *
 * Converts the batch-recomputed analytics into a live reactive system WITHOUT
 * changing any math. On each fill it updates metadata and schedules a DEBOUNCED
 * recompute that calls the EXISTING pipeline functions, in the exact mandated
 * order. It owns no computation — every analytic value comes from a black-box
 * call.
 *
 * Pipeline mapping (existing functions — treated as black boxes):
 *   rebuildSessionFeatures(userId)        → lib/db/sessions.ts  rebuildSessionsFromTrades
 *   computeAgameBaseline(userId,account)  → lib/db/agame.ts     rebuildAgameBaseline
 *   computeTrustedLiveReport(userId,acc)  → lib/db/liveBehaviour.ts getLiveBehaviourReport
 *      (that function internally runs computeLiveDeviation THEN the trust layer —
 *       i.e. spec steps 3 and 4, in order. We do not split or reimplement them.)
 */

import { SystemStateManager, type SystemState, type SystemStateSnapshot } from "./systemState";
import type { Transport, FillEvent } from "./transportAdapter";
import type { TrustedLiveReport } from "@/lib/agame/trust";
import { WatermarkTracker } from "./watermark";
import { obs, getRuntimeMetrics } from "./observability";
import { wrapSafe, type SafeLiveReport } from "./safetyGuard";
import { buildDashboardSnapshot, type DashboardSnapshot } from "./dashboardContract";

// ── The existing pipeline, injected as black boxes ───────────────────────────
export interface Pipeline {
  /** existing: rebuildSessionsFromTrades — materialises sessions + feature vectors */
  rebuildSessionFeatures(userId: string): Promise<unknown>;
  /** existing: rebuildAgameBaseline — recomputes + upserts the A-Game baseline */
  computeAgameBaseline(userId: string, accountId: string): Promise<unknown>;
  /** existing: getLiveBehaviourReport — runs deviation then the trust layer */
  computeTrustedLiveReport(userId: string, accountId: string): Promise<TrustedLiveReport>;
}

// ── Injectable timer + clock (so tests are deterministic) ────────────────────
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface OrchestratorOptions {
  pipeline:    Pipeline;
  debounceMs?: number;          // 2000–5000; default 3000
  now?:        () => number;    // default Date.now
  scheduler?:  Scheduler;       // default real timers
  stateOptions?: ConstructorParameters<typeof SystemStateManager>[0];
  watermark?:  WatermarkTracker; // exactly-once guard (default: a fresh tracker)
}

interface Entry {
  userId:          string;
  accountId:       string;
  sessionId:       string | null;   // last session id seen on a fill (metadata only)
  observedSession: string | null;   // last active session id seen in a trusted report
  lastFillTs:      number;
  lastRecomputeTs: number | null;
  dirty:           boolean;
  timer:           unknown | null;
  inFlight:        boolean;
  hasBaseline:     boolean;
  boundaryPending: boolean;         // a session ended / boundary crossed → recompute baseline
  state:           SystemStateManager;
  lastReport:      TrustedLiveReport | null;
  partial:         boolean;         // last recompute partially failed (safety: DEGRADED)
  acceptedCount:   number;          // events staged in the watermark awaiting commit
  observedState:   SystemState | null; // last state observed via dashboard (stale-transition counting)
}

export class RuntimeOrchestrator {
  private readonly entries = new Map<string, Entry>();
  private readonly pipeline: Pipeline;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly stateOptions: OrchestratorOptions["stateOptions"];
  private readonly inflight = new Set<Promise<void>>();
  private readonly watermark: WatermarkTracker;
  private connected = true;

  constructor(opts: OrchestratorOptions) {
    this.pipeline = opts.pipeline;
    this.debounceMs = opts.debounceMs ?? 3000;
    this.now = opts.now ?? (() => Date.now());
    this.scheduler = opts.scheduler ?? realScheduler;
    this.stateOptions = opts.stateOptions;
    this.watermark = opts.watermark ?? new WatermarkTracker();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  /** Subscribe to a transport. Returns an unsubscribe for all three handlers. */
  attach(transport: Transport): () => void {
    const offFill = transport.onFill((e) => this.onFill(e));
    const offDisc = transport.onDisconnect(() => this.handleDisconnect());
    const offRec  = transport.onReconnect(() => this.handleReconnect());
    return () => { offFill(); offDisc(); offRec(); };
  }

  // ── Fill handling: METADATA ONLY, then debounce ──────────────────────────────
  onFill(e: FillEvent): void {
    obs.fillReceived();
    const key = keyOf(e.userId, e.accountId);
    const entry = this.entryFor(key, e.userId, e.accountId);

    // Watermark — exactly-once guard. Ignore duplicates / replays.
    const eventId = e.eventId ?? `${e.accountId}:${e.ts}:${e.sessionId ?? ""}`;
    if (!this.watermark.isNewEvent(key, eventId)) {
      obs.duplicateIgnored();
      return;                                   // never processed twice
    }
    this.watermark.accept(key, eventId, e.ts);
    entry.acceptedCount += 1;

    // A debounce window already pending → this fill is being coalesced.
    if (entry.timer != null) obs.debounceSuppressed();

    // Step 1 — update metadata only. No trade/feature/session logic here.
    entry.lastFillTs = e.ts;
    entry.dirty = true;
    if (e.sessionId) {
      if (entry.sessionId !== null && e.sessionId !== entry.sessionId) {
        entry.boundaryPending = true;   // a new session id appeared → boundary crossed
      }
      entry.sessionId = e.sessionId;
    }

    // Step 2 — schedule a debounced recompute (reset the window on every fill).
    this.arm(key);
  }

  private arm(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer != null) this.scheduler.clear(entry.timer);
    entry.timer = this.scheduler.set(() => {
      entry.timer = null;
      this.flush(key);
    }, this.debounceMs);
  }

  private flush(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    // A recompute already running → leave dirty set; it will re-arm on completion.
    if (entry.inFlight) return;
    const p = this.recompute(entry).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  // ── The ONLY place the pipeline is called — existing functions, exact order ──
  private async recompute(entry: Entry): Promise<void> {
    const key = keyOf(entry.userId, entry.accountId);
    const startMs = this.now();
    entry.inFlight = true;
    entry.dirty = false;                         // capture this cycle
    const computeBaseline = !entry.hasBaseline || entry.boundaryPending;

    entry.state.setRebuilding(true);             // → REBUILDING
    try {
      // 1. sessions + feature vectors
      await this.pipeline.rebuildSessionFeatures(entry.userId);

      // 2. baseline — ONLY on first build or after a session ended/boundary
      if (computeBaseline) {
        await this.pipeline.computeAgameBaseline(entry.userId, entry.accountId);
        obs.baselineRecompute();
        entry.hasBaseline = true;
        entry.boundaryPending = false;
      }

      // 3 + 4. deviation → trust (single existing function, internal order)
      const report = await this.pipeline.computeTrustedLiveReport(entry.userId, entry.accountId);
      obs.trustRecompute();
      entry.lastReport = report;

      // Detect a session that ended/changed → fold it into the baseline next cycle.
      if (entry.observedSession !== null && entry.observedSession !== report.session_id) {
        entry.boundaryPending = true;
      }
      entry.observedSession = report.session_id;

      // Reflect read-only calibration condition into the state machine.
      entry.state.setCalibrating(report.system_state === "CALIBRATING");

      entry.lastRecomputeTs = this.now();
      entry.state.markRecompute(entry.lastRecomputeTs);

      // SUCCESS — commit the watermark exactly once (events processed).
      this.watermark.commit(key);
      obs.fillsProcessed(entry.acceptedCount);
      entry.acceptedCount = 0;
      entry.partial = false;
    } catch (err) {
      // FAILURE CONTAINMENT — never crash, never silently keep stale numbers.
      // Do NOT commit the watermark (events remain pending → reprocessed).
      // Mark partial so safetyGuard classifies output DEGRADED; schedule a retry.
      entry.partial = true;
      obs.recomputeFailure();
      console.error("[orchestrator] recompute failed (contained)", {
        key, err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      entry.state.setRebuilding(false);          // → LIVE / STALE / CALIBRATING
      entry.inFlight = false;
      obs.recompute(Math.max(0, this.now() - startMs));
      // Fills arrived during the recompute, or it failed → schedule one more pass.
      if (entry.dirty || entry.partial) this.arm(key);
    }
  }

  // ── Transport state ──────────────────────────────────────────────────────────
  private handleDisconnect(): void {
    this.connected = false;
    obs.disconnect();
    for (const e of this.entries.values()) e.state.setConnected(false);
  }
  private handleReconnect(): void {
    this.connected = true;
    for (const e of this.entries.values()) e.state.setConnected(true);
  }

  // ── Readers (no computation) ─────────────────────────────────────────────────
  getState(userId: string, accountId: string, now: number = this.now()): SystemState {
    const e = this.entries.get(keyOf(userId, accountId));
    return e ? e.state.getState(now) : (this.connected ? "STALE" : "DISCONNECTED");
  }
  snapshot(userId: string, accountId: string, now: number = this.now()): SystemStateSnapshot | null {
    const e = this.entries.get(keyOf(userId, accountId));
    return e ? e.state.snapshot(now) : null;
  }
  getReport(userId: string, accountId: string): TrustedLiveReport | null {
    return this.entries.get(keyOf(userId, accountId))?.lastReport ?? null;
  }
  isConnected(): boolean {
    return this.connected;
  }
  getWatermarkState(userId: string, accountId: string) {
    return this.watermark.getWatermark(keyOf(userId, accountId));
  }

  /**
   * Safety-wrapped report. The ONLY report a non-UI consumer should read when it
   * needs the reliability classification inline. Never returns unclassified data.
   */
  getSafeReport(userId: string, accountId: string, now: number = this.now()): SafeLiveReport {
    const e = this.entries.get(keyOf(userId, accountId));
    const report = e?.lastReport ?? null;
    return wrapSafe(report, {
      connected: this.connected,
      systemState: this.getState(userId, accountId, now),
      partial: e?.partial ?? false,
      now,
    });
  }

  /**
   * The UI-safe boundary. Frontend consumes ONLY this. Always carries system
   * state, safety state, staleness, and confidence — never raw pipeline output.
   */
  getDashboardSnapshot(
    userId: string, accountId: string,
    opts: { includeDebug?: boolean; now?: number } = {},
  ): DashboardSnapshot {
    const now = opts.now ?? this.now();
    const key = keyOf(userId, accountId);
    const e = this.entries.get(key);
    const systemState = this.getState(userId, accountId, now);

    // Count stale transitions for observability (not on every poll).
    if (e) {
      if (systemState === "STALE" && e.observedState !== "STALE") obs.staleEvent();
      e.observedState = systemState;
    }

    const snap = e?.state.snapshot(now);
    return buildDashboardSnapshot({
      report:       e?.lastReport ?? null,
      systemState,
      connected:    this.connected,
      stalenessMs:  snap?.age_ms ?? null,
      partial:      e?.partial ?? false,
      watermark:    this.watermark.getWatermark(key),
      metrics:      getRuntimeMetrics(),
      includeDebug: opts.includeDebug,
      now,
    });
  }

  /** Await all in-flight recomputes (test/maintenance aid). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ── Internal ──────────────────────────────────────────────────────────────────
  private entryFor(key: string, userId: string, accountId: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      const state = new SystemStateManager(this.stateOptions);
      state.setConnected(this.connected);
      e = {
        userId, accountId,
        sessionId: null, observedSession: null,
        lastFillTs: 0, lastRecomputeTs: null,
        dirty: false, timer: null, inFlight: false,
        hasBaseline: false, boundaryPending: false,
        state, lastReport: null,
        partial: false, acceptedCount: 0, observedState: null,
      };
      this.entries.set(key, e);
    }
    return e;
  }
}

function keyOf(userId: string, accountId: string): string {
  return `${userId}:${accountId}`;
}

/**
 * Bind the orchestrator pipeline to the REAL existing functions. This is the
 * production wiring — it only forwards calls; it adds no logic.
 *
 * Kept as a lazy factory so importing the orchestrator for tests does not pull
 * in the Supabase-backed db layer.
 */
export async function createDefaultPipeline(): Promise<Pipeline> {
  const [{ rebuildSessionsFromTrades }, { rebuildAgameBaseline }, { getLiveBehaviourReport }] =
    await Promise.all([
      import("@/lib/db/sessions"),
      import("@/lib/db/agame"),
      import("@/lib/db/liveBehaviour"),
    ]);

  return {
    rebuildSessionFeatures:   (userId) => rebuildSessionsFromTrades(userId),
    computeAgameBaseline:     (userId, accountId) => rebuildAgameBaseline(userId, accountId),
    computeTrustedLiveReport: (userId, accountId) => getLiveBehaviourReport(userId, accountId, { rebuilding: false }),
  };
}
