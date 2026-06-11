import type {
  Position,
  ReconciliationResult,
  PositionDiscrepancy,
  TradovateEnv,
} from "./types";

interface TvPosition {
  contractId: number;
  netPos: number;       // Tradovate field name for net quantity
}

/**
 * Fetch broker positions and compare against locally computed positions.
 *
 * Returns a ReconciliationResult.  Does NOT mutate any state —
 * the caller decides what to do with discrepancies (surface to UI only).
 *
 * Never auto-corrects: silent correction destroys audit integrity.
 */
export async function reconcile(
  token: string,
  env: TradovateEnv,
  computedPositions: Map<string, Position>,
): Promise<ReconciliationResult> {
  const res = await fetch("/api/tradovate/positions", {
    headers: {
      "x-tradovate-token": token,
      "x-tradovate-env": env,
    },
  });

  if (!res.ok) {
    throw new Error(`Reconciliation fetch failed: ${res.status}`);
  }

  const brokerList: TvPosition[] = await res.json();

  // Build a broker map: contractId (as string) → netPos
  const brokerMap = new Map<string, number>();
  for (const p of brokerList) {
    if (p.netPos !== 0) {
      brokerMap.set(String(p.contractId), p.netPos);
    }
  }

  const discrepancies: PositionDiscrepancy[] = [];

  // Check everything we think is open against broker
  for (const [symbol, pos] of computedPositions) {
    const brokerQty = brokerMap.get(symbol) ?? 0;
    if (pos.netQty !== brokerQty) {
      discrepancies.push({ symbol, computed: pos.netQty, broker: brokerQty });
    }
  }

  // Check broker-reported positions we don't have locally
  for (const [symbol, brokerQty] of brokerMap) {
    if (!computedPositions.has(symbol)) {
      discrepancies.push({ symbol, computed: 0, broker: brokerQty });
    }
  }

  return {
    matched: discrepancies.length === 0,
    checkedAt: Date.now(),
    discrepancies,
  };
}
