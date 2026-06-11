// Direct Tradovate connection — no CORS because this runs in Node.js, not a browser.
// Supports both WebSocket (real-time) and REST polling fallback.

import WebSocket from "ws";
import type { Execution, TradovateEnv } from "../types";

const REST_BASE: Record<TradovateEnv, string> = {
  demo: "https://demo-api-d.tradovate.com/v1",
  live: "https://live-api-d.tradovate.com/v1",
};

const WS_URL: Record<TradovateEnv, string> = {
  demo: "wss://demo-api-d.tradovate.com/v1/websocket",
  live: "wss://live-api-d.tradovate.com/v1/websocket",
};

interface TvFill {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  action: "Buy" | "Sell";
  qty: number;
  price: number;
}

function fillToExecution(fill: TvFill, accountId: string): Execution {
  return {
    id: `tradovate:${fill.id}`,
    brokerExecId: String(fill.id),
    accountId,
    symbol: String(fill.contractId),
    side: fill.action === "Buy" ? "buy" : "sell",
    qty: fill.qty,
    price: fill.price,
    timestamp: fill.timestamp,
    receivedAt: Date.now(),
    orderId: String(fill.orderId),
  };
}

export class TradovateConnector {
  private token: string;
  private env: TradovateEnv;
  private onExecutions: (execs: Execution[]) => void;
  private onStatusChange: (status: string) => void;

  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cursor: string | null = null;
  private seen = new Set<string>();
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(
    token: string,
    env: TradovateEnv,
    onExecutions: (execs: Execution[]) => void,
    onStatusChange: (status: string) => void,
  ) {
    this.token = token;
    this.env = env;
    this.onExecutions = onExecutions;
    this.onStatusChange = onStatusChange;
  }

  start(): void {
    this.stopped = false;
    this.cursor = new Date().toISOString();
    this.tryWebSocket();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  private tryWebSocket(): void {
    this.onStatusChange("connecting");
    this.ws = new WebSocket(WS_URL[this.env]);

    let heartbeat: ReturnType<typeof setInterval> | null = null;

    this.ws.on("open", () => {
      this.ws!.send(`authorize\n1\n\n${JSON.stringify({ token: this.token })}`);
    });

    this.ws.on("message", (raw) => {
      const data = raw.toString();
      console.log("[TradovateWS] raw:", data.slice(0, 120));
      if (data === "o") return;
      if (data === "h" || data === "[]") { this.ws?.send("[]"); return; }
      if (data.startsWith("c")) return;
      if (!data.startsWith("a")) return;

      let msgs: Array<{ i?: number; s?: number; e?: string; d?: unknown }>;
      try { msgs = JSON.parse(data.slice(1)); } catch { return; }

      for (const msg of msgs) {
        if (msg.i === 1) {
          if (msg.s === 200) {
            this.reconnectAttempts = 0;
            this.onStatusChange("connected");
            heartbeat = setInterval(() => this.ws?.send("[]"), 2_500);
          } else {
            console.error("[TradovateWS] auth failed, status:", msg.s, "body:", JSON.stringify(msg));
            this.onStatusChange("error");
            this.ws?.close();
          }
        }
        if (msg.e === "fill") {
          const entity = (msg.d as { entity?: TvFill })?.entity;
          if (entity) this.handleFills([entity]);
        }
      }
    });

    this.ws.on("close", () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (!this.stopped) {
        this.onStatusChange("disconnected");
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= 3) {
          this.fallbackToPolling();
        } else {
          const delay = 2_000 * this.reconnectAttempts;
          setTimeout(() => { if (!this.stopped) this.tryWebSocket(); }, delay);
        }
      }
    });

    this.ws.on("error", (err) => {
      console.error("[TradovateWS] error:", err.message);
      this.onStatusChange("error");
    });
  }

  // ── REST polling fallback ────────────────────────────────────────────────

  private fallbackToPolling(): void {
    this.onStatusChange("polling");
    let activeUntil = 0;

    const poll = async () => {
      try {
        const url = this.cursor
          ? `${REST_BASE[this.env]}/fill/list?since=${encodeURIComponent(this.cursor)}`
          : `${REST_BASE[this.env]}/fill/list`;

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
        });

        if (res.status === 401) {
          this.onStatusChange("error");
          this.stop();
          return;
        }

        if (res.ok) {
          const fills = (await res.json()) as TvFill[];
          if (fills.length > 0) {
            const latest = fills.reduce(
              (max, f) => (f.timestamp > max ? f.timestamp : max),
              fills[0].timestamp,
            );
            this.cursor = latest;
            activeUntil = Date.now() + 30_000;
            this.handleFills(fills);
          }
        }
      } catch {}

      if (!this.stopped) {
        const interval = Date.now() < activeUntil ? 1_000 : 2_000;
        this.pollTimer = setTimeout(poll, interval) as unknown as ReturnType<typeof setInterval>;
      }
    };

    void poll();
  }

  private handleFills(fills: TvFill[]): void {
    const newFills = fills.filter((f) => !this.seen.has(String(f.id)));
    if (newFills.length === 0) return;
    newFills.forEach((f) => this.seen.add(String(f.id)));
    const execs = newFills.map((f) => fillToExecution(f, "default"));
    this.onExecutions(execs);
  }
}
