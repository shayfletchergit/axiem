"use client";

/**
 * components/screens/SessionsLive.tsx
 *
 * Server-backed Session list + detail, fed by GET /api/sessions. No localStorage.
 * Detail reuses the dithered AxiemAtom (compact) for the session's structural
 * deviation vs the A-Game baseline, plus exactly one improvement / one
 * regression / one neutral insight derived from the session deviation.
 */

import { useEffect, useState, useCallback } from "react";
import { AxiemAtom, type AtomMode } from "@/components/hud/AxiemAtom";

type Dev = { trade_count: number | null; pace: number | null; size: number | null; duration: number | null };
interface SessionItem {
  session_id: string;
  start_ts: string;
  end_ts: string;
  trade_count: number;
  status: string;
  eligible: boolean;
  outcome: Record<string, unknown> | null;
  deviation: Dev | null;
}
interface SessionsResponse { account: string | null; baseline_ready: boolean; sessions: SessionItem[]; message?: string }

const C = { ok:"#34B27B", warn:"#D8A23C", bad:"#D2685A", stale:"#6E747C", t1:"#E7E9EC", t2:"#9AA0A8", t3:"#62686F", surface:"#131519", border:"rgba(255,255,255,0.08)" };
const DEV_LABELS: Record<keyof Dev, string> = { trade_count: "Frequency", pace: "Pace", size: "Sizing", duration: "Duration" };
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100) >= 0 ? "+" : ""}${Math.round(v * 100)}%`);
const intensityOf = (d: number | null) => (d == null ? 0 : clamp01(Math.abs(d) / 0.5));
const num = (o: Record<string, unknown> | null, k: string): number | null => (o && o[k] != null ? Number(o[k]) : null);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

export function SessionsLive() {
  const [resp, setResp] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/sessions", { cache: "no-store" });
      if (r.status === 401) { setError("Not signed in."); return; }
      if (!r.ok) { setError(`Server error (${r.status}).`); return; }
      setResp(await r.json()); setError(null);
    } catch { setError("Network error."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <Centered tone={C.bad}>{error}</Centered>;
  if (!resp) return <Centered>Loading sessions…</Centered>;
  if (!resp.sessions.length) return <Centered tone={C.t2}>{resp.message ?? "No sessions yet."}</Centered>;

  const sel = selected ? resp.sessions.find((s) => s.session_id === selected) ?? null : null;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "28px 24px 96px", color: C.t1, fontFamily: "Inter, system-ui, sans-serif" }}>
      {sel ? <Detail s={sel} onBack={() => setSelected(null)} /> : (
        <>
          <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: C.t3, fontFamily: "monospace", fontWeight: 600, marginBottom: 16 }}>Sessions</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
            {resp.sessions.map((s) => <Row key={s.session_id} s={s} onClick={() => setSelected(s.session_id)} />)}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ s, onClick }: { s: SessionItem; onClick: () => void }) {
  const net = num(s.outcome, "net_pnl");
  const win = num(s.outcome, "win_rate");
  const col = net == null ? C.t2 : net > 0 ? C.ok : net < 0 ? C.bad : C.t2;
  return (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", background: C.surface, border: "none", borderBottom: `1px solid ${C.border}`, cursor: "pointer", textAlign: "left", width: "100%", fontFamily: "inherit" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: C.t1 }}>{fmtDate(s.start_ts)}</div>
        <div style={{ fontSize: 11, color: C.t3, fontFamily: "monospace", marginTop: 2 }}>{s.trade_count} trades{win != null ? ` · ${Math.round(win * 100)}% W` : ""}</div>
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 14, color: col }}>{net == null ? "—" : `${net >= 0 ? "+" : "−"}$${Math.abs(Math.round(net))}`}</div>
      <span style={{ color: C.t3, fontSize: 12 }}>›</span>
    </button>
  );
}

function Detail({ s, onBack }: { s: SessionItem; onBack: () => void }) {
  const d = s.deviation;
  const net = num(s.outcome, "net_pnl");
  const win = num(s.outcome, "win_rate");
  const exp = num(s.outcome, "expectancy");

  const intensity = { freq: intensityOf(d?.trade_count ?? null), pace: intensityOf(d?.pace ?? null), size: intensityOf(d?.size ?? null) };
  const present = d ? (["trade_count", "pace", "size", "duration"] as (keyof Dev)[]).filter((k) => d[k] != null) : [];
  const hasData = present.length >= 1;
  const mode: AtomMode = hasData ? "live" : "calibrating";

  // center band from worst deviation
  let band = "Calibrating", bandCol = C.warn;
  if (hasData) {
    const maxAbs = Math.max(...present.map((k) => Math.abs(d![k] as number)));
    band = maxAbs <= 0.15 ? "Aligned" : maxAbs <= 0.30 ? "Drifting" : "Off-baseline";
    bandCol = maxAbs <= 0.15 ? C.ok : maxAbs <= 0.30 ? C.warn : C.bad;
  }

  // exactly one improvement / regression / neutral, by alignment to baseline
  const insights = hasData ? buildInsights(d!, present) : [];

  return (
    <>
      <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.t2, fontFamily: "monospace", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", padding: 0, marginBottom: 16 }}>‹ Sessions</button>
      <div style={{ fontSize: 18, fontWeight: 500 }}>{fmtDate(s.start_ts)}</div>
      <div style={{ display: "flex", gap: 18, marginTop: 6, fontFamily: "monospace", fontSize: 12, color: C.t2 }}>
        <span style={{ color: net == null ? C.t2 : net > 0 ? C.ok : C.bad }}>{net == null ? "—" : `${net >= 0 ? "+" : "−"}$${Math.abs(Math.round(net))}`}</span>
        <span>{s.trade_count} trades</span>
        {win != null && <span>{Math.round(win * 100)}% W/R</span>}
        {exp != null && <span>exp {exp >= 0 ? "+" : ""}{exp.toFixed(1)}</span>}
      </div>

      <div style={{ display: "flex", justifyContent: "center", margin: "20px 0 8px" }}>
        <AxiemAtom intensity={intensity} mode={mode} size={200}>
          <div style={{ fontSize: 8.5, letterSpacing: "0.18em", textTransform: "uppercase", color: C.t3, fontFamily: "monospace" }}>A-Game</div>
          <div style={{ fontSize: 20, fontWeight: 500, color: bandCol }}>{band}</div>
        </AxiemAtom>
      </div>

      {hasData ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {insights.map((ins, i) => <Insight key={i} {...ins} />)}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: C.t2, textAlign: "center", marginTop: 12 }}>Not enough data to compare this session to your A-Game baseline.</div>
      )}
    </>
  );
}

function buildInsights(d: Dev, present: (keyof Dev)[]) {
  const sorted = [...present].sort((a, b) => Math.abs(d[a] as number) - Math.abs(d[b] as number));
  const improvement = sorted[0];
  const regression = sorted[sorted.length - 1];
  const neutral = sorted.length >= 3 ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const line = (k: keyof Dev) => {
    const v = d[k] as number;
    const dir = v < 0 ? "below" : "above";
    return `${DEV_LABELS[k]} ran ${pct(v)} (${dir} baseline).`;
  };
  const out: { tag: "improvement" | "regression" | "neutral"; text: string }[] = [];
  out.push({ tag: "improvement", text: `${DEV_LABELS[improvement]} held closest to your A-Game baseline (${pct(d[improvement])}).` });
  if (regression !== improvement) out.push({ tag: "regression", text: line(regression) });
  if (neutral && neutral !== improvement && neutral !== regression) out.push({ tag: "neutral", text: line(neutral) });
  return out;
}

function Insight({ tag, text }: { tag: "improvement" | "regression" | "neutral"; text: string }) {
  const col = tag === "improvement" ? C.ok : tag === "regression" ? C.bad : C.stale;
  return (
    <div style={{ display: "flex", gap: 12, padding: "12px 14px", border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: col, flexShrink: 0, marginTop: 5 }} />
      <div>
        <div style={{ fontSize: 9.5, fontFamily: "monospace", letterSpacing: "0.1em", textTransform: "uppercase", color: col, marginBottom: 3 }}>{tag}</div>
        <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.55 }}>{text}</div>
      </div>
    </div>
  );
}

function Centered({ children, tone = "#9AA0A8" }: { children: React.ReactNode; tone?: string }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh", color: tone, fontSize: 13, fontFamily: "Inter, system-ui, sans-serif" }}>{children}</div>;
}
