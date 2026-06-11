/**
 * lib/reconstructor.ts
 *
 * Broker-grade, order-aware, 3-layer trade reconstruction pipeline.
 *
 * Pipeline
 * ────────
 *   Layer 1 — Executions  → Order Ledger     (group fills by orderId)
 *   Layer 2 — Order Ledger → Position Ledger  (order-level state machine)
 *   Layer 3 — Position Ledger → Trades        (emit on close / reversal)
 *
 * Hard invariants enforced
 * ────────────────────────
 *   INV-1  Orders are atomic.  Executions are children of orders, never processed solo.
 *   INV-2  No fill-level position math.  qty changes only when a complete order is applied.
 *   INV-3  Reversal = a completed order flips the position direction — not a qty sign flip.
 *   INV-4  Pure function.  No I/O, no module-level state, no side effects.
 *   INV-5  Input contract.  Callers MUST pre-sort by (timestamp ASC, brokerExecId ASC).
 *          This function does NOT re-sort — unsorted input is incorrect input.
 */

import type { Execution } from "./broker/types";

// ─────────────────────────────────────────────────────────────────────────────
// Output types
// ─────────────────────────────────────────────────────────────────────────────

export type ReconstructionStatus = "ok" | "skipped";

export interface ReconstructedTrade {
  /** Locally-generated UUID. Stable per run given identical input order. */
  id: string;
  symbol: string;
  accountId: string;
  direction: "long" | "short";

  /** ISO timestamp of the first entry fill across all entry orders. */
  openedAt: string;
  /** ISO timestamp of the last exit fill. null for live open positions. */
  closedAt: string | null;

  /**
   * Fill-weighted average price across all entry orders.
   * null for complex_reversal (cannot be cleanly attributed) and open trades.
   */
  entryPrice: number | null;
  /**
   * Fill-weighted average price across all exit orders.
   * null for complex_reversal and open trades.
   */
  exitPrice: number | null;

  /** Peak open quantity reached during this trade's lifetime. */
  maxSize: number;

  /**
   * All Execution.id values from every order contributing to this trade.
   * For complex_reversal: includes the reversal order's fills.
   * NOTE: the reversal order's fills also appear in the next trade's executionIds
   *       because the same order atomically closes one position and opens another.
   *       This is the correct order-atomic representation.
   */
  executionIds: string[];

  reconstructionStatus: ReconstructionStatus;

  /**
   * Behavioural tags set by the reconstructor.
   * "complex_reversal" — position flipped direction within a single order.
   * "open"             — position is still live; no exit recorded yet.
   */
  behavioralTags: string[];

  /**
   * Raw price-delta × closedQty in instrument price units (not dollars).
   *   Long:  (exitPrice − entryPrice) × closedQty
   *   Short: (entryPrice − exitPrice) × closedQty
   * null for complex_reversal and open trades.
   * Use netPnl for the dollar value.
   */
  pnlPoints: number | null;

