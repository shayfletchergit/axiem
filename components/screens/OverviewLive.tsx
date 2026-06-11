"use client";

/**
 * components/screens/OverviewLive.tsx
 *
 * Phase B integration — the production Overview, fed ONLY by the server
 * intelligence pipeline via GET /api/dashboard. No localStorage, no client-side
 * engine. The Axiem mark renders as a dithered particle atom (AxiemAtom) whose
 * three blades disperse with the live deviation signals; the surrounding HUD
 * shows trust state, A-Game alignment, and the Risk Desk — honouring every
 * system state (CALIBRATING / STALE / DISCONNECTED / DEGRADED / INVALID /
 * UNKNOWN) without inventing scores.
 */

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type { DashboardSnapshot } from "@/lib/runtime/dashboardContract";
import { type AtomMode } from "@/components/hud/AxiemAtom";

// Real-time WebGL glass mark — client-only, lazy-loaded so three.js stays out of the initial bundle.
const AxiemGlass = dynamic(() => import("@/components/hud/AxiemGlass").then((m) => m.AxiemGlass), {
  ssr: false,
  loading: () => <div style={{ width: "min(360px, 86vw)", aspectRatio: "1" }} />,
});

interface DashboardResponse {
  account:  string | null;
  accounts: string[];
  snapshot: DashboardSnapshot | null;
  message?: string;
}

const POLL_MS = 5000;

// ── palette: neutral surfaces + semantic state only ──────────────────────────
const C = {
  ok: "#34B27B", warn: "#D8A23C", bad: "#D2685A", stale: "#6E747C",
  t1: "#E7E9EC", t2: "#9AA0A8", t3: "#62686F",
  surface: "#131519", border: "rgba(255,255,255,0.08)", bg: "rgba(11,12,14,0.85)",
};

type DevKey = "trade_count" | "pace" | "size" | "duration";
const DEV_LABELS: Record<DevKey, string> = { trade_count: "Frequency", pace: "Pace", size: "Sizing", duration: "Duration" };
type DevLevel = "within" | "elevated" | "critical" | "insufficient";

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
function stateColor(s: string): string {
  return s === "LIVE" || s === "OK" ? C.ok
    : s === "CALIBRATING" || s === "REBUILDING" ? C.warn
    : s === "DEGRADED" || s === "INVALID" ? C.bad
    : C.stale;
}
function safetyColor(s: string): string {
  return s === "OK" ? C.ok : s === "DEGRADED" ? C.warn : C.bad;
}
function pct(v: number | null): string {
  if (v == null) return "—";
  const s = Math.round(v * 100);
  return `${s >= 0 ? "+" : ""}${s}%`;
}
function devLevel(value: number | null, quality: string): DevLevel {
  if (quality === "INSUFFICIENT_DATA" || value == null) return "insufficient";
  const m = Math.abs(value);
  return m >= 0.30 ? "critical" : m >= 0.15 ? "elevated" : "within";
}
const intensityOf = (d: number | null) => (d == null ? 0 : clamp01(Math.abs(d) / 0.5));

