export type TradovateEnv = "demo" | "live";

export interface Execution {
  id: string;
  brokerExecId: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  timestamp: string;
  receivedAt: number;
  orderId?: string;
}

export interface AgentSettings {
  axiemUrl: string;
  webhookSecret: string;
  // Tradovate direct connection
  tradovateEnabled: boolean;
  tradovateToken: string;
  tradovateEnv: TradovateEnv;
  // File watch
  fileWatchEnabled: boolean;
  watchPaths: string[];         // paths to watch for CSV trade files
}

export const DEFAULT_SETTINGS: AgentSettings = {
  axiemUrl: "http://localhost:3000",
  webhookSecret: "axiem-dev-secret-change-in-production",
  tradovateEnabled: false,
  tradovateToken: "",
  tradovateEnv: "demo",
  fileWatchEnabled: false,
  watchPaths: [],
};

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "polling" | "error";

export interface AgentStatus {
  tradovate: ConnectionStatus;
  fileWatch: "inactive" | "watching" | "error";
  lastSyncAt: number | null;
  executionCount: number;
  error: string | null;
}