  /**
   * Dollar P&L computed via the instrument tick-value map.
   * null when the instrument is unknown, trade is complex_reversal, or position is open.
   * Commission is NOT deducted here — apply at the persistence layer.
   */
  netPnl: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Order Ledger
// ─────────────────────────────────────────────────────────────────────────────

/** An order is one or more fills sharing the same broker orderId. */
interface OrderLedgerEntry {
  orderId: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  /** Sum of all fill quantities in this order. Drives position math (INV-2). */
  totalQty: number;
  /** Fill-quantity-weighted average price across all executions in this order. */
  avgPrice: number;
  executions: Execution[];
  /** Earliest fill timestamp in this order — used to sort orders chronologically. */
  firstFillTime: Date;
  /** Latest fill timestamp in this order — used as trade closedAt. */
  lastFillTime: Date;
  /**
   * True when orderId was absent or empty on the source execution.
   * Each fill without an orderId becomes its own synthetic single-fill order.
   */
  isSynthetic: boolean;
}

/**
 * Group executions into orders.
 *
 * Grouping key: (accountId, symbol, effectiveOrderId)
 *   — effectiveOrderId = orderId when present, else "__synthetic__${brokerExecId}"
 *
 * INV-1 is enforced here: no execution is processed outside of an order context.
 * INV-5 is respected: executions within a group retain their arrival order
 *        because we iterate the pre-sorted input array sequentially.
 */
function buildOrderLedger(executions: Execution[]): OrderLedgerEntry[] {
  // Accumulate fills into groups.
  // Map key: null-byte composite — safe against any realistic accountId or symbol value.
  const buckets = new Map<string, Execution[]>();

  for (const ex of executions) {
    // An empty or whitespace-only orderId is treated as absent.
    const hasOrderId = !!ex.orderId?.trim();
    const effectiveOrderId = hasOrderId
      ? ex.orderId!
      : `__synthetic__${ex.brokerExecId}`;

    const key = `${ex.accountId}\x00${ex.symbol}\x00${effectiveOrderId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(ex);
  }

  const orders: OrderLedgerEntry[] = [];

  for (const execs of buckets.values()) {
    // Defensive guard (INV-1): all fills in one order must share the same side.
    // Mixed sides within a single orderId should never occur in practice, but if
    // a broker emits them we split into per-fill synthetic orders rather than
    // silently computing wrong position math.
    const sides = new Set(execs.map((e) => e.side));
    if (sides.size > 1) {
      for (const ex of execs) {
        orders.push(makeSyntheticOrder(ex));
      }
      continue;
    }

    const side = execs[0].side;
    const totalQty = execs.reduce((sum, e) => sum + e.qty, 0);
    const weightedPriceSum = execs.reduce((sum, e) => sum + e.price * e.qty, 0);
    const avgPrice = totalQty > 0 ? weightedPriceSum / totalQty : 0;

    const fillTimes = execs.map((e) => new Date(e.timestamp).getTime());
    const firstFillTime = new Date(Math.min(...fillTimes));
    const lastFillTime = new Date(Math.max(...fillTimes));

    orders.push({
      orderId: execs[0].orderId?.trim() || execs[0].brokerExecId,
      accountId: execs[0].accountId,
      symbol: execs[0].symbol,
      side,
      totalQty,
      avgPrice,
      executions: execs,
      firstFillTime,
      lastFillTime,
      isSynthetic: !execs[0].orderId?.trim(),
    });
  }

  return orders;
}

/** Wrap a single fill as its own atomic order (fallback when orderId is absent). */
function makeSyntheticOrder(ex: Execution): OrderLedgerEntry {
  const t = new Date(ex.timestamp);
  return {
    orderId: ex.brokerExecId,
    accountId: ex.accountId,
    symbol: ex.symbol,
    side: ex.side,
    totalQty: ex.qty,
    avgPrice: ex.price,
    executions: [ex],
    firstFillTime: t,
    lastFillTime: t,
    isSynthetic: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Position Ledger (order-level state machine)
// ─────────────────────────────────────────────────────────────────────────────

interface PositionState {
  symbol: string;
  accountId: string;
  /** Signed quantity. Positive = long, negative = short, zero = flat. */
  qty: number;
  /** Running weighted-average entry price. Updated only on scale-in (INV-2). */
  avgEntryPrice: number;
  /** Orders that have built up the current position (entries + scale-ins). */
  openOrders: OrderLedgerEntry[];
  /** Orders that have reduced the current position (partial and full exits). */
  closedOrders: OrderLedgerEntry[];
  lastChangeTime: Date;
}

function makeEmptyPosition(symbol: string, accountId: string): PositionState {
  return {
    symbol,
    accountId,
    qty: 0,
    avgEntryPrice: 0,
    openOrders: [],
    closedOrders: [],
    lastChangeTime: new Date(0),
  };
}

/**
 * Run the position state machine over a set of orders for one (accountId, symbol) pair.
 *
 * Orders MUST arrive pre-sorted by (firstFillTime ASC, orderId ASC).
 * Position qty is updated using order.totalQty only — never per-fill (INV-2).
 *
 * State transitions
 * ─────────────────
 *   FLAT  + any order          → OPEN (new trade starts)
 *   OPEN  + same-direction     → OPEN (scale in; avgEntryPrice updated)
 *   OPEN  + opposite, newQty>0,
 *           same sign as prev  → OPEN (partial close; avgEntryPrice unchanged)
 *   OPEN  + opposite, newQty=0 → FLAT (clean close; trade emitted as "ok")
 *   OPEN  + opposite, sign flip→ OPEN (reversal; prior trade emitted as "skipped";
 *                                       same order opens new position — INV-3)
 */
function runPositionLedger(
  symbol: string,
  accountId: string,
  orders: OrderLedgerEntry[],
): ReconstructedTrade[] {
  const trades: ReconstructedTrade[] = [];
  let pos = makeEmptyPosition(symbol, accountId);
  let maxSize = 0;

  for (const order of orders) {
    // INV-2: position delta is computed from order.totalQty, not from any individual fill.
    const delta = order.side === "buy" ? order.totalQty : -order.totalQty;
    const newQty = pos.qty + delta;

    // ── Opening from flat ────────────────────────────────────────────────────
    if (pos.qty === 0) {
      pos = {
        ...pos,
        qty: newQty,
        avgEntryPrice: order.avgPrice,
        openOrders: [order],
        closedOrders: [],
        lastChangeTime: order.lastFillTime,
      };
      maxSize = Math.abs(newQty);
      continue;
    }

    // ── Scale in (same direction as current position) ────────────────────────
    if (Math.sign(delta) === Math.sign(pos.qty)) {
      const prevAbsQty = Math.abs(pos.qty);
      const addedQty = order.totalQty;
      const newAbsQty = prevAbsQty + addedQty;
      // Weighted-average entry recalculated across all entry orders (INV-2).
      const newAvgEntry =
        (pos.avgEntryPrice * prevAbsQty + order.avgPrice * addedQty) / newAbsQty;

      pos = {
        ...pos,
        qty: newQty,
        avgEntryPrice: newAvgEntry,
        openOrders: [...pos.openOrders, order],
        lastChangeTime: order.lastFillTime,
      };
      maxSize = Math.max(maxSize, Math.abs(newQty));
      continue;
    }

    // ── Opposite-direction orders from this point ────────────────────────────

    // ── Reversal — INV-3 ────────────────────────────────────────────────────
    // Condition: completing this order would flip the position's direction.
    // newQty is nonzero AND its sign is opposite to pos.qty's sign.
    if (newQty !== 0 && Math.sign(newQty) !== Math.sign(pos.qty)) {
      // Emit the position that just reversed as a complex_reversal trade.
      // The reversal order is included because its fills are the reason this
      // trade is being closed and tagged. (INV-3)
      trades.push(
        buildReversalTrade(
          symbol,
          accountId,
          pos.openOrders,
          pos.closedOrders,
          order,
          maxSize,
        ),
      );

      // The same order that caused the reversal ALSO opens the new position.
      // We do not split the order (INV-1). The new position's entry is the
      // reversal order's full avgPrice; its qty is the crossed-over remainder.
      pos = {
        ...pos,
        qty: newQty,
        avgEntryPrice: order.avgPrice,
        openOrders: [order],
        closedOrders: [],
        lastChangeTime: order.lastFillTime,
      };
      maxSize = Math.abs(newQty);
      continue;
    }

    // ── Partial close — position shrinks, stays on the same side ─────────────
    if (newQty !== 0 && Math.sign(newQty) === Math.sign(pos.qty)) {
      // avgEntryPrice is NOT recalculated on exit — only on scale-in (INV-2).
      pos = {
        ...pos,
        qty: newQty,
        closedOrders: [...pos.closedOrders, order],
        lastChangeTime: order.lastFillTime,
      };
      // maxSize does not shrink on scale-out.
      continue;
    }

    // ── Clean close — position returns to flat ───────────────────────────────
    // (newQty === 0 is the only remaining case)
    const exitOrders = [...pos.closedOrders, order];
    trades.push(buildClosedTrade(symbol, accountId, pos.openOrders, exitOrders, maxSize));
    pos = makeEmptyPosition(symbol, accountId);
    maxSize = 0;
  }

  // ── Remaining open position ──────────────────────────────────────────────
  // Emit as a live trade — no exit orders recorded yet.
  if (pos.qty !== 0 && pos.openOrders.length > 0) {
    trades.push(
      buildOpenTrade(symbol, accountId, pos.openOrders, pos.closedOrders, maxSize, pos.qty),
    );
  }

  return trades;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — Trade extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill-quantity-weighted average price across a set of orders.
 * Each order's avgPrice is itself already fill-weighted (computed in Layer 1).
 * This produces the correct two-level weighted average.
 */
function weightedAvgPrice(orders: OrderLedgerEntry[]): number {
  const totalQty = orders.reduce((s, o) => s + o.totalQty, 0);
  if (totalQty === 0) return 0;
  return orders.reduce((s, o) => s + o.avgPrice * o.totalQty, 0) / totalQty;
}

/** Collect every Execution.id from an array of orders in order-then-fill sequence. */
function flattenExecutionIds(orders: OrderLedgerEntry[]): string[] {
  return orders.flatMap((o) => o.executions.map((e) => e.id));
}

/** Earliest firstFillTime across a non-empty order array, as ISO string. */
function earliestTime(orders: OrderLedgerEntry[]): string {
  return orders
    .reduce((min, o) => (o.firstFillTime < min ? o.firstFillTime : min), orders[0].firstFillTime)
    .toISOString();
}

/** Latest lastFillTime across a non-empty order array, as ISO string. */
function latestTime(orders: OrderLedgerEntry[]): string {
  return orders
    .reduce((max, o) => (o.lastFillTime > max ? o.lastFillTime : max), orders[0].lastFillTime)
    .toISOString();
}

/**
 * Raw P&L in instrument price units (not dollars).
 *   Long:  (exitPrice − entryPrice) × closedQty
 *   Short: (entryPrice − exitPrice) × closedQty
 */
function calcPnlPoints(
  direction: "long" | "short",
  entryPrice: number,
  exitPrice: number,
  closedQty: number,
): number {
  return direction === "long"
    ? (exitPrice - entryPrice) * closedQty
    : (entryPrice - exitPrice) * closedQty;
}

/**
 * Per-instrument tick specifications for USD P&L conversion.
 * Key: base instrument code without expiry suffix (e.g. "ES", "NQ", "MES").
 *
 * To add a new instrument: add a row here. Do NOT change the lookup logic.
 * If an instrument is missing, netPnl returns null — callers must not assume zero.
 */
const TICK_SPECS: Readonly<Record<string, { tickSize: number; tickValue: number }>> = {
  // Equity index futures
  ES:   { tickSize: 0.25,    tickValue: 12.50  },  // S&P 500 E-mini
  MES:  { tickSize: 0.25,    tickValue:  1.25  },  // Micro E-mini S&P 500
  NQ:   { tickSize: 0.25,    tickValue:  5.00  },  // Nasdaq-100 E-mini
  MNQ:  { tickSize: 0.25,    tickValue:  0.50  },  // Micro E-mini Nasdaq-100
  RTY:  { tickSize: 0.10,    tickValue:  5.00  },  // Russell 2000 E-mini
  M2K:  { tickSize: 0.10,    tickValue:  0.50  },  // Micro E-mini Russell 2000
  YM:   { tickSize: 1.00,    tickValue:  5.00  },  // DJIA E-mini
  MYM:  { tickSize: 1.00,    tickValue:  0.50  },  // Micro E-mini DJIA
  // Energy
  CL:   { tickSize: 0.01,    tickValue: 10.00  },  // Crude Oil WTI
  MCL:  { tickSize: 0.01,    tickValue:  1.00  },  // Micro Crude Oil
  NG:   { tickSize: 0.001,   tickValue: 10.00  },  // Natural Gas
  RB:   { tickSize: 0.0001,  tickValue:  4.20  },  // RBOB Gasoline
  HO:   { tickSize: 0.0001,  tickValue:  4.20  },  // Heating Oil
  // Metals
  GC:   { tickSize: 0.10,    tickValue: 10.00  },  // Gold
  MGC:  { tickSize: 0.10,    tickValue:  1.00  },  // Micro Gold
  SI:   { tickSize: 0.005,   tickValue: 25.00  },  // Silver
  SIL:  { tickSize: 0.005,   tickValue:  2.50  },  // Micro Silver
  HG:   { tickSize: 0.0005,  tickValue: 12.50  },  // Copper
  // Interest rates
  ZB:   { tickSize: 0.03125, tickValue: 31.25  },  // 30-Year T-Bond
  ZN:   { tickSize: 0.015625,tickValue: 15.625 },  // 10-Year T-Note
  ZF:   { tickSize: 0.0078125,tickValue:7.8125 },  // 5-Year T-Note
  ZT:   { tickSize: 0.00390625,tickValue:3.90625},  // 2-Year T-Note
  // Agriculture
  ZC:   { tickSize: 0.25,    tickValue: 12.50  },  // Corn
  ZS:   { tickSize: 0.25,    tickValue: 12.50  },  // Soybeans
  ZW:   { tickSize: 0.25,    tickValue: 12.50  },  // Wheat
  // FX
  "6E": { tickSize: 0.00005, tickValue:  6.25  },  // Euro FX
  "6J": { tickSize: 0.0000005,tickValue: 6.25  },  // Japanese Yen
  "6B": { tickSize: 0.0001,  tickValue:  6.25  },  // British Pound
};

/**
 * Strip expiry code from an instrument symbol and look up its tick specification.
 *
 * Examples:
 *   "ESM5"   → "ES"   (month=M, year=5)
 *   "MNQZ24" → "MNQ"  (month=Z, year=24)
 *   "ES"     → "ES"   (already bare)
 *
 * Returns null for unknown instruments.
 * The caller must not treat null as zero — it means "unknown, don't display".
 */
function lookupTickSpec(
  symbol: string,
): { tickSize: number; tickValue: number } | null {
  // Try exact match first (bare code or non-standard symbol).
  if (TICK_SPECS[symbol]) return TICK_SPECS[symbol];
  // Strip standard expiry suffix: one CME month letter + 1-2 digit year.
  const base = symbol.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "");
  return TICK_SPECS[base] ?? null;
}

/** Convert pnlPoints to USD. Returns null if instrument spec is not registered. */
function calcNetPnl(symbol: string, pnlPoints: number): number | null {
  const spec = lookupTickSpec(symbol);
  if (!spec) return null;
  const ticks = pnlPoints / spec.tickSize;
  return ticks * spec.tickValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade builders (called from Layer 3 emits in runPositionLedger)
// ─────────────────────────────────────────────────────────────────────────────

function buildClosedTrade(
  symbol: string,
  accountId: string,
  entryOrders: OrderLedgerEntry[],
  exitOrders: OrderLedgerEntry[],
  maxSize: number,
): ReconstructedTrade {
  const direction: "long" | "short" = entryOrders[0].side === "buy" ? "long" : "short";
  const entryPrice = weightedAvgPrice(entryOrders);
  const exitPrice = weightedAvgPrice(exitOrders);
  // closedQty = sum of exit order quantities (handles partial-then-full close sequences).
  const closedQty = exitOrders.reduce((s, o) => s + o.totalQty, 0);
  const pnlPoints = calcPnlPoints(direction, entryPrice, exitPrice, closedQty);
  const netPnl = calcNetPnl(symbol, pnlPoints);

  return {
    id: crypto.randomUUID(),
    symbol,
    accountId,
    direction,
    openedAt: earliestTime(entryOrders),
    closedAt: latestTime(exitOrders),
    entryPrice,
    exitPrice,
    maxSize,
    executionIds: [
      ...flattenExecutionIds(entryOrders),
      ...flattenExecutionIds(exitOrders),
    ],
    reconstructionStatus: "ok",
    behavioralTags: [],
    pnlPoints,
    netPnl,
  };
}

function buildOpenTrade(
  symbol: string,
  accountId: string,
  entryOrders: OrderLedgerEntry[],
  partialExitOrders: OrderLedgerEntry[],
  maxSize: number,
  currentQty: number,
): ReconstructedTrade {
  const direction: "long" | "short" = currentQty > 0 ? "long" : "short";

  return {
    id: crypto.randomUUID(),
    symbol,
    accountId,
    direction,
    openedAt: earliestTime(entryOrders),
    closedAt: null,
    entryPrice: weightedAvgPrice(entryOrders),
    exitPrice: null,
    maxSize,
    executionIds: [
      ...flattenExecutionIds(entryOrders),
      ...flattenExecutionIds(partialExitOrders),
    ],
    reconstructionStatus: "ok",
    behavioralTags: ["open"],
    pnlPoints: null,
    netPnl: null,
  };
}

/**
 * Build a reversal trade record.
 *
 * INV-3: the reversal order is the trigger — it is included in executionIds
 * so the fill audit trail is complete. The same order is ALSO recorded as the
 * entry order for the next position in runPositionLedger. This intentional
 * overlap is the correct order-atomic representation: the order straddles two
 * positions and must appear in both audit trails.
 *
 * entryPrice, exitPrice, pnlPoints, netPnl are all null.
 * Callers must filter reconstructionStatus === "skipped" from P&L aggregations.
 */
function buildReversalTrade(
  symbol: string,
  accountId: string,
  entryOrders: OrderLedgerEntry[],
  exitOrders: OrderLedgerEntry[],
  reversalOrder: OrderLedgerEntry,
  maxSize: number,
): ReconstructedTrade {
  const direction: "long" | "short" = entryOrders[0].side === "buy" ? "long" : "short";
  const allOrders = [...entryOrders, ...exitOrders, reversalOrder];

  return {
    id: crypto.randomUUID(),
    symbol,
    accountId,
    direction,
    openedAt: earliestTime(entryOrders),
    closedAt: reversalOrder.lastFillTime.toISOString(),
    entryPrice: null,
    exitPrice: null,
    maxSize,
    executionIds: flattenExecutionIds(allOrders),
    reconstructionStatus: "skipped",
    behavioralTags: ["complex_reversal"],
    pnlPoints: null,
    netPnl: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct completed trades (and any live open position) from a sorted execution stream.
 *
 * ⚠️  INV-5: Callers are responsible for pre-sorting executions by
 *     (timestamp ASC, brokerExecId ASC) before calling this function.
 *     Unsorted input produces incorrect, non-deterministic output.
 *     Use the query-layer sort — never trust insertion order.
 *
 * Executions may span multiple accounts and instruments.
 * Each (accountId, symbol) pair is reconstructed independently.
 *
 * The function is deterministic: identical sorted input always produces
 * identical trade records (modulo UUID values, which are random per call).
 * For replay-correctness checks, compare fields other than `id`.
 *
 * @param executions - Pre-sorted, deduplicated fills. Deduplication must
 *                     happen at the persistence layer before calling here.
 * @returns Trades ordered chronologically by openedAt within each position group.
 *          complex_reversal trades have reconstructionStatus === "skipped"
 *          and must be excluded from P&L aggregations.
 */
export function reconstructTrades(executions: Execution[]): ReconstructedTrade[] {
  if (executions.length === 0) return [];

  // ── Dev-mode sort assertion ──────────────────────────────────────────────
  // Warns once on first violation. Does not throw — the reconstructor is not
  // the right layer to enforce this (it's the query layer's responsibility).
  if (process.env.NODE_ENV !== "production") {
    for (let i = 1; i < executions.length; i++) {
      if (executions[i].timestamp < executions[i - 1].timestamp) {
        console.warn(
          "[reconstructor] INV-5 VIOLATED: executions not sorted by timestamp.",
          "Trade results may be incorrect. Fix sort order in the calling query.",
          { prev: executions[i - 1].brokerExecId, curr: executions[i].brokerExecId },
        );
        break; // Warn once per call, not per violation.
      }
    }
  }

  // ── Layer 1: Executions → Order Ledger ──────────────────────────────────
  const orders = buildOrderLedger(executions);

  // ── Layer 2: Group orders by position key ───────────────────────────────
  // One position per (accountId × symbol) pair. Null-byte composite key prevents
  // collisions between accountIds or symbols that share a prefix.
  const positionGroups = new Map<
    string,
    { accountId: string; symbol: string; orders: OrderLedgerEntry[] }
  >();

  for (const order of orders) {
    const key = `${order.accountId}\x00${order.symbol}`;
    let group = positionGroups.get(key);
    if (!group) {
      group = { accountId: order.accountId, symbol: order.symbol, orders: [] };
      positionGroups.set(key, group);
    }
    group.orders.push(order);
  }

  // ── Layer 3: Run position state machine per group ────────────────────────
  const allTrades: ReconstructedTrade[] = [];

  for (const { accountId, symbol, orders: posOrders } of positionGroups.values()) {
    // Re-sort orders within each group by (firstFillTime ASC, orderId ASC).
    // This propagates the execution-level sort guarantee to the order level.
    // Two orders with identical firstFillTime are broken by orderId (lexicographic)
    // to guarantee deterministic ordering.
    posOrders.sort((a, b) => {
      const dt = a.firstFillTime.getTime() - b.firstFillTime.getTime();
      return dt !== 0 ? dt : a.orderId.localeCompare(b.orderId);
    });

    const trades = runPositionLedger(symbol, accountId, posOrders);
    allTrades.push(...trades);
  }

  return allTrades;
}

/**
 * Convenience: look up the tick specification for a symbol.
 * Exported for use in display layers and test assertions.
 * Returns null if the instrument is not registered in TICK_SPECS.
 */
export { lookupTickSpec };
export type { OrderLedgerEntry, PositionState };