function useDashboard() {
  const [resp, setResp] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      if (r.status === 401) { setError("Not signed in."); setLoading(false); return; }
      if (!r.ok) { setError(`Server error (${r.status}).`); setLoading(false); return; }
      setResp(await r.json());
      setError(null);
    } catch {
      setError("Network error — feed may be stale.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return { resp, error, loading };
}

export function OverviewLive() {
  const { resp, error, loading } = useDashboard();
  const [showAll, setShowAll] = useState(false);

  if (loading && !resp) return <Centered>Loading your analytics…</Centered>;
  if (error && !resp) return <Centered tone={C.bad}>{error}</Centered>;
  if (!resp) return <Centered>No data.</Centered>;
  if (!resp.snapshot) return <Centered tone={C.t2}>{resp.message ?? "No analytics yet."}</Centered>;

  const snap = resp.snapshot;
  const safe = snap.behaviour;
  const data = safe.data; // null when INVALID / UNKNOWN
  const ageS = Math.round(snap.system.staleness / 1000);
  const unavailable = !data;
  const calibrating = !!data && (snap.system.state === "CALIBRATING" || data.risk_score == null);

  const classified = (["trade_count", "pace", "size", "duration"] as DevKey[]).map((k) => ({
    k,
    value: data ? data.deviations[k] : null,
    level: data ? devLevel(data.deviations[k], data.signal_quality_map[k]) : ("insufficient" as DevLevel),
  }));
  const byk = (k: DevKey) => classified.find((c) => c.k === k)!;
  const flagged = classified.filter((c) => c.level === "elevated" || c.level === "critical");
  const within = classified.filter((c) => c.level === "within").length;
  const insufficient = classified.filter((c) => c.level === "insufficient").length;

  // ── Atom drive (3 blades ← Frequency / Pace / Sizing) + center label ──
  const mode: AtomMode = unavailable
    ? (snap.system.state === "DISCONNECTED" ? "disconnected" : "calibrating")
    : calibrating ? "calibrating"
    : snap.system.state === "DISCONNECTED" ? "disconnected" : "live";
  // gentle mapping keeps the mark legible (frays/dislocates rather than exploding)
  const glassIntensity = {
    freq: data ? clamp01(Math.abs(data.deviations.trade_count ?? 0) / 1.4) : 0,
    pace: data ? clamp01(Math.abs(data.deviations.pace ?? 0) / 1.4) : 0,
    size: data ? clamp01(Math.abs(data.deviations.size ?? 0) / 1.4) : 0,
  };
  let centerLabel: string, centerSub: string | null, centerCol: string;
  if (unavailable) { centerLabel = "Offline"; centerSub = null; centerCol = C.stale; }
  else if (calibrating) { centerLabel = "Calibrating"; centerSub = null; centerCol = C.warn; }
  else { const r = data!.risk_score as number; centerLabel = r <= 25 ? "Aligned" : r <= 55 ? "Drifting" : "Off-baseline"; centerSub = `dev ${r}`; centerCol = r <= 25 ? C.ok : r <= 55 ? C.warn : C.bad; }
  const glassLabel = centerLabel; // sentence-case state word shown behind the glass

  return (
    <div style={{ color: C.t1, fontFamily: "Inter, Instrument Sans, system-ui, sans-serif" }}>
      {/* ── TrustStrip — sticky, always visible ── */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", background: C.bg, backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
        <Chip label={snap.system.state} color={stateColor(snap.system.state)} />
        <Chip label={`Data ${safe.safety}`} color={safetyColor(safe.safety)} />
        <ConfMini v={snap.confidence.baseline} />
        <span style={{ fontSize: 12, color: C.t3, fontFamily: "monospace" }}>updated {ageS}s ago</span>
        {resp.account && <span style={{ fontSize: 12, color: C.t3, marginLeft: "auto", fontFamily: "monospace" }}>acct {resp.account}</span>}
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "20px 24px 96px" }}>
        {/* ── Non-OK states: explain, never fake a score ── */}
        {safe.safety !== "OK" && (
          <div style={{ padding: "14px 16px", border: `1px solid ${safetyColor(safe.safety)}55`, background: `${safetyColor(safe.safety)}11`, borderRadius: 8, marginBottom: 20, fontSize: 13, lineHeight: 1.6, color: C.t1 }}>
            {safe.reason ?? data?.message ?? "System state is not fully reliable."}
          </div>
        )}

        {/* ── HUD HERO: refractive glass mark + readouts ── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", margin: "4px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: 420, marginBottom: -10, zIndex: 2 }}>
            <HudStat label="Sizing" value={byk("size").value} level={byk("size").level} align="left" />
            <HudStat label="Frequency" value={byk("trade_count").value} level={byk("trade_count").level} align="right" />
          </div>

          <AxiemGlass intensity={glassIntensity} label={glassLabel} mode={mode} />

          <div style={{ display: "flex", justifyContent: "center", width: "100%", maxWidth: 420, marginTop: -10, zIndex: 2 }}>
            <HudStat label="Pace" value={byk("pace").value} level={byk("pace").level} align="center" />
          </div>
        </div>

        {/* ── Risk Desk: flagged signals; else within; else calibrating ── */}
        {data && (
          <div style={{ marginTop: 28 }}>
            <Eyebrow>Risk Desk</Eyebrow>
            {flagged.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                {flagged.map((c) => <DeviationTag key={c.k} k={c.k} value={c.value} level={c.level} />)}
              </div>
            ) : within > 0 ? (
              <div style={{ marginTop: 10, fontSize: 13, color: C.t2 }}>All signals within your A-Game baseline.</div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 13, color: C.t2 }}>Gathering data — signals calibrating.</div>
            )}
            {(within > 0 || insufficient > 0) && (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {within > 0 && <MutedPill>{within} within baseline</MutedPill>}
                {insufficient > 0 && <MutedPill>{insufficient} calibrating</MutedPill>}
              </div>
            )}
          </div>
        )}

        {/* ── Interpretation (factual) ── */}
        {data?.interpretation?.length ? (
          <ul style={{ listStyle: "none", padding: 0, margin: "24px 0 0", display: "flex", flexDirection: "column", gap: 8 }}>
            {data.interpretation.map((line, i) => (
              <li key={i} style={{ fontSize: 13, color: C.t1, lineHeight: 1.6 }}>{line}</li>
            ))}
          </ul>
        ) : null}

        {/* ── Expandable: all signals + baseline reference (collapsed) ── */}
        {data && (
          <div style={{ marginTop: 28, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
            <button onClick={() => setShowAll((s) => !s)} style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", color: C.t2, fontFamily: "monospace", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", padding: 0 }}>
              <span style={{ display: "inline-block", transform: showAll ? "rotate(90deg)" : "none", transition: "transform 160ms" }}>›</span>
              All signals
            </button>
            {showAll && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 1, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", margin: "14px 0 0" }}>
                  {classified.map((c) => <Dev key={c.k} label={DEV_LABELS[c.k]} value={c.value} level={c.level} />)}
                </div>
                {data.baseline_reference && (
                  <div style={{ fontSize: 11.5, color: C.t2, marginTop: 14, lineHeight: 1.7 }}>
                    <span style={{ color: C.t3, fontFamily: "monospace", letterSpacing: "0.1em" }}>A-GAME · </span>
                    {data.baseline_reference.median_trade_count != null && `${data.baseline_reference.median_trade_count} trades`}
                    {data.baseline_reference.median_inter_trade_gap_seconds != null && ` · ${Math.round(data.baseline_reference.median_inter_trade_gap_seconds / 60)}m pace`}
                    {data.baseline_reference.median_position_size != null && ` · ${data.baseline_reference.median_position_size} contracts`}
                    {data.baseline_reference.median_session_duration_minutes != null && ` · ${Math.round(data.baseline_reference.median_session_duration_minutes)}m sessions`}
                  </div>
                )}
                <div style={{ display: "flex", gap: 20, marginTop: 18 }}>
                  <Conf label="Baseline" v={snap.confidence.baseline} />
                  <Conf label="Trust" v={snap.confidence.trust} />
                  <Conf label="Data quality" v={snap.confidence.dataQuality} />
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Disclaimer ── */}
        <div style={{ fontSize: 10.5, color: C.t3, borderTop: `1px solid ${C.border}`, paddingTop: 14, marginTop: 28, lineHeight: 1.6 }}>
          Axiem provides behavioural analytics, not trading advice. It does not place, restrict, or
          manage trades and does not prevent losses. Figures are derived from your reconstructed fill
          history and may be stale or incomplete; always confirm against your broker.
        </div>
      </div>
    </div>
  );
}

