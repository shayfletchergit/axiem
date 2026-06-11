/**
 * lib/runtime/observability.ts
 *
 * Phase 2.6 — runtime observability (measurement only; no analytics, no control).
 *
 * A module-level metrics registry the orchestrator and safety layer increment.
 * Pure counters/timers — they never influence any output or decision.
 */

export interface RuntimeMetrics {
  fillsReceived:        number;
  fillsProcessed:       number;   // events committed via a successful recompute
  duplicatesIgnored:    number;   // rejected by the watermark
  debounceSuppressions: number;   // fills that reset a pending debounce window

  baselineRecomputes:   number;
  trustRecomputes:      number;

  recomputeCount:       number;
  recomputeTotalMs:     number;
  recomputeLastMs:      number;
  recomputeMaxMs:       number;
  recomputeAvgMs:       number;   // derived

  staleEvents:          number;
  disconnectEvents:     number;

  recomputeFailures:    number;
}

function blank(): RuntimeMetrics {
  return {
    fillsReceived: 0, fillsProcessed: 0, duplicatesIgnored: 0, debounceSuppressions: 0,
    baselineRecomputes: 0, trustRecomputes: 0,
    recomputeCount: 0, recomputeTotalMs: 0, recomputeLastMs: 0, recomputeMaxMs: 0, recomputeAvgMs: 0,
    staleEvents: 0, disconnectEvents: 0, recomputeFailures: 0,
  };
}

let metrics: RuntimeMetrics = blank();

// ── Mutators (called by orchestrator / safety layer) ─────────────────────────
export const obs = {
  fillReceived:        () => { metrics.fillsReceived++; },
  fillsProcessed:      (n: number) => { metrics.fillsProcessed += n; },
  duplicateIgnored:    () => { metrics.duplicatesIgnored++; },
  debounceSuppressed:  () => { metrics.debounceSuppressions++; },
  baselineRecompute:   () => { metrics.baselineRecomputes++; },
  trustRecompute:      () => { metrics.trustRecomputes++; },
  staleEvent:          () => { metrics.staleEvents++; },
  disconnect:          () => { metrics.disconnectEvents++; },
  recomputeFailure:    () => { metrics.recomputeFailures++; },
  recompute:           (ms: number) => {
    metrics.recomputeCount++;
    metrics.recomputeTotalMs += ms;
    metrics.recomputeLastMs = ms;
    if (ms > metrics.recomputeMaxMs) metrics.recomputeMaxMs = ms;
  },
};

// ── Readers ───────────────────────────────────────────────────────────────────
export function getRuntimeMetrics(): RuntimeMetrics {
  const avg = metrics.recomputeCount > 0 ? metrics.recomputeTotalMs / metrics.recomputeCount : 0;
  return { ...metrics, recomputeAvgMs: Math.round(avg * 100) / 100 };
}

export function resetRuntimeMetrics(): void {
  metrics = blank();
}
