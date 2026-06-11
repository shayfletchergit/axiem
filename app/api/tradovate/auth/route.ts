/**
 * POST /api/tradovate/auth — exchange a user's Tradovate credentials for an
 * access token.
 *
 * SECURITY (Phase B launch fix):
 *   - Requires an authenticated Supabase session (no open relay).
 *   - NEVER logs credentials, tokens, or the raw broker response body.
 *   - Does NOT return the raw broker payload to the client (no `_raw`); only the
 *     access token the authenticated owner needs for their own broker calls.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE: Record<string, string> = {
  demo: "https://demo-api-d.tradovate.com/v1",
  live: "https://live-api-d.tradovate.com/v1",
};

export async function POST(req: NextRequest) {
  // ── Require an authenticated Axiem session ────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { username, password, env = "demo" } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }
  const base = BASE[env] ?? BASE.demo;

  try {
    const res = await fetch(`${base}/auth/accesstokenrequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: username,
        password,
        appId: "Sample App",
        appVersion: "1.0",
        cid: 0,
        sec: "",
      }),
    });
    const data = await res.json();

    // SECURITY: do NOT log credentials, tokens, or the raw broker body.
    if (!res.ok || data.errorText || data["p-ticket"]) {
      const msg = data.errorText
        ? String(data.errorText)
        : data["p-ticket"]
          ? "Additional verification required"
          : "Authentication failed";
      return NextResponse.json({ error: msg }, { status: 401 }); // no raw payload
    }

    // Only the fields the authenticated owner needs — no raw payload echo.
    return NextResponse.json({
      accessToken: data.accessToken,
      expirationTime: data.expirationTime,
      userId: data.userId,
      name: data.name,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Tradovate" }, { status: 502 });
  }
}
