export type TradovateEnv = "demo" | "live";

export interface Execution {
  id: string;             // stable: `${accountId}:${brokerExecId}`
  brokerExecId: string;   // broker's fill ID — primary dedup key
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  timestamp: string;      // ISO — broker clock (metadata only; NOT an ordering key)
  receivedAt: number;     // Date.now() — our clock, cursor fallback
  orderId?: string;
  /**
   * event_sequence_id from event_log — the canonical ordering key.
   * Present when the execution was produced by the event-sourced reducer.
   * Absent when created directly (tests, legacy paths).
   * The reconstructor uses this for order-level sorting when available,
   * falling back to fill_timestamp for backward compatibility.
   */
  sequenceId?: number;
}

export interface Position {
  symbol: string;
  netQty: number;
  avgEntryPrice: number;
  openedAt: string;
  updatedAt: string;
  executionIds: string[];
}

export interface BrokerTrade {
  id: string;
  symbol: string;
  direction: "long" | "short";
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  entryPrice: number;
  exitPrice?: number;
  maxSize: number;
  closedSize: number;
  remainingQty: number;
  pnlPoints?: number;
  executionIds: string[];
}

export type TradeEventType =
  | "trade_opened"
  | "trade_scaled"
  | "trade_partially_closed"
  | "trade_closed";

export interface TradeEvent {
  type: TradeEventType;
  trade: BrokerTrade;
  trigger: Execution;
}

// Dedup visibility — emitted instead of silently dropping
export interface DuplicateEvent {
  brokerExecId: string;
  receivedAt: number;
  totalSeen: number;    // total duplicates this session
}

// Validation rejection — emitted when a fill fails sanity checks
export interface InvalidExecutionEvent {
  execution: Partial<Execution>;
  reason: string;
}

// Reconciliation — compare computed positions vs broker-reported positions
export interface PositionDiscrepancy {
  symbol: string;
  computed: number;   // netQty from StateDiffEngine
  broker: number;     // netQty from broker /positions endpoint
}

export interface ReconciliationResult {
  matched: boolean;
  checkedAt: number;  // Date.now()
  discrepancies: PositionDiscrepancy[];
}

export type ConnectionMode = "ws" | "polling" | null;

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "polling"
  | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  mode: ConnectionMode;
  env: TradovateEnv;
  accountName: string | null;
  lastSyncAt: number | null;
  error: string | null;
  dupCount: number;                       // observable dedup counter
  lastReconciliation: ReconciliationResult | null;
}
