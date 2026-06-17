/**
 * app/api/account/ingest-tokens/route.ts
 *
 * Value Layer v1 — manage ingest tokens for the live-P&L browser extension.
 *
 *   GET    → list the user's tokens (metadata only; never the secret)
 *   POST   → mint a new token; returns the plaintext ONCE (store it now)
 *   DELETE → revoke a token by id
 *
 * Session-authenticated (web app Settings). The plaintext token is shown exactly
 * once at creation and never persisted in cleartext.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  listIngestTokens, mintIngestToken, revokeIngestToken,
} from "@/lib/db/ingestTokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ tokens: await listIngestTokens(user.id) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let label: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.label === "string") label = body.label.slice(0, 80);
  } catch { /* label is optional */ }

  const { token, id, prefix } = await mintIngestToken(user.id, label);
  // `token` is returned exactly once — the client must store it now.
  return NextResponse.json({ id, prefix, label, token });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let id: string | undefined = new URL(req.url).searchParams.get("id") ?? undefined;
  if (!id) {
    try { id = (await req.json())?.id; } catch { /* fall through */ }
  }
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  await revokeIngestToken(user.id, id);
  return NextResponse.json({ ok: true });
}
