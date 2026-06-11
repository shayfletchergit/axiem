/**
 * POST /api/webhook/execution
 *
 * Entry point for all broker fill payloads.
 * The Chrome extension (and future desktop agents) POST here after intercepting fills.
 *
 * Authentication:  x-axiem-secret header → resolved to user_id via profiles table.
 * Processing:      delegated entirely to lib/ingest.ts — this route is intentionally thin.
 * Response:        always 200 with { ok, accepted, skipped, rejected } (INV-A).
 *
 * Payload shape:
 *   { "executions": [ <raw broker fill>, ... ] }
 *
 * The route does NOT parse or validate the fill shape — that is ingest()'s job.
 * This keeps the route stateless and the normalizer testable in isolation.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient }       from "@/lib/supabase/server";
import { ingest }                    from "@/lib/ingest";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Authentication ────────────────────────────────────────────────────────
  const secret = req.headers.get("x-axiem-secret");
  if (!secret || secret.trim() === "") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("webhook_secret", secret)
    .single();

  if (!profile) {
    console.warn("[webhook] unknown secret", { prefix: secret.slice(0, 8) + "…" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = profile.id as string;

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as Record<string, unknown>)["executions"])
  ) {
    return NextResponse.json(
      { error: "body must be { executions: [...] }" },
      { status: 400 },
    );
  }

  const rawFills = (body as Record<string, unknown>)["executions"] as unknown[];

  if (rawFills.length === 0) {
    return NextResponse.json({ ok: true, accepted: 0, skipped: 0, rejected: 0 });
  }

  // ── Ingest ────────────────────────────────────────────────────────────────
  // ingest() never throws (INV-A) — all errors are logged internally and
  // reflected in the returned counters.
  const result = await ingest(userId, rawFills, "tradovate");

  return NextResponse.json({ ok: true, ...result });
}
