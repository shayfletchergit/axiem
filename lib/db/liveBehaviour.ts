/**
 * lib/db/liveBehaviour.ts
 *
 * Phase 1.5 — integration layer for the Live Behaviour Deviation Engine.
 *
 * Read-only. Fetches the active session (open|provisional, latest) and the
 * stored A-Game baseline, then runs the pure deviation engine. Touches nothing
 * else — no ingestion, no trades, no session/baseline recomputation.
 *
 * Performance: two indexed reads + a microsecond pure compute. Safe for polling
 * / SSE. (`sessions_user_account_idx` and `agame_baseline_user_account_uniq`
 * cover both queries.)
 *
 * Note on user scope: the spec signature is getLiveBehaviourReport(account_id),
 * but sessions/baseline are keyed by (user_id, account_id) under RLS, so the
 * userId is required to scope the service-role read. Signature is therefore
 * (userId, accountId).
 */

import { createServiceClient } from "@/lib/supabase/server";
import { getAgameBaseline } from "@/lib/db/agame";
import { computeLiveDeviation, selectActiveSession } from "@/lib/agame/liveDeviation";
import { applyTrustLayer } from "@/lib/agame/trust";
import type { ActiveSessionInput } from "@/lib/agame/types";
import type { TrustedLiveReport, TrustRuntime } from "@/lib/agame/trust";
import type { SessionFeatureVector } from "@/lib/sessions/types";

/**
 * Fetch the active (open|provisional) session for a (user, account).
 * Returns null when the account is flat / between sessions.
 */
export async function getActiveSession(
  userId: string,
  accountId: string,
): Promise<ActiveSessionInput | null> {
  const supabase = createServiceClient();

  // Only open/provisional sessions can be "active". There are normally 0–1 of
  // these; fetch the small set and apply the pure selector for testable,
  // deterministic selection.
  const { data, error } = await supabase
    .from("sessions")
    .select("session_id, status, start_ts, feature_vector, computed_at")
    .eq("user_id", userId)
    .eq("account_id", accountId)
    .in("status", ["open", "provisional"])
    .order("start_ts", { ascending: false })
    .limit(10);

  if (error) throw new Error(`[db/liveBehaviour] getActiveSession failed: ${error.message}`);

  const rows = (data ?? []) as Array<{
    session_id: string;
    status: "open" | "provisional" | "closed";
    start_ts: string;
    feature_vector: SessionFeatureVector | null;
    computed_at: string;
  }>;

  const active = selectActiveSession(rows);
  if (!active) return null;

  return {
    session_id:     active.session_id,
    status:         active.status,
    start_ts:       active.start_ts,
    feature_vector: active.feature_vector,
    computed_at:    active.computed_at,
  };
}

/**
 * Produce the TRUSTED live behaviour report for an account's active session.
 *
 * Runs the (unchanged) deviation engine, then wraps it with the Phase 2 trust
 * layer — system state, freshness, confidence, signal quality, and a
 * non-authoritative risk context.
 *
 * The transport/SSE layer supplies `runtime` so the report can reflect
 * connection loss, recompute windows, and snapshot age:
 *   - `connected: false`  when SSE has dropped       → DISCONNECTED
 *   - `rebuilding: true`  during a sessions/baseline recompute → REBUILDING
 *   - `last_update_ms`    the time of the last real push (for staleness)
 * Defaults assume a fresh, connected poll.
 *
 * @returns Always a TrustedLiveReport — there are no silent failure modes.
 */
export async function getLiveBehaviourReport(
  userId: string,
  accountId: string,
  runtime: TrustRuntime = {},
): Promise<TrustedLiveReport> {
  const now = runtime.now ?? Date.now();

  // Two independent reads; run concurrently for latency.
  const [session, baseline] = await Promise.all([
    getActiveSession(userId, accountId),
    getAgameBaseline(userId, accountId),
  ]);

  const report = computeLiveDeviation(session, baseline, now);

  // Snapshot freshness. If the transport supplied a last-push time, use it.
  // Otherwise (poll case) fall back to when the active session's features were
  // last materialised (`computed_at`) — this honestly surfaces pipeline
  // staleness: if sessions haven't been re-materialised, the feed reads STALE
  // rather than pretending to be live.
  const lastUpdateMs =
    runtime.last_update_ms ??
    (session?.computed_at ? Date.parse(session.computed_at) : now);

  return applyTrustLayer(report, baseline, { ...runtime, now, last_update_ms: lastUpdateMs });
}
