/**
 * scripts/rebuildAgame.ts
 *
 * Phase 1 — recompute A-Game baselines from existing `sessions`.
 *
 * Reads only `sessions`; writes only `agame_baseline`. Idempotent, re-runnable,
 * non-destructive. Run AFTER scripts/rebuildSessions.ts (baselines depend on
 * materialised session features).
 *
 * Usage
 * ─────
 *   npx tsx scripts/rebuildAgame.ts <user_id>      # all accounts for one user
 *   npx tsx scripts/rebuildAgame.ts --all          # every user with sessions
 */

import { createServiceClient } from "@/lib/supabase/server";
import { rebuildAllAgameForUser } from "@/lib/db/agame";

const PAGE_SIZE = 1000;

async function discoverUserIds(): Promise<string[]> {
  const supabase = createServiceClient();
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("sessions")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`discoverUserIds failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) seen.add(r.user_id);
    if (rows.length < PAGE_SIZE) break;
  }
  return [...seen];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const userArg = args.find((a) => !a.startsWith("--"));

  if (!all && !userArg) {
    console.error("usage: npx tsx scripts/rebuildAgame.ts <user_id> | --all");
    process.exit(1);
  }

  const userIds = all ? await discoverUserIds() : [userArg as string];
  console.log(`rebuilding A-Game baselines for ${userIds.length} user(s)…\n`);

  let ok = 0, fail = 0;
  for (const uid of userIds) {
    try {
      const baselines = await rebuildAllAgameForUser(uid);
      for (const b of baselines) {
        console.log(
          `[ok] ${uid} / ${b.account_id}: ${b.status} ` +
          `(${b.session_count} eligible, confidence ${b.confidence_score.toFixed(2)}, ` +
          `coverage ${(b.data_coverage_ratio * 100).toFixed(0)}%)`,
        );
      }
      if (baselines.length === 0) console.log(`[ok] ${uid}: no accounts with sessions`);
      ok++;
    } catch (err) {
      fail++;
      console.error(`[fail] ${uid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\ndone — ${ok} ok, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
