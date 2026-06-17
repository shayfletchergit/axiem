/**
 * app/api/rail/ingest/route.ts
 *
 * Value Layer v1 — live open-P&L sink. The client (which holds the broker token)
 * computes open P&L from positions × marks and POSTs normalized ticks here.
 *
 * Performance contract (strict):
 *   • DB is read ONCE per (user, account) — at hydrate — to seed the memory layer
 *     (rule profile + realized balance + persisted peak). Subsequent ticks are
 *     pure memory + pure RAIL math: NO DB reads, NO DB writes, NO trade-history
 *     recompute per tick.
 *   • The response returns immediately; delivery to clients is the 250 ms batched
 *     broadcaster's job, not this handler's.
 *
 * Tenant safety: userId comes from the Supabase session. The rule profile is read
 * scoped to that userId, so an entry can only ever be hydrated for the owner.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAccountRules, getEquityState, getRealizedPnlSummary, cmeDayKey,
} from "@/lib/db/rules";
import { hasEntry, hydrate, applyTick } from "@/lib/runtime/liveState";
import { ensureRailBroadcaster } from "@/lib/realtime/railBroadcaster";
import { compactRail } from "@/lib/realtime/railPubsub";
import { isIngestToken, validateIngestToken } from "@/lib/db/ingestTokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Resolve the caller's userId from either a long-lived ingest token (browser
 * extension, cross-origin) or the Supabase session cookie (web app). Token
 * validation is cached, so this adds no per-tick DB cost.
 */
async function resolveUserId(req: NextRequest): Promise<string | null> {
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    const token = authz.slice(7).trim();
    if (isIngestToken(token)) return validateIngestToken(token);
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { account?: string; openPnl?: number; dayRealizedPnl?: number; timestamp?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const account = body.account;
  if (!account) return NextResponse.json({ error: "account is required" }, { status: 400 });

  const openPnl = Number.isFinite(body.openPnl) ? (body.openPnl as number) : 0;
  const dayRealizedPnl = Number.isFinite(body.dayRealizedPnl) ? (body.dayRealizedPnl as number) : undefined;
  const now = Date.now();
  const dayKey = cmeDayKey(new Date(now));

  // ── Hydrate once (the ONLY DB access in this pipeline) ──
  if (!hasEntry(userId, account)) {
    const profile = await getAccountRules(userId, account);
    if (!profile) {
      // No rule profile configured → nothing to compute. Not an error.
      return NextResponse.json({ ok: true, configured: false, rail: null });
    }
    const [summary, prev] = await Promise.all([
      getRealizedPnlSummary(userId, account, new Date(now)),
      getEquityState(userId, account),
    ]);
    hydrate({
      userId, accountId: account, profile,
      realizedBalance: profile.startingBalance + summary.lifetimeNet,
      dayRealizedPnl: summary.dayNet,
      dayKey: summary.dayKey,
      prevEquityState: prev,
    });
  }

  // ── Tick: pure memory + pure RAIL math ──
  const rail = applyTick(userId, account, { openPnl, dayRealizedPnl, dayKey, now });

  // Ensure the 250 ms batched broadcaster is running on this instance.
  ensureRailBroadcaster();

  return NextResponse.json({ ok: true, configured: true, rail: rail ? compactRail(rail) : null });
}
