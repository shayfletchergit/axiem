/**
 * lib/realtime/railBroadcaster.ts
 *
 * Value Layer v1 — the MANDATORY 250 ms batched RAIL broadcaster.
 *
 * A single interval (per server instance, globalThis-guarded) drains dirty
 * liveState entries and publishes the LATEST state per (user, account). Many
 * open-P&L ticks within a window collapse to one broadcast — we never stream
 * every tick. Started lazily on first ingest; unref'd so it never holds the
 * process open.
 */

import { drainDirty } from "@/lib/runtime/liveState";
import { publishRail } from "@/lib/realtime/railPubsub";

/** Broadcast cadence. Strictly batched — do NOT lower to per-tick. */
export const RAIL_FLUSH_MS = 250;

interface TickerHandle { _stop?: () => void }
const g = globalThis as typeof globalThis & { _axiemRailTicker?: TickerHandle };

/** Idempotently ensure the batched broadcaster is running on this instance. */
export function ensureRailBroadcaster(): void {
  if (g._axiemRailTicker) return;

  const handle: TickerHandle = {};
  g._axiemRailTicker = handle;

  const interval = setInterval(() => {
    const updates = drainDirty(); // latest-wins per key
    for (const u of updates) {
      try { publishRail(u.userId, u.accountId, u.rail); } catch { /* a dead client must not stop the loop */ }
    }
  }, RAIL_FLUSH_MS);

  // Don't keep the event loop alive solely for this ticker.
  (interval as unknown as { unref?: () => void }).unref?.();
  handle._stop = () => clearInterval(interval);
}

/** Stop the broadcaster (tests / shutdown). */
export function stopRailBroadcaster(): void {
  g._axiemRailTicker?._stop?.();
  g._axiemRailTicker = undefined;
}
