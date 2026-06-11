/**
 * GET /api/health
 *
 * Production observability endpoint.
 *
 * Returns system health metrics for the authenticated user:
 *   - latest_event_sequence_id  (leading edge of the event log)
 *   - last_rebuilt_event_sequence_id per position
 *   - rebuild_lag per position (latest - last_rebuilt)
 *   - replay_in_progress flags
 *   - overall status: "ok" | "updating" | "replaying" | "error" | "degraded"
 *
 * UI uses this to:
 *   1. Show "Updating trades…" when any position is_stale.
 *   2. Detect stuck rebuilds / replays and surface them as errors.
 *   3. Compare client SSE sequence vs server latest to detect SSE lag.
 *
 * Authentication: standard cookie-based session (same as all dashboard routes).
 * No secret header required — health is per-user, not system-wide.
 *
 * Poll frequency recommendation: every 5 seconds from the client when any
 * position is stale; every 30 seconds when status = "ok".
 */

import { NextResponse }        from "next/server";
import { createClient }        from "@/lib/supabase/server";
import { getSystemHealth }     from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Health snapshot ───────────────────────────────────────────────────────
  try {
    const health = await getSystemHealth(user.id);
    return NextResponse.json(health, {
      headers: {
        // Never cache health responses — they're real-time state
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    // Even health endpoint failures must not expose internals
    console.error("[health] getSystemHealth failed", {
      userId: user.id,
      err:    err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        status:    "error",
        timestamp: new Date().toISOString(),
        error:     "Failed to compute health metrics",
      },
      { status: 500 },
    );
  }
}
