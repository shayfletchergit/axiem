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
  const snapshot = buildDashboardSnapshot({
    report,
    systemState: report.system_state,
    connected: true,
    now,
  });

  return NextResponse.json({ account, accounts: owned, snapshot });
}
