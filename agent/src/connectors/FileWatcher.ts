// Watches a directory for CSV trade files dropped by any broker platform.
// Parses each file and extracts executions.
// Supports: NinjaTrader 8, generic "entry,exit" CSV format.

import chokidar from "chokidar";
import { readFileSync } from "fs";
import { basename } from "path";
import type { Execution } from "../types";

// ── CSV parsers ────────────────────────────────────────────────────────────

function parseNinjaTrader8(csv: string): Execution[] {
  // NT8 Trade Performance export columns:
  // Instrument, Market pos., Quantity, Entry price, Exit price,
  // Entry time, Exit time, Profit, Commission, MAE, MFE, ...
  const lines = csv.split("\n").filter(Boolean);
  const header = lines[0].toLowerCase();
  if (!header.includes("instrument") || !header.includes("entry price")) return [];

  const cols = lines[0].split(",");
  const idx = (name: string) =>
    cols.findIndex((c) => c.toLowerCase().includes(name.toLowerCase()));

  const iInstrument = idx("instrument");
  const iQty        = idx("quantity");
  const iDirection  = idx("market pos");
  const iEntryPrice = idx("entry price");
  const iExitPrice  = idx("exit price");
  const iEntryTime  = idx("entry time");
  const iExitTime   = idx("exit time");

  if ([iInstrument, iQty, iEntryPrice, iExitPrice, iEntryTime].some((i) => i === -1)) {
    return [];
  }

  const executions: Execution[] = [];

  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells.length < 6) continue;

    const symbol     = cells[iInstrument]?.trim();
    const qty        = parseFloat(cells[iQty]);
    const direction  = cells[iDirection]?.trim().toLowerCase();
    const entryPrice = parseFloat(cells[iEntryPrice]);
    const exitPrice  = parseFloat(cells[iExitPrice]);
    const entryTime  = cells[iEntryTime]?.trim();
    const exitTime   = cells[iExitTime]?.trim();

    if (!symbol || isNaN(qty) || isNaN(entryPrice) || isNaN(exitPrice)) continue;

    const entryId = `file:${symbol}:${entryTime}:${entryPrice}`;
    const exitId  = `file:${symbol}:${exitTime}:${exitPrice}`;

    // Entry execution
    executions.push({
      id: entryId,
      brokerExecId: entryId,
      accountId: "default",
      symbol,
      side: direction === "short" ? "sell" : "buy",
      qty,
      price: entryPrice,
      timestamp: new Date(entryTime).toISOString(),
      receivedAt: Date.now(),
    });

    // Exit execution
    executions.push({
      id: exitId,
      brokerExecId: exitId,
      accountId: "default",
      symbol,
      side: direction === "short" ? "buy" : "sell",
      qty,
      price: exitPrice,
      timestamp: new Date(exitTime).toISOString(),
      receivedAt: Date.now(),
    });
  }

  return executions;
}

function parseGenericCSV(csv: string): Execution[] {
  // Generic format: symbol,side,qty,price,timestamp
  const lines = csv.split("\n").filter(Boolean);
  const executions: Execution[] = [];

  for (const line of lines.slice(1)) {
    const [symbol, side, qty, price, timestamp] = line.split(",").map((s) => s.trim());
    if (!symbol || !side || !qty || !price || !timestamp) continue;
    if (side !== "buy" && side !== "sell") continue;

    const id = `file:${symbol}:${timestamp}:${price}`;
    executions.push({
      id,
      brokerExecId: id,
      accountId: "default",
      symbol,
      side: side as "buy" | "sell",
      qty: parseFloat(qty),
      price: parseFloat(price),
      timestamp: new Date(timestamp).toISOString(),
      receivedAt: Date.now(),
    });
  }

  return executions;
}

function parseCSV(filePath: string, content: string): Execution[] {
  const name = basename(filePath).toLowerCase();
  if (name.includes("ninjatrader") || name.includes("nt8")) {
    return parseNinjaTrader8(content);
  }
  return parseGenericCSV(content);
}

// ── Watcher ────────────────────────────────────────────────────────────────

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private processed = new Set<string>();

  constructor(
    private paths: string[],
    private onExecutions: (execs: Execution[]) => void,
    private onStatusChange: (status: "watching" | "error") => void,
  ) {}

  start(): void {
    if (this.paths.length === 0) return;

    this.watcher = chokidar.watch(this.paths, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    this.watcher
      .on("ready", () => this.onStatusChange("watching"))
      .on("add", (p) => this.processFile(p))
      .on("change", (p) => this.processFile(p))
      .on("error", () => this.onStatusChange("error"));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  updatePaths(paths: string[]): void {
    this.stop();
    this.paths = paths;
    this.start();
  }

  private processFile(filePath: string): void {
    if (!filePath.endsWith(".csv")) return;

    try {
      const content = readFileSync(filePath, "utf-8");
      const execs = parseCSV(filePath, content);

      const newExecs = execs.filter((e) => !this.processed.has(e.brokerExecId));
      if (newExecs.length > 0) {
        newExecs.forEach((e) => this.processed.add(e.brokerExecId));
        this.onExecutions(newExecs);
      }
    } catch {}
  }
}
