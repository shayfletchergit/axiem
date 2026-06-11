/**
 * app/api/sessions/route.ts
 *
 * Auth-scoped session list for the Session Detail view. Reuses the existing
 * pipeline only: getSessions (materialised sessions) + computeDeviation (each
 * session's structural deviation vs the A-Game baseline). No new analytics.
 *
 * Tenant safety: userId from the session; account validated against the user's
 * own RLS-scoped trades. middleware does not cover /api, so this route self-auths.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessions } from "@/lib/db/sessions";
import { getAgameBaseline } from "@/lib/db/agame";
import { computeDeviation } from "@/lib/agame/deviation";
import type { AgameDeviation } from "@/lib/agame/types";

export const dynamic = "force-dynamic";

const LIMIT = 30;
const num = (r: Record<string, unknown> | null, k: string): number | null =>
  r && r[k] != null ? Number(r[k]) : null;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const requested = new URL(req.url).searchParams.get("account") ?? undefined;

  const { data: tr, error: trErr } = await supabase
    .from("trades").select("account_id, opened_at")
    .eq("user_id", user.id).order("opened_at", { ascending: false }).limit(500);
  if (trErr) return NextResponse.json({ error: trErr.message }, { status: 500 });

  const owned = Array.from(new Set((tr ?? []).map((r) => (r as { account_id: string }).account_id)));
  if (owned.length === 0) {
    return NextResponse.json({ account: null, baseline_ready: false, sessions: [], message: "No sessions yet." });
  }
  const account = requested && owned.includes(requested) ? requested : owned[0];

  const [baseline, rows] = await Promise.all([
    getAgameBaseline(user.id, account),
    getSessions(user.id, account),
  ]);
  const ready = baseline?.status === "ready";

  const sessions = rows.slice(0, LIMIT).map((s) => {
    const fv = s.feature_vector as Record<string, unknown> | null;
    let deviation: AgameDeviation | null = null;
    if (ready && fv) {
      deviation = computeDeviation(baseline!, {
        trade_count: Number(fv.trade_count ?? s.trade_count),
        median_inter_trade_gap_seconds: num(fv, "median_inter_trade_gap_seconds"),
        median_position_size: Number(fv.median_position_size ?? 0),
        session_duration_seconds: Number(fv.session_duration_seconds ?? 0),
      });
    }
    return {
      session_id: s.session_id,
      start_ts: s.start_ts,
      end_ts: s.end_ts,
      trade_count: s.trade_count,
      status: s.status,
      eligible: s.eligible_for_analysis,
      outcome: s.outcome,
      deviation,
    };
  });

  return NextResponse.json({ account, accounts: owned, baseline_ready: ready, sessions });
}
