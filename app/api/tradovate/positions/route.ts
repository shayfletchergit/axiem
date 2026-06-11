import { NextRequest, NextResponse } from "next/server";

const BASE: Record<string, string> = {
  demo: "https://demo-api-d.tradovate.com/v1",
  live: "https://live-api-d.tradovate.com/v1",
};

export async function GET(req: NextRequest) {
  const token = req.headers.get("x-tradovate-token");
  const env = req.headers.get("x-tradovate-env") ?? "demo";
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 401 });

  try {
    const res = await fetch(`${BASE[env]}/position/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: "Tradovate error" }, { status: res.status });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Could not reach Tradovate" }, { status: 502 });
  }
}