// ── presentational helpers ────────────────────────────────────────────────────
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: C.t3, fontFamily: "monospace", fontWeight: 600 }}>{children}</div>;
}
function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: "monospace", color, background: `${color}14`, border: `1px solid ${color}55`, borderRadius: 99, padding: "4px 10px" }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}
function MutedPill({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontFamily: "monospace", color: C.t2, border: `1px solid ${C.border}`, borderRadius: 99, padding: "3px 10px" }}>{children}</span>;
}
function ConfMini({ v }: { v: number }) {
  const col = v >= 0.66 ? C.ok : v >= 0.33 ? C.warn : C.stale;
  return (
    <span title="Baseline confidence" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 4, height: 10, borderRadius: 1, background: v >= (i + 1) / 3 ? col : C.border }} />
      ))}
    </span>
  );
}
function HudStat({ label, value, level, align }: { label: string; value: number | null; level: DevLevel; align: "left" | "right" | "center" }) {
  const col = level === "critical" ? C.bad : level === "elevated" ? C.warn : level === "insufficient" ? C.t3 : C.t1;
  return (
    <div style={{ textAlign: align }}>
      <div style={{ fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: C.t3, fontFamily: "monospace" }}>{label}</div>
      <div style={{ fontSize: 18, fontFamily: "monospace", color: col, marginTop: 2 }}>{level === "insufficient" ? "—" : pct(value)}</div>
    </div>
  );
}
function DeviationTag({ k, value, level }: { k: DevKey; value: number | null; level: DevLevel }) {
  const col = level === "critical" ? C.bad : C.warn;
  const dir = value != null && value < 0 ? "below" : "above";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `1px solid ${col}44`, background: `${col}0d`, borderRadius: 8 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: col, flexShrink: 0 }} />
      <span style={{ fontSize: 13, fontWeight: 500, color: C.t1 }}>{DEV_LABELS[k]}</span>
      <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 14, color: col }}>{pct(value)}</span>
      <span style={{ fontSize: 10, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.08em", color: C.t3 }}>{dir} baseline</span>
    </div>
  );
}
function Dev({ label, value, level }: { label: string; value: number | null; level: DevLevel }) {
  const insufficient = level === "insufficient";
  const col = level === "critical" ? C.bad : level === "elevated" ? C.warn : insufficient ? C.t3 : C.t1;
  return (
    <div style={{ padding: "14px 16px", background: C.surface }}>
      <div style={{ fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: C.t3, fontFamily: "monospace", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 400, fontFamily: "monospace", color: col }}>{insufficient ? "—" : pct(value)}</div>
      <div style={{ fontSize: 9, color: C.t3, marginTop: 2, fontFamily: "monospace" }}>{insufficient ? "not enough data" : `${level} vs baseline`}</div>
    </div>
  );
}
function Conf({ label, v }: { label: string; v: number }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: C.t3, fontFamily: "monospace", marginBottom: 5 }}>{label}</div>
      <div style={{ height: 2, background: "rgba(255,255,255,0.08)", borderRadius: 99 }}>
        <div style={{ height: "100%", width: `${Math.round(v * 100)}%`, background: v >= 0.66 ? C.ok : v >= 0.33 ? C.warn : C.bad, borderRadius: 99 }} />
      </div>
    </div>
  );
}
function Centered({ children, tone = "#9AA0A8" }: { children: React.ReactNode; tone?: string }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh", color: tone, fontSize: 13, fontFamily: "Inter, Instrument Sans, system-ui, sans-serif" }}>{children}</div>;
}
