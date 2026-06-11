import type { Execution, TradovateEnv } from "../types";
import { saveCursor } from "../cursor";

export interface PollAdapterOptions {
  token: string;
  env: TradovateEnv;
  accountId: string;
  cursor: string | null;          // ISO timestamp — fetch fills after this point
  onExecutions: (execs: Execution[]) => void;
  onError?: (err: string) => void;
  onCursorUpdate?: (cursor: string) => void;
}

// Tradovate fill shape from /fill/list
interface TvFill {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  action: "Buy" | "Sell";
  qty: number;
  price: number;
}

function tvFillToExecution(fill: TvFill, accountId: string): Execution {
  return {
    id: `${accountId}:${fill.id}`,
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

export class PollAdapter {
  private opts: PollAdapterOptions;
  private cursor: string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  // Adaptive interval: 1s when active, 2s when idle
  private activeUntil = 0;

  constructor(opts: PollAdapterOptions) {
    this.opts = opts;
    this.cursor = opts.cursor;
  }

  start(): void {
    this.stopped = false;
    this.schedulePoll(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  updateToken(token: string): void {
    this.opts.token = token;
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    try {
      const url = this.cursor
        ? `/api/tradovate/fills?since=${encodeURIComponent(this.cursor)}`
        : "/api/tradovate/fills";

      const res = await fetch(url, {
        headers: {
          "x-tradovate-token": this.opts.token,
          "x-tradovate-env": this.opts.env,
        },
      });

      if (res.status === 401) {
        this.opts.onError?.("Session expired. Reconnect Tradovate.");
        this.stop();
        return;
      }

      if (!res.ok) {
        this.scheduleNext(false);
        return;
      }

      const fills: TvFill[] = await res.json();

      if (Array.isArray(fills) && fills.length > 0) {
        // Advance cursor to the latest fill timestamp
        const latest = fills.reduce<string>(
          (max, f) => (f.timestamp > max ? f.timestamp : max),
          fills[0].timestamp,
        );
        this.cursor = latest;
        saveCursor(this.opts.accountId, latest);
        this.opts.onCursorUpdate?.(latest);

        // Mark active window — poll at 1s for next 30s
        this.activeUntil = Date.now() + 30_000;

        const execs = fills.map((f) => tvFillToExecution(f, this.opts.accountId));
        this.opts.onExecutions(execs);
      }
    } catch {
      // Network error — keep polling, just slower
    }

    this.scheduleNext(true);
  }

  private scheduleNext(success: boolean): void {
    if (this.stopped) return;
    const active = Date.now() < this.activeUntil;
    const interval = active ? 1_000 : 2_000;
    this.schedulePoll(interval);
  }
}
