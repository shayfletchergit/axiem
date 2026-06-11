import { TypedEventEmitter } from "./EventEmitter";
import { StateDiffEngine } from "./StateDiffEngine";
import type {
  Execution,
  TradeEvent,
  TradeEventType,
  DuplicateEvent,
  InvalidExecutionEvent,
} from "./types";

type ProcessorEvents = { [K in TradeEventType]: TradeEvent } & {
  execution: Execution;
  duplicate: DuplicateEvent;
  invalid: InvalidExecutionEvent;
  error: { execution: Execution; reason: string };
};

function validate(exec: Execution): string | null {
  if (!exec.brokerExecId) return "missing brokerExecId";
  if (!exec.symbol)       return "missing symbol";
  if (exec.qty <= 0)      return `invalid qty: ${exec.qty}`;
  if (exec.price <= 0)    return `invalid price: ${exec.price}`;
  if (!exec.timestamp)    return "missing timestamp";
  return null;
}

export class ExecutionProcessor extends TypedEventEmitter<ProcessorEvents> {
  private seen = new Set<string>();
  private engine = new StateDiffEngine();
  private dupCount = 0;

  process(execution: Execution): void {
    // ── Validate ──────────────────────────────────────────────────────────
    const validationError = validate(execution);
    if (validationError) {
      this.emit("invalid", { execution, reason: validationError });
      return;
    }

    // ── Dedup — emit event instead of silent drop ─────────────────────────
    if (this.seen.has(execution.brokerExecId)) {
      this.dupCount++;
      this.emit("duplicate", {
        brokerExecId: execution.brokerExecId,
        receivedAt: execution.receivedAt,
        totalSeen: this.dupCount,
      });
      return;
    }
    this.seen.add(execution.brokerExecId);
    this.emit("execution", execution);

    // ── Apply to state diff engine ────────────────────────────────────────
    // apply() is atomic — if it throws, engine state is unchanged
    try {
      const events = this.engine.apply(execution);
      for (const event of events) {
        this.emit(event.type, event);
      }
    } catch (err) {
      this.emit("error", {
        execution,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getDupCount(): number {
    return this.dupCount;
  }

  getEngine(): import("./StateDiffEngine").StateDiffEngine {
    return this.engine;
  }

  reset(): void {
    this.seen.clear();
    this.engine.reset();
    this.dupCount = 0;
  }
}
