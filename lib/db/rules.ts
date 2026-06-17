/**
 * lib/db/rules.ts
 *
 * Value Layer v1 — persistence for the Prop-Rule Rail.
 *
 * Reads the firm preset catalog and the per-account rule profile, the running
 * equity state, and a realized-P&L summary derived from trades. All writes go
 * through SECURITY DEFINER RPCs (migration 012). Service-role client throughout
 * (callers have already authenticated + scoped userId).
 */

import { createServiceClient } from "@/lib/supabase/server";
import type { RuleProfile, RulePreset, EquityState, DrawdownType } from "@/lib/rules/types";

// ── CME session day (matches trades.ts: roll at 22:00 UTC = 17:00 CT std) ─────

export function cmeSessionStart(now: Date = new Date()): Date {
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayRoll = new Date(todayUtc.getTime() + 22 * 3600 * 1000);
  return now < todayRoll ? new Date(todayRoll.getTime() - 24 * 3600 * 1000) : todayRoll;
}

/** Stable key for the current CME trading day (e.g. "2026-06-17"). */
export function cmeDayKey(now: Date = new Date()): string {
  return cmeSessionStart(now).toISOString().slice(0, 10);
}

// ── Row → domain mappers ──────────────────────────────────────────────────────

type PresetRow = {
  id: string; firm: string; plan_label: string; account_size: number;
  starting_balance: number; profit_target: number | null; max_drawdown: number;
  drawdown_type: DrawdownType; drawdown_lock_at: number | null; drawdown_lock_to: number | null;
  daily_loss_limit: number | null; consistency_pct: number | null;
  min_trading_days: number | null; contract_limit: number | null;
  source_url: string | null; verified_on: string | null; active: boolean;
};

function toPreset(r: PresetRow): RulePreset {
  return {
    id: r.id, accountSize: Number(r.account_size), sourceUrl: r.source_url, active: r.active,
    firm: r.firm, planLabel: r.plan_label, sourcePresetId: r.id,
    startingBalance: Number(r.starting_balance),
    profitTarget: r.profit_target == null ? null : Number(r.profit_target),
    maxDrawdown: Number(r.max_drawdown), drawdownType: r.drawdown_type,
    drawdownLockAt: r.drawdown_lock_at == null ? null : Number(r.drawdown_lock_at),
    drawdownLockTo: r.drawdown_lock_to == null ? null : Number(r.drawdown_lock_to),
    dailyLossLimit: r.daily_loss_limit == null ? null : Number(r.daily_loss_limit),
    consistencyPct: r.consistency_pct == null ? null : Number(r.consistency_pct),
    minTradingDays: r.min_trading_days, contractLimit: r.contract_limit,
    verifiedOn: r.verified_on,
  };
}

type RulesRow = Omit<PresetRow, "id" | "account_size" | "source_url" | "active"> & {
  source_preset_id: string | null;
};

