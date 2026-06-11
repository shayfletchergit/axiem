"use client";

/**
 * components/screens/OverviewLive.tsx
 *
 * The production Dashboard — a full-bleed HUD control center fed ONLY by the
 * server intelligence pipeline via GET /api/dashboard. Borderless topbar +
 * large left nav + refractive glass mark (AxiemGlass) hero + floating right
 * info column (Today's Overview / Risk Desk / Account Select) + bottom signal
 * cards. Responsive: stacks vertically on narrow widths. No localStorage.
 */

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type { DashboardSnapshot } from "@/lib/runtime/dashboardContract";
import type { Screen } from "@/lib/types";
import { type AtomMode } from "@/components/hud/AxiemAtom";

const AxiemGlass = dynamic(() => import("@/components/hud/AxiemGlass").then((m) => m.AxiemGlass), {
  ssr: false,
  loading: () => <div style={{ width: "100%", height: "100%" }} />,
});

interface DashboardResponse {
  account: string | null;
  accounts: string[];
  snapshot: DashboardSnapshot | null;
  message?: string;
}
interface OverviewLiveProps {
  onNavigate?: (s: Screen) => void;
  current?: Screen;
  userName?: string;
}

const POLL_MS = 5000;

const C = {
  ok: "#34B27B", warn: "#D8A23C", bad: "#D2685A", stale: "#6E747C",
  t1: "#E7E9EC", t2: "#9AA0A8", t3: "#62686F",
  surface: "#131519", border: "rgba(255,255,255,0.08)", bg: "rgba(11,12,14,0.85)",
};
type DevKey = "trade_count" | "pace" | "size" | "duration";
const DEV_LABELS: Record<DevKey, string> = { trade_count: "Frequency", pace: "Pace", size: "Sizing", duration: "Duration" };
const ORDER: DevKey[] = ["trade_count", "pace", "size", "duration"];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
function stateColor(s: string): string {
  return s === "LIVE" || s === "OK" ? C.ok
    : s === "CALIBRATING" || s === "REBUILDING" ? C.warn
    : s === "DEGRADED" || s === "INVALID" ? C.bad : C.stale;
}
const pts = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}`);
const dirColor = (v: number | null) => (v == null ? C.t3 : Math.abs(v) < 0.08 ? C.t1 : v > 0 ? C.warn : C.ok);
const dirText = (v: number | null) => (v == null ? "CALIBRATING" : Math.abs(v) < 0.08 ? "AT BASELINE" : v > 0 ? "ABOVE BASELINE" : "BELOW BASELINE");

const BLADE_D = {
  trade_count: "M453.236 407.657C406.964 467.478 334.481 505.998 253 505.998C172.221 505.998 100.284 468.141 53.9639 409.201C60.5202 413.487 68.2783 415.998 76.7441 415.998H428.238C437.675 415.998 446.238 412.877 453.236 407.657Z",
  pace: "M253.93 0C393.23 0.501111 506 113.58 506 252.998C506 300.54 492.886 345.019 470.079 383.016C472.654 374.113 472.761 364.229 469.657 354.454H469.707C445.772 278.789 392.68 145.164 289.453 21.0225C283.1 10.6422 273.004 3.63365 261.923 1.05176C261.381 0.946389 260.84 0.84072 260.298 0.735352C259.855 0.630003 259.362 0.525365 258.919 0.472656C258.229 0.367279 257.589 0.314355 256.899 0.208984C256.506 0.208984 256.112 0.103594 255.718 0.103516C255.138 0.103516 254.511 0.0516484 253.93 0Z",
  size: "M250.061 0.0146484C249.775 0.0286961 249.491 0.0546892 249.217 0.103516C248.823 0.103516 248.428 0.208984 248.034 0.208984C247.345 0.261672 246.705 0.367305 246.016 0.472656C245.572 0.525348 245.079 0.629968 244.636 0.735352C244.094 0.840712 243.552 0.946398 243.011 1.05176C231.93 3.63368 221.883 10.6423 215.48 21.0225C112.352 145.164 59.3097 278.789 35.3252 354.454C32.5765 363.155 32.3635 371.944 34.166 380.049C12.442 342.712 0 299.308 0 252.998C0 114.251 111.687 1.58996 250.061 0.0146484Z",
};
const BAR = { teal: "#3FA7C4", green: "#34B27B", amber: "#D8A23C" } as const;
const BARSPEC: Record<DevKey, [number, keyof typeof BAR][]> = {
  trade_count: [[.42, "teal"], [.55, "green"], [.40, "teal"], [.66, "green"], [.84, "amber"], [1, "amber"], [.72, "teal"]],
  pace: [[.58, "teal"], [.66, "green"], [.54, "teal"], [.72, "green"], [.50, "green"], [.56, "teal"], [.48, "green"]],
  size: [[.50, "green"], [.70, "teal"], [.48, "green"], [.80, "teal"], [.58, "green"], [.50, "teal"], [.60, "green"]],
  duration: [[.70, "amber"], [.50, "teal"], [.64, "green"], [.54, "teal"], [.60, "green"], [.50, "teal"], [.45, "green"]],
};

function useDashboard(account?: string) {
  const [resp, setResp] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const url = account ? `/api/dashboard?account=${encodeURIComponent(account)}` : "/api/dashboard";
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 401) { setError("Not signed in."); setLoading(false); return; }
      if (!r.ok) { setError(`Server error (${r.status}).`); setLoading(false); return; }
      setResp(await r.json()); setError(null);
    } catch { setError("Network error — feed may be stale."); }
    finally { setLoading(false); }
  }, [account]);
  useEffect(() => { void load(); const id = setInterval(() => void load(), POLL_MS); return () => clearInterval(id); }, [load]);
  return { resp, error, loading };
}

export function OverviewLive({ onNavigate, current = "overview", userName = "" }: OverviewLiveProps) {
  const [account, setAccount] = useState<string | undefined>(undefined);
  const { resp, error, loading } = useDashboard(account);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);

  if (loading && !resp) return <Centered>Loading your analytics…</Centered>;
  if (error && !resp) return <Centered tone={C.bad}>{error}</Centered>;
  if (!resp || !resp.snapshot) return <Centered tone={C.t2}>{resp?.message ?? "No analytics yet."}</Centered>;

  const snap = resp.snapshot;
  const safe = snap.behaviour;
  const data = safe.data;
  const ageS = Math.round(snap.system.staleness / 1000);
  const unavailable = !data;
  const calibrating = !!data && (snap.system.state === "CALIBRATING" || data.risk_score == null);

  const mode: AtomMode = unavailable
    ? (snap.system.state === "DISCONNECTED" ? "disconnected" : "calibrating")
    : calibrating ? "calibrating"
    : snap.system.state === "DISCONNECTED" ? "disconnected" : "live";
  const glassIntensity = {
    freq: data ? clamp01(Math.abs(data.deviations.trade_count ?? 0) / 1.4) : 0,
    pace: data ? clamp01(Math.abs(data.deviations.pace ?? 0) / 1.4) : 0,
    size: data ? clamp01(Math.abs(data.deviations.size ?? 0) / 1.4) : 0,
  };
  const band = unavailable ? "Offline"
    : calibrating ? "Calibrating"
    : ((r) => (r <= 25 ? "Aligned" : r <= 55 ? "Drifting" : "Off-baseline"))(data!.risk_score as number);

  // per-dimension deviations for Risk Desk + cards
  const dims = ORDER.map((k) => ({ k, v: data ? data.deviations[k] : null }));
  const present = dims.filter((d) => d.v != null) as { k: DevKey; v: number }[];
  const topK = present.length ? present.slice().sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0].k : null;

  // greeting
  const tod = now.getHours() < 12 ? "morning" : now.getHours() < 17 ? "afternoon" : "evening";
  const lead = `Good ${tod}${userName ? `, ${userName}` : ""}. `;
  let greeting: string;
  if (unavailable) greeting = lead + (snap.system.state === "DISCONNECTED" ? "Your feed is disconnected — the figures below are frozen until it reconnects." : "Live data is unavailable right now.");
  else if (calibrating) greeting = lead + "Axiem is still learning your A-Game baseline. Keep trading your plan — comparisons unlock as your history builds.";
  else if (!topK || Math.abs(present.find((p) => p.k === topK)!.v) < 0.12) greeting = lead + "You're tracking close to your A-Game baseline across every signal. Protect the routine that got you here.";
  else {
    const top = present.find((p) => p.k === topK)!;
    const others = present.filter((p) => p.k !== topK && Math.abs(p.v) >= 0.15).length;
    greeting = lead + `Your ${DEV_LABELS[topK].toLowerCase()} is running ${pts(top.v)} ${top.v > 0 ? "above" : "below"} your recent baseline.` + (others > 0 ? " A few other signals are drifting too — ease back toward your baseline." : " Everything else is holding steady.");
  }

  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).toUpperCase();
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).toUpperCase();
  const rebuiltAgo = data?.computed_at ? Math.max(0, Math.round((now.getTime() - new Date(data.computed_at).getTime()) / 1000)) : null;

  const navItems: { label: string; screen: Screen | null }[] = [
    { label: "Dashboard", screen: "overview" },
    { label: "Behaviour", screen: "behaviour" },
    { label: "Session", screen: "history" },
    { label: "Explore", screen: null },
  ];

  return (
    <div className="cc-root">
      <style>{CC_CSS}</style>

      {/* ── topbar ── */}
      <div className="cc-top">
        <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
          <LogoMark px={30} />
          <div style={{ display: "flex", alignItems: "center", gap: 22, fontFamily: "monospace" }}>
            <span style={{ fontSize: 11, letterSpacing: "0.20em", color: C.t2 }}>{date}</span>
            <span style={{ fontSize: 11, letterSpacing: "0.20em", color: C.t3 }}>{time}</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 24, fontFamily: "monospace" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 11, letterSpacing: "0.20em", color: stateColor(snap.system.state) }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor(snap.system.state), animation: mode === "live" ? "ccpulse 2.4s infinite" : undefined }} />
            {snap.system.state}
          </span>
          <span style={{ fontSize: 11, letterSpacing: "0.16em", color: C.t3 }}>UPDATED {ageS} SEC AGO</span>
          {rebuiltAgo != null && <span style={{ fontSize: 11, letterSpacing: "0.16em", color: C.t3 }}>REBUILT {rebuiltAgo} SEC AGO</span>}
        </div>
      </div>

      {/* ── left nav ── */}
      <div className="cc-nav">
        {navItems.map((it) => (
          <NavItem key={it.label} label={it.label} active={it.screen === current}
            onClick={it.screen ? () => onNavigate?.(it.screen as Screen) : undefined} />
        ))}
      </div>

      {/* ── hero: refractive glass mark ── */}
      <div className="cc-hero">
        <div className="cc-hero-inner">
          <AxiemGlass intensity={glassIntensity} label={band} mode={mode} fill />
        </div>
      </div>

      {/* ── right info column ── */}
      <div className="cc-panel">
        {safe.safety !== "OK" && (
          <div style={{ fontSize: 12, lineHeight: 1.5, color: C.t1, background: "rgba(216,162,60,0.10)", border: "1px solid rgba(216,162,60,0.3)", borderRadius: 8, padding: "10px 12px", marginBottom: 16 }}>
            {safe.reason ?? data?.message ?? "System state is not fully reliable."}
          </div>
        )}
        <div className="eyebrow">Today&apos;s Overview</div>
        <div style={{ fontSize: 16.5, lineHeight: 1.52, color: C.t1, marginTop: 13, letterSpacing: "-0.005em", fontWeight: 300 }}>{greeting}</div>

        <div style={{ marginTop: 24 }}>
          <div className="eyebrow">Risk Desk</div>
          <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 2 }}>
            {dims.map((d) => <RiskRow key={d.k} k={d.k} value={d.v} highlighted={d.k === topK && d.v != null && Math.abs(d.v) >= 0.12} />)}
          </div>
        </div>

        {resp.accounts.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="eyebrow">Account Select</div>
            <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 2 }}>
              {resp.accounts.map((a) => <AccountRow key={a} label={a} selected={a === resp.account} onClick={() => setAccount(a)} />)}
            </div>
          </div>
        )}
      </div>

      {/* ── bottom signal cards ── */}
      <div className="cc-cards">
        {dims.map((d) => <BottomCard key={d.k} k={d.k} value={d.v} />)}
      </div>

      {/* ── footer ── */}
      <button className="cc-foot" onClick={() => onNavigate?.("settings")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "monospace", color: C.t3 }}>
        <span style={{ fontSize: 15, lineHeight: 1, opacity: 0.7 }}>⚙</span>
        <span style={{ fontSize: 10, letterSpacing: "0.16em" }}>{(userName || "Your").toUpperCase()}&apos;S ACCOUNT</span>
      </button>
    </div>
  );
}

// ── presentational helpers ───────────────────────────────────────────────────
function LogoMark({ px }: { px: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 506 506" fill="none" style={{ display: "block" }}>
      {ORDER.filter((k) => k !== "duration").map((k) => <path key={k} d={BLADE_D[k as "trade_count" | "pace" | "size"]} fill="#E7E9EC" />)}
    </svg>
  );
}
function NavItem({ label, active, onClick }: { label: string; active: boolean; onClick?: () => void }) {
  return (
    <div className={`nav-item${active ? " active" : ""}`} onClick={onClick} style={{ color: active ? C.t1 : C.t2, cursor: onClick ? "pointer" : "default" }}>
      {label}<span className="nav-arrow">→</span>
    </div>
  );
}
function RiskRow({ k, value, highlighted }: { k: DevKey; value: number | null; highlighted: boolean }) {
  const col = dirColor(value);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", borderRadius: 7, ...(highlighted ? { background: `${col}14`, border: `1px solid ${col}33` } : { border: "1px solid transparent" }) }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: highlighted ? col : "transparent", border: `1px solid ${highlighted ? col : "#3A3F46"}`, flexShrink: 0 }} />
      <span style={{ fontFamily: "monospace", fontSize: 11, letterSpacing: "0.12em", color: highlighted ? C.t1 : C.t2, textTransform: "uppercase" }}>{DEV_LABELS[k]}</span>
      <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 11, letterSpacing: "0.06em", color: highlighted ? col : C.t3 }}>{pts(value)}&nbsp;&nbsp;{dirText(value)}</span>
    </div>
  );
}
function AccountRow({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", borderRadius: 7, cursor: "pointer", ...(selected ? { background: "rgba(255,255,255,0.045)", border: `1px solid ${C.border}` } : { border: "1px solid transparent" }) }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: selected ? C.ok : "transparent", border: `1px solid ${selected ? C.ok : "#3A3F46"}`, flexShrink: 0 }} />
      <span style={{ fontFamily: "monospace", fontSize: 11, letterSpacing: "0.08em", color: selected ? C.t1 : C.t2 }}>{label}</span>
      {selected && <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 9, letterSpacing: "0.14em", color: C.t3 }}>SELECTED</span>}
    </div>
  );
}
function BottomCard({ k, value }: { k: DevKey; value: number | null }) {
  const col = dirColor(value);
  return (
    <div style={{ width: 174, padding: "16px 16px 15px", background: "rgba(255,255,255,0.018)", border: `1px solid rgba(255,255,255,0.06)`, borderRadius: 11 }}>
      <div className="eyebrow">{DEV_LABELS[k]}</div>
      <div style={{ fontFamily: "monospace", fontSize: 28, fontWeight: 500, color: col, marginTop: 11, letterSpacing: "-0.01em" }}>{pts(value)}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 40, marginTop: 14 }}>
        {BARSPEC[k].map(([h, c], i) => <div key={i} style={{ flex: 1, height: `${Math.round(h * 100)}%`, background: BAR[c], borderRadius: 1, opacity: 0.9 }} />)}
      </div>
      <div style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "0.14em", color: col, opacity: 0.85, marginTop: 13 }}>{dirText(value)}</div>
    </div>
  );
}
function Centered({ children, tone = "#9AA0A8" }: { children: React.ReactNode; tone?: string }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: tone, fontSize: 13, fontFamily: "Inter, system-ui, sans-serif", background: "#0A0B0D" }}>{children}</div>;
}

const CC_CSS = `
.cc-root{position:relative;width:100%;min-height:100vh;background:#0A0B0D;color:#E7E9EC;font-family:Inter,system-ui,sans-serif}
.eyebrow{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#5A6068;font-weight:500}
.nav-item{font-size:19px;font-weight:400;letter-spacing:-0.01em;line-height:1;display:flex;align-items:center;justify-content:space-between;gap:14px;width:148px;padding:9px 0;transition:color .15s,transform .15s}
.nav-item:hover{transform:translateX(3px)}
.nav-arrow{font-family:monospace;font-size:13px;opacity:0;transition:opacity .15s}
.nav-item:hover .nav-arrow,.nav-item.active .nav-arrow{opacity:1}
@keyframes ccpulse{0%,100%{opacity:1}50%{opacity:.35}}
.cc-top{position:absolute;top:0;left:0;right:0;height:92px;display:flex;align-items:center;justify-content:space-between;padding:0 48px;z-index:30}
.cc-nav{position:absolute;left:56px;top:50%;transform:translateY(-50%);z-index:30;display:flex;flex-direction:column;gap:6px}
.cc-hero{position:absolute;left:172px;right:436px;top:64px;bottom:236px;display:flex;align-items:center;justify-content:center;z-index:1}
.cc-hero-inner{position:relative;width:min(100%,560px);aspect-ratio:1}
.cc-panel{position:absolute;right:40px;top:50%;transform:translateY(-50%);width:372px;z-index:30;background:rgba(255,255,255,0.013);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:26px 24px;backdrop-filter:blur(6px)}
.cc-cards{position:absolute;bottom:34px;left:50%;transform:translateX(-50%);z-index:25;display:flex;gap:14px}
.cc-foot{position:absolute;left:50px;bottom:30px;z-index:30;display:flex;align-items:center;gap:11px}
@media (max-width:1180px){
  .cc-root{display:flex;flex-direction:column;min-height:0;padding-bottom:74px}
  .cc-top{position:static;height:auto;flex-wrap:wrap;gap:10px 22px;padding:18px 22px}
  .cc-nav{position:static;transform:none;flex-direction:row;flex-wrap:wrap;gap:6px 20px;padding:2px 22px 6px}
  .cc-nav .nav-item{width:auto}
  .cc-hero{position:static;left:auto;right:auto;top:auto;bottom:auto;padding:10px 22px}
  .cc-hero-inner{width:min(82vw,340px)}
  .cc-panel{position:static;transform:none;width:auto;margin:6px 22px}
  .cc-cards{position:static;transform:none;flex-wrap:wrap;justify-content:center;padding:14px 18px 0}
  .cc-foot{position:static;transform:none;padding:12px 24px 0}
}`;
