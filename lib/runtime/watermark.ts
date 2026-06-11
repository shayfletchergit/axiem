/**
 * lib/runtime/watermark.ts
 *
 * Phase 2.6 — exactly-once processing guard (safety, not analytics).
 *
 * Guarantees every fill is processed at most once across the orchestration
 * pipeline, ignoring duplicates and replays (e.g. after a reconnect). It stores
 * NO trading data — only event identities and the high-water mark.
 *
 * Lifecycle per (user, account) key:
 *   accept(eventId)   — on a fill that passes isNewEvent: stage it as pending
 *   commit()          — after a SUCCESSFUL recompute: pending → seen, advance mark
 *   rollback()        — after a FAILED recompute: drop pending so fills retry
 *
 * setWatermark / getWatermark / isNewEvent are the spec's required surface.
 */

export interface WatermarkState {
  lastProcessedEventId:   string | null;
  lastProcessedTimestamp: number;
}

interface Cell {
  seen:    Set<string>;            // committed event ids (insertion-ordered)
  pending: Set<string>;            // accepted, awaiting commit
  last:    { id: string; ts: number } | null;
  pendHigh: { id: string; ts: number } | null; // highest-ts pending (becomes `last` on commit)
}

const SEEN_CAP = 5000;             // bound memory; older ids fall out of the dedup window

export class WatermarkTracker {
  private cells = new Map<string, Cell>();

  private cell(key: string): Cell {
    let c = this.cells.get(key);
    if (!c) { c = { seen: new Set(), pending: new Set(), last: null, pendHigh: null }; this.cells.set(key, c); }
    return c;
  }

  /** True if this event has neither been committed nor staged — i.e. safe to process. */
  isNewEvent(key: string, eventId: string): boolean {
    const c = this.cells.get(key);
    if (!c) return true;
    return !c.seen.has(eventId) && !c.pending.has(eventId);
  }

  /** Stage an event for processing. Returns false if it is a duplicate/replay. */
  accept(key: string, eventId: string, ts: number): boolean {
    if (!this.isNewEvent(key, eventId)) return false;
    const c = this.cell(key);
    c.pending.add(eventId);
    if (c.pendHigh == null || ts >= c.pendHigh.ts) c.pendHigh = { id: eventId, ts };
    return true;
  }

  /** Commit all pending events after a successful recompute; advance the mark. */
  commit(key: string): void {
    const c = this.cells.get(key);
    if (!c) return;
    for (const id of c.pending) c.seen.add(id);
    this.bound(c);
    if (c.pendHigh) c.last = c.pendHigh;
    c.pending.clear();
    c.pendHigh = null;
  }

  /** Drop pending events after a failed recompute so they are reprocessed. */
  rollback(key: string): void {
    const c = this.cells.get(key);
    if (!c) return;
    c.pending.clear();
    c.pendHigh = null;
  }

  // ── Spec-required surface ─────────────────────────────────────────────────────
  setWatermark(key: string, eventId: string, ts: number = Date.now()): void {
    const c = this.cell(key);
    c.seen.add(eventId);
    this.bound(c);
    c.last = { id: eventId, ts };
  }

  getWatermark(key: string): WatermarkState {
    const c = this.cells.get(key);
    return {
      lastProcessedEventId:   c?.last?.id ?? null,
      lastProcessedTimestamp: c?.last?.ts ?? 0,
    };
  }

  private bound(c: Cell): void {
    while (c.seen.size > SEEN_CAP) {
      const oldest = c.seen.values().next().value as string | undefined;
      if (oldest === undefined) break;
      c.seen.delete(oldest);
    }
  }
}
