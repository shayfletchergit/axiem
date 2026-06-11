/**
 * lib/runtime/transportAdapter.ts
 *
 * Phase 2.5 — transport adapter (WRAPPER ONLY).
 *
 * Wraps the EXISTING broker event source (lib/broker ConnectionManager, a
 * TypedEventEmitter) and exposes a tiny, uniform subscription surface to the
 * orchestrator. It introduces NO networking, NO ingestion, NO analytics — it
 * only fans existing events out as fill / disconnect / reconnect callbacks.
 */

// ── Public surface the orchestrator depends on ───────────────────────────────

export interface FillEvent {
  userId:    string;
  accountId: string;
  /** Stable broker event id (`${accountId}:${brokerExecId}`). Used by the
   *  watermark for exactly-once processing. Metadata only — never analytics. */
  eventId?:  string;
  /** Optional live session id, if the source knows it. Used only for boundary
   *  detection metadata — never for computation. */
  sessionId?: string;
  /** Fill time (ms). Metadata only; never an ordering key for analytics. */
  ts:        number;
}

export interface Transport {
  onFill(cb: (e: FillEvent) => void): () => void;
  onDisconnect(cb: () => void): () => void;
  onReconnect(cb: () => void): () => void;
}

// ── Structural view of the existing broker emitter (no hard import/coupling) ──
// Matches lib/broker TypedEventEmitter.on(event, handler) → unsubscribe.

interface BrokerExecution { id: string; accountId: string; timestamp: string }
interface BrokerStateChange { status: string }

export interface BrokerEventSource {
  on(event: "execution", handler: (e: BrokerExecution) => void): () => void;
  on(event: "state-change", handler: (s: BrokerStateChange) => void): () => void;
}

/**
 * Adapter wrapping a broker event source for a single authenticated user.
 *
 * `userId` is the orchestration scope (a broker connection has no notion of our
 * user_id); the caller supplies it when binding the connection to a user.
 */
export class BrokerTransportAdapter implements Transport {
  private readonly fillCbs: Array<(e: FillEvent) => void> = [];
  private readonly disconnectCbs: Array<() => void> = [];
  private readonly reconnectCbs: Array<() => void> = [];
  private readonly unsubs: Array<() => void> = [];
  private lastStatus = "connected";

  constructor(source: BrokerEventSource, private readonly userId: string) {
    // Single subscription to each existing event; fan out internally.
    this.unsubs.push(
      source.on("execution", (e) => {
        const ev: FillEvent = {
          userId: this.userId,
          accountId: e.accountId,
          eventId: e.id,
          ts: Number.isFinite(Date.parse(e.timestamp)) ? Date.parse(e.timestamp) : Date.now(),
        };
        for (const cb of this.fillCbs) cb(ev);
      }),
    );

    this.unsubs.push(
      source.on("state-change", (s) => {
        const prev = this.lastStatus;
        this.lastStatus = s.status;
        if (s.status === "disconnected") {
          for (const cb of this.disconnectCbs) cb();
        } else if (s.status === "connected" && prev !== "connected") {
          for (const cb of this.reconnectCbs) cb();
        }
      }),
    );
  }

  onFill(cb: (e: FillEvent) => void): () => void {
    this.fillCbs.push(cb);
    return () => remove(this.fillCbs, cb);
  }
  onDisconnect(cb: () => void): () => void {
    this.disconnectCbs.push(cb);
    return () => remove(this.disconnectCbs, cb);
  }
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.push(cb);
    return () => remove(this.reconnectCbs, cb);
  }

  /** Unsubscribe from the underlying source. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.fillCbs.length = 0;
    this.disconnectCbs.length = 0;
    this.reconnectCbs.length = 0;
  }
}

function remove<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}
