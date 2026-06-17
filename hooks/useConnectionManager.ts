"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ConnectionManager } from "@/lib/broker/ConnectionManager";
import type {
  ConnectionState,
  TradovateEnv,
  TradeEvent,
  ReconciliationResult,
  Execution,
} from "@/lib/broker/types";
import type { CompactRail } from "@/lib/realtime/railPubsub";

/** Latest live RAIL state pushed over SSE (~250 ms cadence). */
export interface LiveRail { account: string; rail: CompactRail; ts: number }

export type { ConnectionState, TradovateEnv };

interface UseConnectionManagerOptions {
  onTradeOpened?: (event: TradeEvent) => void;
  onTradeClosed?: (event: TradeEvent) => void;
  onReconciliationWarning?: (result: ReconciliationResult) => void;
}

export function useConnectionManager(opts: UseConnectionManagerOptions = {}) {
  const managerRef = useRef<ConnectionManager | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [recentFills, setRecentFills] = useState<Execution[]>([]);
  const [liveRail, setLiveRail] = useState<LiveRail | null>(null);

  const [state, setState] = useState<ConnectionState>({
    status: "disconnected",
    mode: null,
    env: "demo",
    accountName: null,
    lastSyncAt: null,
    error: null,
    dupCount: 0,
    lastReconciliation: null,
  });

  if (!managerRef.current) {
    managerRef.current = new ConnectionManager();
  }

  useEffect(() => {
    const mgr = managerRef.current!;

    const unsub = [
      mgr.on("state-change", (s) => setState({ ...s })),
      mgr.on("trade_opened", (e) => optsRef.current.onTradeOpened?.(e)),
      mgr.on("trade_closed", (e) => optsRef.current.onTradeClosed?.(e)),
      mgr.on("reconciliation-warning", (r) =>
        optsRef.current.onReconciliationWarning?.(r),
      ),
    ];

    // Subscribe to SSE stream — receives executions pushed by extension/agent
    const es = new EventSource("/api/stream");
    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "execution" && msg.execution) {
          mgr.injectExecution(msg.execution);
          setRecentFills((prev) => [msg.execution as Execution, ...prev].slice(0, 30));
        } else if (msg.type === "rail" && msg.rail) {
          setLiveRail({ account: msg.account as string, rail: msg.rail as CompactRail, ts: msg.ts as number });
        }
      } catch {}
    };

    return () => {
      unsub.forEach((fn) => fn());
      es.close();
      mgr.disconnect();
    };
  }, []);

  const connectWithCredentials = useCallback(
    (username: string, password: string, env: TradovateEnv) =>
      managerRef.current!.connectWithCredentials(username, password, env),
    [],
  );

  const connectWithToken = useCallback(
    (token: string, env: TradovateEnv) =>
      managerRef.current!.connectWithToken(token, env),
    [],
  );

  const disconnect = useCallback(() => managerRef.current!.disconnect(), []);

  return { state, recentFills, liveRail, connectWithCredentials, connectWithToken, disconnect };
}
