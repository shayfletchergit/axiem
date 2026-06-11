/**
 * lib/runtime/sweep.ts
 *
 * Phase B integration — the production execution path (wiring only).
 *
 * Finds accounts whose trades are newer than their last session build and runs
 * the EXISTING, unchanged pipeline for them:
 *     rebuildSessionsFromTrades(userId)   (once per user)
 *     rebuildAgameBaseline(userId, accountId)  (per dirty account)
 *
 * No analytics logic here. No queue, no lock service — a single worker calls
 * this on an interval; an in-process guard prevents overlapping rebuilds of the
 * same user. Replay-in-progress accounts are excluded by get_dirty_accounts().
 */

import { createServiceClient } from "@/lib/supabase/server";
import { rebuildSessionsFromTrades } from "@/lib/db/sessions";
import { rebuildAgameBaseline } from "@/lib/db/agame";
import { obs } from "@/lib/runtime/observability";

const inflightUsers = new Set<string>();

export interface SweepResult {
  dirtyAccounts: number;
  usersRebuilt:  number;
  baselines:     number;
  failures:      number;
  durationMs:    number;
}

export async function runSweep(): Promise<SweepResult> {
  const t0 = Date.now();
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc("get_dirty_accounts");
  if (error) throw new Error(`[sweep] get_dirty_accounts failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ user_id: string; account_id: string }>;

  // Group dirty accounts by user — rebuild a user's sessions once, then each
  // dirty account's baseline.
  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byUser.get(r.user_id);
    if (arr) arr.push(r.account_id);
    else byUser.set(r.user_id, [r.account_id]);
  }

  let usersRebuilt = 0;
  let baselines = 0;
  let failures = 0;

  for (const [userId, accounts] of byUser) {
    if (inflightUsers.has(userId)) continue;   // single-process overlap guard
    inflightUsers.add(userId);
    try {
      await rebuildSessionsFromTrades(userId);  // materialises sessions + features
      usersRebuilt += 1;
      for (const accountId of accounts) {
        try {
          await rebuildAgameBaseline(userId, accountId);
          baselines += 1;
        } catch (e) {
          failures += 1;
          obs.recomputeFailure();
          console.error("[sweep] baseline rebuild failed", { userId, accountId, error: String(e) });
        }
      }
    } catch (e) {
      failures += 1;
      obs.recomputeFailure();
      console.error("[sweep] session rebuild failed", { userId, error: String(e) });
    } finally {
      inflightUsers.delete(userId);
    }
  }

  const durationMs = Date.now() - t0;
  obs.recompute(durationMs);
  return { dirtyAccounts: rows.length, usersRebuilt, baselines, failures, durationMs };
}