function toProfile(r: RulesRow): RuleProfile {
  return {
    firm: r.firm, planLabel: r.plan_label, sourcePresetId: r.source_preset_id,
    startingBalance: Number(r.starting_balance),
    profitTarget: r.profit_target == null ? null : Number(r.profit_target),
    maxDrawdown: Number(r.max_drawdown), drawdownType: r.drawdown_type,
    drawdownLockAt: r.drawdown_lock_at == null ? null : Number(r.drawdown_lock_at),
    drawdownLockTo: r.drawdown_lock_to == null ? null : Number(r.drawdown_lock_to),
    dailyLossLimit: r.daily_loss_limit == null ? null : Number(r.daily_loss_limit),
    consistencyPct: r.consistency_pct == null ? null : Number(r.consistency_pct),
    minTradingDays: r.min_trading_days, contractLimit: r.contract_limit,
    verifiedOn: r.verified_on,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getRulePresets(): Promise<RulePreset[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("rule_presets").select("*").eq("active", true).order("firm").order("account_size");
  if (error) throw new Error(`[db/rules] getRulePresets failed: ${error.message}`);
  return (data ?? []).map((r) => toPreset(r as PresetRow));
}

export async function getAccountRules(userId: string, accountId: string): Promise<RuleProfile | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("account_rules").select("*")
    .eq("user_id", userId).eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(`[db/rules] getAccountRules failed: ${error.message}`);
  return data ? toProfile(data as RulesRow) : null;
}

export async function getEquityState(userId: string, accountId: string): Promise<EquityState | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("account_equity_state").select("*")
    .eq("user_id", userId).eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(`[db/rules] getEquityState failed: ${error.message}`);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    realizedBalance: Number(r.realized_balance), openPnl: Number(r.open_pnl),
    peakEquity: Number(r.peak_equity), floorLocked: Boolean(r.floor_locked),
    dayKey: (r.day_key as string | null) ?? null,
    dayStartBalance: Number(r.day_start_balance), dayRealizedPnl: Number(r.day_realized_pnl),
    maxDayProfit: Number(r.max_day_profit), updatedAt: String(r.updated_at),
  };
}

/**
 * Realized-P&L summary from trades: lifetime net + today's net (CME session day).
 * Realized balance = startingBalance + lifetimeNet. Used to drive RAIL even before
 * the broker open-P&L tick is wired (open_pnl defaults to 0).
 */
export async function getRealizedPnlSummary(
  userId: string, accountId: string, now: Date = new Date(),
): Promise<{ lifetimeNet: number; dayNet: number; dayKey: string }> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("trades")
    .select("net_pnl, closed_at")
    .eq("user_id", userId).eq("account_id", accountId)
    .eq("reconstruction_status", "ok")
    .not("closed_at", "is", null)
    .not("net_pnl", "is", null);
  if (error) throw new Error(`[db/rules] getRealizedPnlSummary failed: ${error.message}`);

  const dayStart = cmeSessionStart(now).getTime();
  let lifetimeNet = 0, dayNet = 0;
  for (const row of (data ?? []) as Array<{ net_pnl: number; closed_at: string }>) {
    const pnl = Number(row.net_pnl);
    lifetimeNet += pnl;
    if (Date.parse(row.closed_at) >= dayStart) dayNet += pnl;
  }
  return { lifetimeNet, dayNet, dayKey: cmeDayKey(now) };
}

// ── Writes (via RPC) ──────────────────────────────────────────────────────────

export async function setAccountRules(
  userId: string, accountId: string, profile: RuleProfile,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("set_account_rules", {
    p_user_id: userId, p_account_id: accountId,
    p_rules: {
      firm: profile.firm, plan_label: profile.planLabel, source_preset_id: profile.sourcePresetId,
      starting_balance: profile.startingBalance, profit_target: profile.profitTarget,
      max_drawdown: profile.maxDrawdown, drawdown_type: profile.drawdownType,
      drawdown_lock_at: profile.drawdownLockAt, drawdown_lock_to: profile.drawdownLockTo,
      daily_loss_limit: profile.dailyLossLimit, consistency_pct: profile.consistencyPct,
      min_trading_days: profile.minTradingDays, contract_limit: profile.contractLimit,
      verified_on: profile.verifiedOn,
    },
  });
  if (error) throw new Error(`[db/rules] setAccountRules failed: ${error.message}`);
}

export async function saveEquityState(
  userId: string, accountId: string, state: EquityState,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("upsert_account_equity_state", {
    p_user_id: userId, p_account_id: accountId,
    p_state: {
      realized_balance: state.realizedBalance, open_pnl: state.openPnl,
      peak_equity: state.peakEquity, floor_locked: state.floorLocked,
      day_key: state.dayKey, day_start_balance: state.dayStartBalance,
      day_realized_pnl: state.dayRealizedPnl, max_day_profit: state.maxDayProfit,
    },
  });
  if (error) throw new Error(`[db/rules] saveEquityState failed: ${error.message}`);
}
