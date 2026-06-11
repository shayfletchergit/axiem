/**
 * lib/db/agame.ts
 *
 * Phase 1 — persistence for the derived `agame_baseline` table.
 *
 * Reads ONLY from `sessions` (their materialised feature_vector + outcome) and
 * writes ONLY to `agame_baseline`. Never touches trades, event_log, ingestion,
 * or reconstruction. Purely additive.
 *
 *     sessions (derived) ──read──▶ computeAgameBaseline() ──write──▶ agame_baseline
 *
 * One baseline per (user, account). Fully recomputable and idempotent.
 *
 * Required schema: supabase/migrations/010_agame_baseline.sql
 */

import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { computeAgameBaseline } from "@/lib/agame/compute";
import type { AgameBaselineCore, SessionForAgame } from "@/lib/agame/types";
import type { SessionFeatureVector, SessionOutcome } from "@/lib/sessions/features";

const PAGE_SIZE = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Read: sessions → SessionForAgame[]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a (user, account)'s sessions in the shape the A-Game engine needs.
 * Reads only the columns it uses; fully paged.
 */
export async function readSessionsForAgame(
  userId: string,
  accountId: string,
): Promise<SessionForAgame[]> {
  const supabase = createServiceClient();
  const out: SessionForAgame[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("sessions")
      .select("session_id, eligible_for_analysis, feature_vector, outcome")
      .eq("user_id", userId)
      .eq("account_id", accountId)
      .order("start_ts", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`[db/agame] readSessionsForAgame failed: ${error.message}`);

    const rows = (data ?? []) as Array<{
      session_id: string;
      eligible_for_analysis: boolean;
      feature_vector: SessionFeatureVector | null;
      outcome: SessionOutcome | null;
    }>;

    for (const r of rows) {
      out.push({
        key:                   r.session_id,
        eligible_for_analysis: r.eligible_for_analysis,
        feature_vector:        r.feature_vector,
        outcome:               r.outcome,
      });
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return out;
}

/** Distinct account_ids that have at least one session for this user. */
export async function listAccountsWithSessions(userId: string): Promise<string[]> {
  const supabase = createServiceClient();
  const seen = new Set<string>();

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("sessions")
      .select("account_id")
      .eq("user_id", userId)
      .order("account_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`[db/agame] listAccountsWithSessions failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ account_id: string }>;
    for (const r of rows) seen.add(r.account_id);
    if (rows.length < PAGE_SIZE) break;
  }

  return [...seen];
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic baseline id, stable across recomputes for a (user, account). */
function baselineId(userId: string, accountId: string): string {
  const hex = createHash("sha1").update(`axiem.agame.v1|${userId}|${accountId}`).digest("hex");
  const c = hex.slice(0, 32).split("");
  c[12] = "5";
  c[16] = ((parseInt(c[16], 16) & 0x3) | 0x8).toString(16);
  const u = c.join("");
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
}

export async function upsertAgameBaseline(baseline: AgameBaselineCore): Promise<void> {
  const supabase = createServiceClient();
  const payload = { id: baselineId(baseline.user_id, baseline.account_id), ...baseline };

  const { error } = await supabase.rpc("upsert_agame_baseline", {
    p_user_id:    baseline.user_id,
    p_account_id: baseline.account_id,
    p_baseline:   payload,
  });

  if (error) throw new Error(`[db/agame] upsert_agame_baseline failed: ${error.message}`);
}

/**
 * Read the stored A-Game baseline for a (user, account). Returns null if none
 * exists yet. Read-only — never recomputes (Phase 1.5 must not trigger rebuild).
 */
export async function getAgameBaseline(
  userId: string,
  accountId: string,
): Promise<AgameBaselineCore | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("agame_baseline")
    .select("*")
    .eq("user_id", userId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (error) throw new Error(`[db/agame] getAgameBaseline failed: ${error.message}`);
  if (!data) return null;

  const r = data as Record<string, unknown>;
  const num = (k: string): number | null => (r[k] == null ? null : Number(r[k]));
  return {
    user_id:                          r.user_id as string,
    account_id:                       r.account_id as string,
    status:                           r.status as AgameBaselineCore["status"],
    session_count:                    Number(r.session_count),
    min_session_threshold:            Number(r.min_session_threshold),
    confidence_score:                 Number(r.confidence_score),
    baseline_stability_score:         Number(r.baseline_stability_score),
    data_coverage_ratio:              Number(r.data_coverage_ratio),
    avg_trade_count:                  num("avg_trade_count"),
    median_trade_count:               num("median_trade_count"),
    trade_count_iqr:                  num("trade_count_iqr"),
    avg_inter_trade_gap_seconds:      num("avg_inter_trade_gap_seconds"),
    median_inter_trade_gap_seconds:   num("median_inter_trade_gap_seconds"),
    pace_iqr:                         num("pace_iqr"),
    avg_session_duration_minutes:     num("avg_session_duration_minutes"),
    median_session_duration_minutes:  num("median_session_duration_minutes"),
    avg_position_size:                num("avg_position_size"),
    median_position_size:             num("median_position_size"),
    size_variance:                    num("size_variance"),
    post_loss_trade_delay_seconds:    num("post_loss_trade_delay_seconds"),
    post_loss_size_change_ratio:      num("post_loss_size_change_ratio"),
    entry_burst_ratio:                num("entry_burst_ratio"),
    avg_expectancy:                   num("avg_expectancy"),
    median_expectancy:                num("median_expectancy"),
    win_rate:                         num("win_rate"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

/** Recompute and persist the A-Game baseline for one (user, account). */
export async function rebuildAgameBaseline(
  userId: string,
  accountId: string,
): Promise<AgameBaselineCore> {
  const sessions = await readSessionsForAgame(userId, accountId);
  const baseline = computeAgameBaseline(userId, accountId, sessions);
  await upsertAgameBaseline(baseline);
  return baseline;
}

/** Recompute baselines for every account a user has sessions in. */
export async function rebuildAllAgameForUser(userId: string): Promise<AgameBaselineCore[]> {
  const accounts = await listAccountsWithSessions(userId);
  const results: AgameBaselineCore[] = [];
  for (const accountId of accounts) {
    results.push(await rebuildAgameBaseline(userId, accountId));
  }
  return results;
}
