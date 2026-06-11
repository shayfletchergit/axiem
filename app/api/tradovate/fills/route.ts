import { NextRequest, NextResponse } from "next/server";

const BASE: Record<string, string> = {
  demo: "https://demo-api-d.tradovate.com/v1",
  live: "https://live-api-d.tradovate.com/v1",
};

export async function GET(req: NextRequest) {
  const token = req.headers.get("x-tradovate-token");
  const env   = req.headers.get("x-tradovate-env") ?? "demo";
  const since = req.nextUrl.searchParams.get("since"); // ISO timestamp

  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 401 });

  try {
    const url = since
      ? `${BASE[env]}/fill/list?since=${encodeURIComponent(since)}`
      : `${BASE[env]}/fill/list`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: "Tradovate error" }, { status: res.status });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Could not reach Tradovate" }, { status: 502 });
  }
}
