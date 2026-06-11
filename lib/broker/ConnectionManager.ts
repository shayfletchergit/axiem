import { TypedEventEmitter } from "./EventEmitter";
import { ExecutionProcessor } from "./ExecutionProcessor";
import { WsAdapter } from "./adapters/WsAdapter";
import { PollAdapter } from "./adapters/PollAdapter";
import { loadCursor, saveCursor, clearCursor } from "./cursor";
import { reconcile } from "./reconciliation";
import type {
  ConnectionState,
  ConnectionStatus,
  TradovateEnv,
  TradeEvent,
  TradeEventType,
  Execution,
  DuplicateEvent,
  InvalidExecutionEvent,
  ReconciliationResult,
} from "./types";

type ManagerEvents = {
  [K in TradeEventType]: TradeEvent;
} & {
  "state-change": ConnectionState;
  execution: Execution;
  duplicate: DuplicateEvent;
  invalid: InvalidExecutionEvent;
  "reconciliation-warning": ReconciliationResult;
  error: { source: string; reason: string };
};

const ACCOUNT_ID = "default";

export class ConnectionManager extends TypedEventEmitter<ManagerEvents> {
  private state: ConnectionState = {
    status: "disconnected",
    mode: null,
    env: "demo",
    accountName: null,
    lastSyncAt: null,
    error: null,
    dupCount: 0,
    lastReconciliation: null,
  };

  private processor = new ExecutionProcessor();
  private ws: WsAdapter | null = null;
  private poll: PollAdapter | null = null;
  private token: string | null = null;

  constructor() {
    super();
    this.wireProcessor();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getState(): ConnectionState {
    return { ...this.state };
  }

  async connectWithCredentials(
    username: string,
    password: string,
    env: TradovateEnv,
  ): Promise<boolean> {
    this.setState({ status: "connecting", env, error: null });

    try {
      const res = await fetch("/api/tradovate/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, env }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.setState({ status: "error", error: data.error ?? "Authentication failed" });
        return false;
      }
      this.token = data.accessToken as string;
      this.setState({ accountName: data.name ?? username });
      await this.startConnection(this.token, env);
      return true;
    } catch {
      this.setState({ status: "error", error: "Could not reach Tradovate" });
      return false;
    }
  }

  async connectWithToken(token: string, env: TradovateEnv): Promise<void> {
    this.token = token;
    this.setState({ env, error: null, accountName: "Manual token" });
    await this.startConnection(token, env);
  }

  /** Accept an execution pushed via SSE from the extension or desktop agent. */
  injectExecution(execution: unknown): void {
    try {
      this.processor.process(execution as import("./types").Execution);
      this.setState({ lastSyncAt: Date.now() });
    } catch {}
  }

  disconnect(): void {
    this.stopAdapters();
    this.processor.reset();
    this.token = null;
    clearCursor(ACCOUNT_ID);
    this.setState({
      status: "disconnected",
      mode: null,
      accountName: null,
      lastSyncAt: null,
      error: null,
      dupCount: 0,
      lastReconciliation: null,
    });
  }

  // ── Connection orchestration ──────────────────────────────────────────────

  private async startConnection(token: string, env: TradovateEnv): Promise<void> {
    this.stopAdapters();

    // Load cursor — two-layer: localStorage first, then server
    const cursor = await loadCursor(ACCOUNT_ID);
    const effectiveCursor = cursor ?? new Date().toISOString();

    // Reconcile on connect before starting the fill stream
    void this.runReconciliation(token, env);

    this.tryWebSocket(token, env, effectiveCursor);
  }

  private tryWebSocket(token: string, env: TradovateEnv, cursor: string): void {
    let attempts = 0;

    const attempt = () => {
      attempts++;

      const ws = new WsAdapter({
        token,
        env,
        accountId: ACCOUNT_ID,
        onExecutions: (execs) => {
          this.setState({ lastSyncAt: Date.now() });
          execs.forEach((e) => this.processor.process(e));
        },
        onConnected: () => {
          this.ws = ws;
          this.setState({ status: "connected", mode: "ws" });
        },
        onDisconnected: () => {
          this.ws = null;
          this.setState({ mode: null });

          if (attempts < 3) {
            setTimeout(attempt, 2_000);
          } else {
            // Three WS failures — fall back to polling for this session
            this.setState({ status: "polling", error: "WebSocket unavailable, using polling" });
            this.startPolling(token, env, cursor);
          }
        },
        onError: (msg) => {
          this.setState({ error: msg });
          this.emit("error", { source: "ws", reason: msg });
        },
      });

      ws.connect();
    };

    attempt();
  }

  private startPolling(token: string, env: TradovateEnv, cursor: string): void {
    this.setState({ status: "polling", mode: "polling", error: null });

    this.poll = new PollAdapter({
      token,
      env,
      accountId: ACCOUNT_ID,
      cursor,
      onExecutions: (execs) => {
        this.setState({ lastSyncAt: Date.now() });
        execs.forEach((e) => this.processor.process(e));
      },
      onError: (err) => {
        this.setState({ status: "error", error: err });
        this.poll?.stop();
        this.emit("error", { source: "poll", reason: err });
      },
    });

    this.poll.start();
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  private async runReconciliation(token: string, env: TradovateEnv): Promise<void> {
    try {
      const computedPositions = this.processor.getEngine().getPositions();
      const result = await reconcile(token, env, computedPositions);
      this.setState({ lastReconciliation: result });

      if (!result.matched) {
        this.emit("reconciliation-warning", result);
      }
    } catch {
      // Reconciliation is best-effort — never block the connection on failure
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private stopAdapters(): void {
    this.ws?.disconnect();
    this.poll?.stop();
    this.ws = null;
    this.poll = null;
  }

  private wireProcessor(): void {
    const fwd = (type: TradeEventType) =>
      this.processor.on(type, (event) => this.emit(type, event));

    fwd("trade_opened");
    fwd("trade_scaled");
    fwd("trade_partially_closed");
    fwd("trade_closed");

    this.processor.on("execution", (e) => this.emit("execution", e));

    this.processor.on("duplicate", (e) => {
      this.setState({ dupCount: e.totalSeen });
      this.emit("duplicate", e);
    });

    this.processor.on("invalid", (e) => {
      this.emit("invalid", e);
      this.emit("error", { source: "processor", reason: `Invalid execution: ${e.reason}` });
    });

    this.processor.on("error", (e) => {
      this.emit("error", { source: "diff-engine", reason: e.reason });
    });
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("state-change", { ...this.state });
  }
}
