import type { Execution, Position, BrokerTrade, TradeEvent } from "./types";

interface EngineState {
  positions: Map<string, Position>;
  openTrades: Map<string, BrokerTrade>;
}

function copyState(s: EngineState): EngineState {
  return {
    positions: new Map(s.positions),
    openTrades: new Map(s.openTrades),
  };
}

export class StateDiffEngine {
  private state: EngineState = {
    positions: new Map(),
    openTrades: new Map(),
  };

  /**
   * Apply one execution to the engine.
   *
   * Atomic: works on a state copy, commits only after all mutations succeed.
   * If this throws, the engine state is unchanged — caller can safely retry
   * or skip without leaving partial position state.
   */
  apply(exec: Execution): TradeEvent[] {
    // Work on a shallow copy — do NOT touch this.state until commit
    const next = copyState(this.state);
    const events: TradeEvent[] = [];

    this.applyToState(exec, next, events);

    // Commit atomically — only reached if applyToState did not throw
    this.state = next;
    return events;
  }

  getPositions(): Map<string, Position> {
    return new Map(this.state.positions);
  }

  getOpenTrades(): BrokerTrade[] {
    return Array.from(this.state.openTrades.values());
  }

  reset(): void {
    this.state = { positions: new Map(), openTrades: new Map() };
  }

  // ── Core logic ────────────────────────────────────────────────────────────
  // Operates entirely on `next` — never touches `this.state`

  private applyToState(
    exec: Execution,
    { positions, openTrades }: EngineState,
    events: TradeEvent[],
  ): void {
    const key = exec.symbol;
    const pos = positions.get(key);
    const delta = exec.side === "buy" ? exec.qty : -exec.qty;

    // ── Flat → open new position ───────────────────────────────────────────
    if (!pos || pos.netQty === 0) {
      positions.set(key, {
        symbol: key,
        netQty: delta,
        avgEntryPrice: exec.price,
        openedAt: exec.timestamp,
        updatedAt: exec.timestamp,
        executionIds: [exec.id],
      });

      const trade: BrokerTrade = {
        id: crypto.randomUUID(),
        symbol: key,
        direction: delta > 0 ? "long" : "short",
        status: "open",
        openedAt: exec.timestamp,
        entryPrice: exec.price,
        maxSize: Math.abs(delta),
        closedSize: 0,
        remainingQty: Math.abs(delta),
        executionIds: [exec.id],
      };
      openTrades.set(key, trade);
      events.push({ type: "trade_opened", trade: { ...trade }, trigger: exec });
      return;
    }

    // ── Same direction → scale in ──────────────────────────────────────────
    if (Math.sign(delta) === Math.sign(pos.netQty)) {
      const newQty = pos.netQty + delta;
      const newAvg =
        (pos.avgEntryPrice * Math.abs(pos.netQty) +
          exec.price * Math.abs(delta)) /
        Math.abs(newQty);

      positions.set(key, {
        ...pos,
        netQty: newQty,
        avgEntryPrice: newAvg,
        updatedAt: exec.timestamp,
        executionIds: [...pos.executionIds, exec.id],
      });

      const trade = openTrades.get(key)!;
      const updated: BrokerTrade = {
        ...trade,
        entryPrice: newAvg,
        maxSize: Math.max(trade.maxSize, Math.abs(newQty)),
        remainingQty: Math.abs(newQty),
        executionIds: [...trade.executionIds, exec.id],
      };
      openTrades.set(key, updated);
      events.push({ type: "trade_scaled", trade: { ...updated }, trigger: exec });
      return;
    }

    // ── Opposite direction ─────────────────────────────────────────────────
    const newQty = pos.netQty + delta;
    const pnlPerUnit =
      pos.netQty > 0
        ? exec.price - pos.avgEntryPrice
        : pos.avgEntryPrice - exec.price;

    // Partial close — position shrinks, stays on same side
    if (newQty !== 0 && Math.sign(newQty) === Math.sign(pos.netQty)) {
      const closedQty = Math.abs(pos.netQty) - Math.abs(newQty);
      positions.set(key, {
        ...pos,
        netQty: newQty,
        updatedAt: exec.timestamp,
        executionIds: [...pos.executionIds, exec.id],
      });

      const trade = openTrades.get(key)!;
      const updated: BrokerTrade = {
        ...trade,
        closedSize: trade.closedSize + closedQty,
        remainingQty: Math.abs(newQty),
        executionIds: [...trade.executionIds, exec.id],
      };
      openTrades.set(key, updated);
      events.push({ type: "trade_partially_closed", trade: { ...updated }, trigger: exec });
      return;
    }

    // Full close
    if (newQty === 0) {
      const closedQty = Math.abs(pos.netQty);
      positions.delete(key);

      const trade = openTrades.get(key)!;
      const closed: BrokerTrade = {
        ...trade,
        status: "closed",
        closedAt: exec.timestamp,
        exitPrice: exec.price,
        closedSize: trade.closedSize + closedQty,
        remainingQty: 0,
        pnlPoints: pnlPerUnit * closedQty,
        executionIds: [...trade.executionIds, exec.id],
      };
      openTrades.delete(key);
      events.push({ type: "trade_closed", trade: closed, trigger: exec });
      return;
    }

    // Reversal — execution crosses flat: emit close then open
    const closeQty = Math.abs(pos.netQty);
    const openQty = Math.abs(newQty);

    positions.delete(key);
    const closing = openTrades.get(key)!;
    const closed: BrokerTrade = {
      ...closing,
      status: "closed",
      closedAt: exec.timestamp,
      exitPrice: exec.price,
      closedSize: closing.closedSize + closeQty,
      remainingQty: 0,
      pnlPoints: pnlPerUnit * closeQty,
      executionIds: [...closing.executionIds, exec.id],
    };
    openTrades.delete(key);
    events.push({ type: "trade_closed", trade: closed, trigger: exec });

    positions.set(key, {
      symbol: key,
      netQty: newQty,
      avgEntryPrice: exec.price,
      openedAt: exec.timestamp,
      updatedAt: exec.timestamp,
      executionIds: [exec.id],
    });
    const newTrade: BrokerTrade = {
      id: crypto.randomUUID(),
      symbol: key,
      direction: newQty > 0 ? "long" : "short",
      status: "open",
      openedAt: exec.timestamp,
      entryPrice: exec.price,
      maxSize: openQty,
      closedSize: 0,
      remainingQty: openQty,
      executionIds: [exec.id],
    };
    openTrades.set(key, newTrade);
    events.push({ type: "trade_opened", trade: { ...newTrade }, trigger: exec });
  }
}
