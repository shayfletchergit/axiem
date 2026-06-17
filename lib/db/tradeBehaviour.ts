/**
 * lib/db/tradeBehaviour.ts
 *
 * Value Layer v1 — persistence for behavioural trade labels (EDGE dataset).
 *
 * Trades are derived from executions and wiped+rebuilt on every reconstruction,
 * so the trade UUID is not stable — rows are keyed by the natural key
 * (user, account, symbol, opened_at). The fingerprint is stamped on first
 * sighting and is immutable; only pnl back-fills when the trade closes
 * (enforced by the upsert_trade_behaviour RPC).
 *
 * labelSessionBehaviour is best-effort: it runs off the dashboard read so the
 * EDGE dataset accumulates from today. It must NEVER throw into the request path.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { buildFingerprint } from "@/lib/edge/behaviour";
import { cmeSessionStart } from "@/lib/db/rules";
import type { TrustedLiveReport } from "@/lib/agame/trust";

interface SessionTradeRow {
  symbol: string;
  opened_at: string;
  closed_at: string | null;
  net_pnl: number | null;
}

/**
 * Stamp the current behavioural fingerprint onto this account's trades in the
 * current CME session that aren't yet labeled, and back-fill pnl for closed ones.
 *
 * The fingerprint reflects deviation *as observed now*; the RPC preserves the
 * first-seen fingerprint on conflict, so live trades get a near-entry stamp and
 * pre-existing trades a first-sighting stamp (an accepted v1 fidelity limit).
 *
 * @returns number of rows submitted (0 on any soft failure).
 */
export async function labelSessionBehaviour(
  userId: string,
  accountId: string,
  report: TrustedLiveReport,
  now: Date = new Date(),
): Promise<number> {
  try {
    // Only label against a meaningful baseline; calibrating/disconnected feeds
    // carry no comparison, so labeling them would poison the dataset.
    if (report.system_state === "CALIBRATING" || report.system_state === "DISCONNECTED") {
      return 0;
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("trades")
      .select("symbol, opened_at, closed_at, net_pnl")
      .eq("user_id", userId)
      .eq("account_id", accountId)
      .eq("reconstruction_status", "ok")
      .gte("opened_at", cmeSessionStart(now).toISOString());
    if (error || !data || data.length === 0) return 0;

    const fp = buildFingerprint(report);
    const rows = (data as SessionTradeRow[]).map((t) => ({
      account_id:      accountId,
      symbol:          t.symbol,
      opened_at:       t.opened_at,
      heartbeat:       fp.heartbeat,
      dev_trade_count: fp.dev_trade_count,
      dev_pace:        fp.dev_pace,
      dev_size:        fp.dev_size,
      dev_duration:    fp.dev_duration,
      off_dims:        fp.off_dims,
      risk_score:      fp.risk_score,
      pnl:             t.closed_at && t.net_pnl != null ? t.net_pnl : null,
    }));

    const { error: rpcErr } = await supabase.rpc("upsert_trade_behaviour", {
      p_user_id: userId,
      p_rows: rows,
    });
    if (rpcErr) return 0;
    return rows.length;
  } catch {
    // Best-effort: never break the dashboard because labeling hiccupped.
    return 0;
  }
}
