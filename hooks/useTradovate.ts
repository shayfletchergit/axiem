"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { TvFill, TvPosition, CompletedRoundTrip, TradovateEnv } from "@/lib/tradovate";
import { processFills } from "@/lib/tradovate";

const POLL_MS = 30_000; // poll every 30 seconds

export type TradovateStatus = "disconnected" | "connecting" | "connected" | "error";

export interface TradovateState {
  status: TradovateStatus;
  error: string | null;
  env: TradovateEnv;
  accountName: string | null;
}

export function useTradovate(
  onTradeCompleted: (trade: CompletedRoundTrip) => void,
) {
  const [state, setState] = useState<TradovateState>({
    status: "disconnected",
    error: null,
    env: "demo",
    accountName: null,
  });

  const tokenRef     = useRef<string | null>(null);
  const envRef       = useRef<TradovateEnv>("demo");
  const lastSyncRef  = useRef<string | null>(null);  // ISO timestamp of last fill seen
  const positionsRef = useRef<Map<number, TvPosition>>(new Map());
  const seenFillIds  = useRef<Set<number>>(new Set());
  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const fetchFills = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;

    try {
      const url = lastSyncRef.current
        ? `/api/tradovate/fills?since=${encodeURIComponent(lastSyncRef.current)}`
        : "/api/tradovate/fills";

      const res = await fetch(url, {
        headers: {
          "x-tradovate-token": token,
          "x-tradovate-env": envRef.current,
        },
      });

      if (res.status === 401) {
        // Token expired — disconnect
        setState(s => ({ ...s, status: "error", error: "Session expired. Reconnect Tradovate." }));
        stopPolling();
        tokenRef.current = null;
        return;
      }

      const fills: TvFill[] = await res.json();
      if (!Array.isArray(fills) || fills.length === 0) return;

      // Filter to only fills we haven't processed yet
      const newFills = fills.filter(f => !seenFillIds.current.has(f.id));
      if (newFills.length === 0) return;

      newFills.forEach(f => seenFillIds.current.add(f.id));

      // Update the last-seen timestamp
      const latest = newFills.reduce<string | null>((max, f) =>
        max === null || f.timestamp > max ? f.timestamp : max, null,
      );
      if (latest) lastSyncRef.current = latest;

      const { completed, positions } = processFills(newFills, positionsRef.current);
      positionsRef.current = positions;

      completed.forEach(onTradeCompleted);
    } catch {
      // Network error — keep trying
    }
  }, [onTradeCompleted, stopPolling]);

  const connect = useCallback(async (username: string, password: string, env: TradovateEnv) => {
    setState(s => ({ ...s, status: "connecting", error: null, env }));
    envRef.current = env;

    try {
      const res = await fetch("/api/tradovate/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, env }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState(s => ({ ...s, status: "error", error: data.error ?? "Connection failed" }));
        return false;
      }

      tokenRef.current = data.accessToken;
      setState(s => ({
        ...s,
        status: "connected",
        error: null,
        accountName: data.name ?? username,
      }));

      // Seed the last sync to "now" so we only pick up future fills
      lastSyncRef.current = new Date().toISOString();

      // Start polling
      stopPolling();
      await fetchFills(); // immediate first check
      pollRef.current = setInterval(fetchFills, POLL_MS);
      return true;
    } catch {
      setState(s => ({ ...s, status: "error", error: "Could not reach Tradovate" }));
      return false;
    }
  }, [fetchFills, stopPolling]);

  const connectWithToken = useCallback((token: string, env: TradovateEnv) => {
    envRef.current = env;
    tokenRef.current = token;
    lastSyncRef.current = new Date().toISOString();
    setState({ status: "connected", error: null, env, accountName: "Manual token" });
    stopPolling();
    fetchFills();
    pollRef.current = setInterval(fetchFills, POLL_MS);
  }, [fetchFills, stopPolling]);

  const disconnect = useCallback(() => {
    stopPolling();
    tokenRef.current = null;
    positionsRef.current = new Map();
    seenFillIds.current = new Set();
    lastSyncRef.current = null;
    setState({ status: "disconnected", error: null, env: "demo", accountName: null });
  }, [stopPolling]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  return { state, connect, connectWithToken, disconnect };
}
