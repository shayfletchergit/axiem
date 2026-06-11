/**
 * scripts/worker.ts
 *
 * Phase B integration — the single always-on recompute worker.
 *
 * Runs a startup sweep (crash/restart recovery: pending work is durable in the
 * DB, so a fresh process simply rebuilds anything dirty), then sweeps on an
 * interval. No queue, no distributed coordination — one process for ≤50 users.
 *
 * Run:  npx tsx scripts/worker.ts        (or `npm run worker`)
 * Needs the same env as the app (Supabase service-role credentials).
 */

import { runSweep } from "@/lib/runtime/sweep";

const INTERVAL_MS = 12_000;   // 10–15s acceptable for behavioural analytics
let running = false;

async function tick(): Promise<void> {
  if (running) return;        // never overlap sweeps
  running = true;
  try {
    const r = await runSweep();
    if (r.dirtyAccounts > 0 || r.failures > 0) {
      console.log("[worker] sweep", r);
    }
  } catch (e) {
    console.error("[worker] sweep error (contained)", e);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  console.log(`[worker] starting — interval ${INTERVAL_MS}ms; running startup sweep…`);
  await tick();                       // startup recovery sweep
  setInterval(() => { void tick(); }, INTERVAL_MS);
}

void main();
