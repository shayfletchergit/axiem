export type TradovateEnv = "demo" | "live";

export interface TvFill {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;       // ISO
  action: "Buy" | "Sell";
  qty: number;
  price: number;
  finallyPaired: boolean;
}

export interface TvPosition {
  contractId: number;
  netQty: number;          // positive = long, negative = short
  avgEntryPrice: number;
  entryMs: number;
}

export interface CompletedRoundTrip {
  contractId: number;
  direction: "long" | "short";
  entryMs: number;
  exitMs: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnlPoints: number;       // raw price diff * qty (unsigned ticks, sign = win/loss)
}

/**
 * Process a sorted list of new fills against current open positions.
 * Returns completed round-trips and the updated open positions map.
 */
export function processFills(
  fills: TvFill[],
  positions: Map<number, TvPosition>,
): { completed: CompletedRoundTrip[]; positions: Map<number, TvPosition> } {
  const completed: CompletedRoundTrip[] = [];
  const next = new Map(positions);

  const sorted = [...fills].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  for (const fill of sorted) {
    const delta  = fill.action === "Buy" ? fill.qty : -fill.qty;
    const fillMs = new Date(fill.timestamp).getTime();
    const pos    = next.get(fill.contractId);

    if (!pos || pos.netQty === 0) {
      // Opening a new position
      next.set(fill.contractId, {
        contractId: fill.contractId,
        netQty: delta,
        avgEntryPrice: fill.price,
        entryMs: fillMs,
      });
      continue;
    }

    if (Math.sign(delta) === Math.sign(pos.netQty)) {
      // Scaling into existing position — update weighted average entry
      const totalQty  = pos.netQty + delta;
      const avgPrice  =
        (pos.avgEntryPrice * Math.abs(pos.netQty) + fill.price * Math.abs(delta)) /
        Math.abs(totalQty);
      next.set(fill.contractId, { ...pos, netQty: totalQty, avgEntryPrice: avgPrice });
      continue;
    }

    // Reducing or closing
    const newQty = pos.netQty + delta;
    const pnlPerUnit =
      pos.netQty > 0
        ? fill.price - pos.avgEntryPrice   // long closed: exit - entry
        : pos.avgEntryPrice - fill.price;  // short closed: entry - exit

    if (newQty === 0) {
      // Full close — log a completed trade
      completed.push({
        contractId: fill.contractId,
        direction: pos.netQty > 0 ? "long" : "short",
        entryMs: pos.entryMs,
        exitMs: fillMs,
        entryPrice: pos.avgEntryPrice,
        exitPrice: fill.price,
        size: Math.abs(pos.netQty),
        pnlPoints: pnlPerUnit * Math.abs(pos.netQty),
      });
      next.delete(fill.contractId);
    } else {
      // Partial close — record as a completed trade for the closed portion
      const closedQty = Math.abs(pos.netQty) - Math.abs(newQty);
      completed.push({
        contractId: fill.contractId,
        direction: pos.netQty > 0 ? "long" : "short",
        entryMs: pos.entryMs,
        exitMs: fillMs,
        entryPrice: pos.avgEntryPrice,
        exitPrice: fill.price,
        size: closedQty,
        pnlPoints: pnlPerUnit * closedQty,
      });
      next.set(fill.contractId, { ...pos, netQty: newQty });
    }
  }

  return { completed, positions: next };
}
