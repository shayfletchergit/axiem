/**
 * lib/broker/positions.ts
 *
 * Value Layer v1 — broker position → open-P&L normalizer + client pusher.
 *
 * Open (unrealized) P&L = Σ netQty × (mark − avgEntryPrice) × pointValue. The
 * broker layer (StateDiffEngine) already tracks open positions with avgEntryPrice
 * and netQty; the only thing it lacks is a live MARK price. This module is the
 * seam where a mark source plugs in — the caller supplies the latest marks (from
 * the broker's quote/md feed) and we emit the normalized event, then push it to
 * the server ingest endpoint that drives RAIL.
 *
 * Runs client-side (the browser holds the broker token). Pure compute is exported
 * separately so it is unit-testable with no network.
 */

import type { Position } from "@/lib/broker/types";

/** The normalized event the RAIL pipeline consumes. */
export interface NormalizedPositionEvent {
  accountId:      string;
  openPnl:        number;            // unrealized, account currency
  positions:      OpenPositionLite[];
  dayRealizedPnl?: number;           // optional: today's realized (sent when a trade closes)
  timestamp:      number;
}

export interface OpenPositionLite {
  symbol:        string;
  netQty:        number;             // signed (long > 0, short < 0)
  avgEntryPrice: number;
  mark:          number;
  pnl:           number;
}

/** Per-symbol point value (USD per 1.0 price move per contract). Default 1. */
export type PointValues = Record<string, number>;

/**
 * Pure open-P&L computation. `marks` maps symbol → latest mark price.
 * Positions without a known mark contribute 0 (we never guess a price).
 */
export function computeOpenPnl(
  positions: Pick<Position, "symbol" | "netQty" | "avgEntryPrice">[],
  marks: Record<string, number>,
  pointValues: PointValues = {},
): { openPnl: number; positions: OpenPositionLite[] } {
  let openPnl = 0;
  const out: OpenPositionLite[] = [];
  for (const p of positions) {
    const mark = marks[p.symbol];
    if (mark == null || !Number.isFinite(mark)) continue;
    const pv = pointValues[p.symbol] ?? 1;
    const pnl = p.netQty * (mark - p.avgEntryPrice) * pv; // sign handled by netQty
    openPnl += pnl;
    out.push({ symbol: p.symbol, netQty: p.netQty, avgEntryPrice: p.avgEntryPrice, mark, pnl });
  }
  return { openPnl: Math.round(openPnl * 100) / 100, positions: out };
}

/** Build the normalized event from positions + marks. */
export function normalizePositionEvent(
  accountId: string,
  positions: Pick<Position, "symbol" | "netQty" | "avgEntryPrice">[],
  marks: Record<string, number>,
  opts: { pointValues?: PointValues; dayRealizedPnl?: number; timestamp?: number } = {},
): NormalizedPositionEvent {
  const { openPnl, positions: lite } = computeOpenPnl(positions, marks, opts.pointValues);
  return {
    accountId,
    openPnl,
    positions: lite,
    dayRealizedPnl: opts.dayRealizedPnl,
    timestamp: opts.timestamp ?? Date.now(),
  };
}

/**
 * Push a normalized event to the server ingest endpoint. Fire-and-forget; the
 * server batches at 250 ms, so callers may emit as often as marks arrive.
 */
export async function pushRailTick(ev: NormalizedPositionEvent): Promise<boolean> {
  try {
    const res = await fetch("/api/rail/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: ev.accountId,
        openPnl: ev.openPnl,
        dayRealizedPnl: ev.dayRealizedPnl,
        timestamp: ev.timestamp,
      }),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}
