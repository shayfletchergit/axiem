import type { Execution, TradovateEnv } from "../types";

const WS_BASE: Record<TradovateEnv, string> = {
  demo: "wss://demo.tradovate.com/v1/websocket",
  live: "wss://live.tradovate.com/v1/websocket",
};

// Tradovate WebSocket uses SockJS-style framing:
//   o         → connection open
//   h         → heartbeat from server, respond with []
//   a[...]    → array of message objects
//   c[n,"r"]  → close
//
// Outbound message format:  ROUTE\nID\n\nJSON_BODY
// Auth:  authorize\n1\n\n{"token":"TOKEN"}
// After auth, Tradovate automatically pushes fill events for the authenticated account.

interface TvWsMessage {
  i?: number;         // request ID (responses)
  s?: number;         // HTTP-style status (responses)
  d?: unknown;        // response data
  e?: string;         // event type (push events, e.g. "fill")
}

interface TvFillEntity {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  action: "Buy" | "Sell";
  qty: number;
  price: number;
}

export interface WsAdapterOptions {
  token: string;
  env: TradovateEnv;
  accountId: string;
  onExecutions: (execs: Execution[]) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (msg: string) => void;
}

export class WsAdapter {
  private opts: WsAdapterOptions;
  private ws: WebSocket | null = null;
  private msgId = 1;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts: WsAdapterOptions) {
    this.opts = opts;
  }

  connect(): void {
    this.stopped = false;
    this.ws = new WebSocket(WS_BASE[this.opts.env]);
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (e) => this.onMessage(e.data as string);
    this.ws.onerror = () => this.opts.onError("WebSocket error");
    this.ws.onclose = () => {
      if (!this.stopped) this.opts.onDisconnected();
      this.cleanup();
    };
  }

  disconnect(): void {
    this.stopped = true;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
  }

  private onOpen(): void {
    this.lastMessageAt = Date.now();
    this.send("authorize", { token: this.opts.token });
  }

  private onMessage(raw: string): void {
    this.lastMessageAt = Date.now();

    if (raw === "o") return;               // SockJS open frame
    if (raw === "h" || raw === "[]") {     // heartbeat — echo back
      this.ws?.send("[]");
      return;
    }
    if (raw.startsWith("c")) return;       // close frame

    // Parse a[...] array envelope
    if (!raw.startsWith("a")) return;
    let messages: TvWsMessage[];
    try {
      messages = JSON.parse(raw.slice(1)) as TvWsMessage[];
    } catch {
      return;
    }

    for (const msg of messages) {
      // Auth response
      if (msg.i === 1) {
        if (msg.s === 200) {
          this.opts.onConnected();
          this.startHeartbeat();
          this.startWatchdog();
        } else {
          this.opts.onError("WebSocket auth failed — token may be expired");
          this.disconnect();
        }
        continue;
      }

      // Push event
      if (msg.e === "fill") {
        const payload = msg.d as { entity?: TvFillEntity; entityType?: string };
        const entity = payload?.entity;
        if (entity) {
          this.opts.onExecutions([this.fillToExecution(entity)]);
        }
      }
    }
  }

  private send(route: string, body: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const id = this.msgId++;
    this.ws.send(`${route}\n${id}\n\n${JSON.stringify(body)}`);
  }

  // Outbound heartbeat — keep connection alive when no fills are flowing
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("[]");
    }, 2_500);
  }

  // Watchdog — if no message in 10s the connection is silently dead
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 10_000) {
        this.opts.onError("WebSocket stalled — no messages for 10s");
        this.disconnect();
        if (!this.stopped) this.opts.onDisconnected();
      }
    }, 5_000);
  }

  private cleanup(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.watchdogTimer)  { clearInterval(this.watchdogTimer);  this.watchdogTimer  = null; }
  }

  private fillToExecution(fill: TvFillEntity): Execution {
    return {
      id: `${this.opts.accountId}:${fill.id}`,
      brokerExecId: String(fill.id),
      accountId: this.opts.accountId,
      symbol: String(fill.contractId),
      side: fill.action === "Buy" ? "buy" : "sell",
      qty: fill.qty,
      price: fill.price,
      timestamp: fill.timestamp,
      receivedAt: Date.now(),
      orderId: String(fill.orderId),
    };
  }
}
