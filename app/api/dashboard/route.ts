/**
 * app/api/dashboard/route.ts
 *
 * Phase B integration — the production "source of truth" for the UI.
 *
 * Replaces all localStorage-driven intelligence. Returns the full safety-wrapped
 * dashboard snapshot for the authenticated user's account.
 *
 * Tenant safety (launch blocker):
 *   - userId is derived from the Supabase session (auth.getUser), NEVER from
 *     client input.
 *   - the account is validated against the user's OWN trades, read through the
 *     RLS-scoped auth client, so a user can only ever resolve their own accounts.
 *   - `middleware.ts` does not cover /api/*, so this route authenticates itself.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getLiveBehaviourReport } from "@/lib/db/liveBehaviour";
import { buildDashboardSnapshot } from "@/lib/runtime/dashboardContract";
import {
  getAccountRules, getEquityState, getRealizedPnlSummary, saveEquityState,
} from "@/lib/db/rules";
import { applyEquityTick, computeRail, heartbeatFromSeverity } from "@/lib/rules/rail";
import { getRail as getLiveRail } from "@/lib/runtime/liveState";
import { behaviourSeverity } from "@/lib/edge/behaviour";
import { labelSessionBehaviour } from "@/lib/db/tradeBehaviour";
import type { RailState } from "@/lib/rules/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requested = new URL(req.url).searchParams.get("account") ?? undefined;

  // The user's own accounts — RLS-scoped read (tenant-safe by construction).
  const { data, error } = await supabase
    .from("trades")
    .select("account_id, opened_at")
    .eq("user_id", user.id)
    .order("opened_at", { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const owned = Array.from(new Set((data ?? []).map((r) => (r as { account_id: string }).account_id)));
  if (owned.length === 0) {
    return NextResponse.json({
      account: null,
      accounts: [],
      snapshot: null,
      message: "No trades yet — connect your broker and place a trade to see your analytics.",
    });
  }

  // Validate the requested account belongs to the user; else default to most recent.
  const account = requested && owned.includes(requested) ? requested : owned[0];

  const now = Date.now();
  const report = await getLiveBehaviourReport(user.id, account, { now, connected: true });

  // ── RAIL: account-survival state (additive — never breaks the dashboard) ──
  // Only computed when the user has configured a rule profile for this account.
  // Realized balance is derived from trades; open P&L defaults to 0 until the
  // broker open-position tick is wired (intraday trailing will then react live).
  let rail: RailState | null = null;
  let accountSeverity = 0;
  try {
    const profile = await getAccountRules(user.id, account);
    if (profile) {
      const [summary, prev] = await Promise.all([
        getRealizedPnlSummary(user.id, account, new Date(now)),
        getEquityState(user.id, account),
      ]);
      const ticked = applyEquityTick(profile, prev, {
        realizedBalance: profile.startingBalance + summary.lifetimeNet,
        openPnl: 0,
        dayKey: summary.dayKey,
        dayRealizedPnl: summary.dayNet,
        now,
      });
      rail = computeRail(profile, ticked);
      accountSeverity = rail.accountSeverity;
      await saveEquityState(user.id, account, ticked); // persist advanced peak/lock/day

      // Prefer the live in-memory rail (carries real open P&L) so the poll and the
      // 250ms SSE stream agree. Null until the client starts pushing open-P&L ticks.
      const live = getLiveRail(user.id, account);
      if (live) { rail = live; accountSeverity = live.accountSeverity; }
    }
  } catch {
    rail = null; // RAIL is additive; a failure here must not affect behaviour analytics
  }

  // ── Unified Heartbeat: the worse of behavioural and account severity. ──
  // CRITICAL (severity ≥ 0.9) ≡ the Risk-Escalation override.
  const heartbeat = heartbeatFromSeverity(Math.max(behaviourSeverity(report), accountSeverity));

  // ── EDGE dataset: stamp behavioural fingerprints on this session's trades. ──
  await labelSessionBehaviour(user.id, account, report, new Date(now)); // best-effort (never throws)

  const snapshot = buildDashboardSnapshot({
    report,
    systemState: report.system_state,
    connected: true,
    now,
    rail,
    heartbeat,
  });

  return NextResponse.json({ account, accounts: owned, snapshot });
}
