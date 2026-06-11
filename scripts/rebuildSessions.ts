/**
 * scripts/rebuildSessions.ts
 *
 * Phase 0 — one-time (and re-runnable) session backfill.
 *
 * Recomputes the derived `sessions` table from existing `trades`. Non-destructive
 * to every other table; idempotent (atomic replace per user). Safe to run as
 * many times as you like.
 *
 * Usage
 * ─────
 *   # one user
 *   npx tsx scripts/rebuildSessions.ts <user_id>
 *
 *   # every user that has trades
 *   npx tsx scripts/rebuildSessions.ts --all
 *
 *   # dry run (segment + report, do NOT write)
 *   npx tsx scripts/rebuildSessions.ts <user_id> --dry-run
 *
 * Requires the same env the app uses (SUPABASE service-role credentials), since
 * it goes through createServiceClient().
 */

import { createServiceClient } from "@/lib/supabase/server";
import { readTradesForSessions, replaceUserSessions, rebuildSessionsFromTrades } from "@/lib/db/sessions";
import { buildSessions } from "@/lib/sessions/segment";

const PAGE_SIZE = 1000;

/** Discover every distinct user_id that has at least one trade. */
async function discoverUserIds(): Promise<string[]> {
  const supabase = createServiceClient();
  const seen = new Set<string>();

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("trades")
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

async function rebuildOne(userId: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    const trades = await readTradesForSessions(userId);
    const sessions = buildSessions(userId, trades);
    console.log(
      `[dry-run] ${userId}: ${trades.length} trades → ${sessions.length} sessions ` +
      `(${sessions.filter((s) => s.eligible_for_analysis).length} eligible, ` +
      `${sessions.filter((s) => s.status === "open").length} open) — NOT written`,
    );
    return;
  }

  const r = await rebuildSessionsFromTrades(userId);
  console.log(
    `[ok] ${r.userId}: ${r.tradesRead} trades → ${r.sessionsWritten} sessions ` +
    `(${r.eligibleCount} eligible, ${r.openCount} open) in ${r.durationMs}ms`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const userArg = args.find((a) => !a.startsWith("--"));

  if (!all && !userArg) {
    console.error("usage: npx tsx scripts/rebuildSessions.ts <user_id> | --all [--dry-run]");
    process.exit(1);
  }

  const userIds = all ? await discoverUserIds() : [userArg as string];
  console.log(`rebuilding sessions for ${userIds.length} user(s)${dryRun ? " (dry run)" : ""}…\n`);

  let ok = 0;
  let fail = 0;
  for (const uid of userIds) {
    try {
      await rebuildOne(uid, dryRun);
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
