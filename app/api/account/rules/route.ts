/**
 * app/api/account/rules/route.ts
 *
 * Value Layer v1 — the firm-picker backend for the RAIL.
 *
 *   GET  /api/account/rules?account=…  → { account, presets, current }
 *   PUT  /api/account/rules            → set the profile (from a preset or custom)
 *
 * Tenant safety: userId comes from the Supabase session; the account is validated
 * against the user's OWN trades (RLS-scoped) before any write, because the write
 * RPC is SECURITY DEFINER and bypasses RLS.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getRulePresets, getAccountRules, setAccountRules } from "@/lib/db/rules";
import type { RuleProfile, RulePreset, DrawdownType } from "@/lib/rules/types";

export const dynamic = "force-dynamic";

const DRAWDOWN_TYPES: DrawdownType[] = ["trailing_intraday", "trailing_eod", "static"];

async function ownedAccounts(
  supabase: Awaited<ReturnType<typeof createClient>>, userId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("trades").select("account_id").eq("user_id", userId).limit(500);
  return Array.from(new Set((data ?? []).map((r) => (r as { account_id: string }).account_id)));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const owned = await ownedAccounts(supabase, user.id);
  const requested = new URL(req.url).searchParams.get("account") ?? undefined;
  const account = requested && owned.includes(requested) ? requested : (owned[0] ?? null);

  const [presets, current] = await Promise.all([
    getRulePresets(),
    account ? getAccountRules(user.id, account) : Promise.resolve(null),
  ]);

  return NextResponse.json({ account, accounts: owned, presets, current });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    account?: string;
    presetId?: string;
    custom?: Partial<RuleProfile>;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const account = body.account;
  if (!account) return NextResponse.json({ error: "account is required" }, { status: 400 });

  const owned = await ownedAccounts(supabase, user.id);
  if (!owned.includes(account)) {
    return NextResponse.json({ error: "Unknown account" }, { status: 403 });
  }

  let profile: RuleProfile;

  if (body.presetId) {
    const presets = await getRulePresets();
    const p = presets.find((x: RulePreset) => x.id === body.presetId);
    if (!p) return NextResponse.json({ error: "Unknown preset" }, { status: 400 });
    // Copy the preset values (denormalised snapshot — see migration 012).
    profile = {
      firm: p.firm, planLabel: p.planLabel, sourcePresetId: p.id,
      startingBalance: p.startingBalance, profitTarget: p.profitTarget,
      maxDrawdown: p.maxDrawdown, drawdownType: p.drawdownType,
      drawdownLockAt: p.drawdownLockAt, drawdownLockTo: p.drawdownLockTo,
      dailyLossLimit: p.dailyLossLimit, consistencyPct: p.consistencyPct,
      minTradingDays: p.minTradingDays, contractLimit: p.contractLimit,
      verifiedOn: p.verifiedOn,
    };
  } else if (body.custom) {
    const c = body.custom;
    if (
      !c.firm || !c.planLabel ||
      typeof c.startingBalance !== "number" || typeof c.maxDrawdown !== "number" ||
      !c.drawdownType || !DRAWDOWN_TYPES.includes(c.drawdownType)
    ) {
      return NextResponse.json(
        { error: "custom requires firm, planLabel, startingBalance, maxDrawdown, drawdownType" },
        { status: 400 },
      );
    }
    profile = {
      firm: c.firm, planLabel: c.planLabel, sourcePresetId: null,
      startingBalance: c.startingBalance, profitTarget: c.profitTarget ?? null,
      maxDrawdown: c.maxDrawdown, drawdownType: c.drawdownType,
      drawdownLockAt: c.drawdownLockAt ?? null, drawdownLockTo: c.drawdownLockTo ?? null,
      dailyLossLimit: c.dailyLossLimit ?? null, consistencyPct: c.consistencyPct ?? null,
      minTradingDays: c.minTradingDays ?? null, contractLimit: c.contractLimit ?? null,
      verifiedOn: c.verifiedOn ?? new Date().toISOString().slice(0, 10),
    };
  } else {
    return NextResponse.json({ error: "Provide presetId or custom" }, { status: 400 });
  }

  await setAccountRules(user.id, account, profile);
  return NextResponse.json({ ok: true, account, current: profile });
}
