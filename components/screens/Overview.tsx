"use client";

import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { HUDGraph } from "@/components/hud/HUDGraph";
import { SignalMeters } from "@/components/hud/SignalMeters";
import { SectionGlow } from "@/components/primitives/SectionGlow";
import { useStore } from "@/lib/store/session";
import { useSignals } from "@/hooks/useSignals";
import { calcEFD, calcPLB, calcSCI, calcBSS } from "@/lib/engine";
import type { Trade } from "@/lib/types";

function SectionLabel({ children, action }: { children: string; action?: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
      <span className="t-label" style={{ color: "rgb(var(--t3))" }}>{children}</span>
      {action && (
        <button onClick={action} style={{ width: 32, height: 32, margin: "-8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "rgb(var(--t4))", background: "transparent", border: "none", cursor: "pointer", borderRadius: 2, transition: "color 180ms ease" }}
          onMouseOver={(e) => { e.currentTarget.style.color = "rgb(200,168,75)"; }}
          onMouseOut={(e) => { e.currentTarget.style.color = "rgb(var(--t4))"; }}>
          ↗
        </button>
      )}
    </div>
  );
}

function PeriodCol({ label, sessions }: { label: string; sessions: any[] }) {
  // Choose a subtle glow colour for each period
  const glowColors: Record<string, string> = {
    "Yesterday":  "rgba(200,168,75,1)",
    "This week":  "rgba(44,196,164,1)",
    "This month": "rgba(123,127,212,1)",
  };
  const glowPositions: Record<string, any> = {
    "Yesterday":  "top-left",
    "This week":  "top-right",
    "This month": "bottom-left",
  };

  if (!sessions.length) {
    return (
      <div style={{ position: "relative", overflow: "hidden" }}>
        <SectionGlow color={glowColors[label]} intensity={0.14} position={glowPositions[label]} size="60%" />
        <SectionLabel>{label}</SectionLabel>
        <p className="t-editorial" style={{ color: "rgb(var(--t1))" }}>No sessions {label.toLowerCase()}.</p>
      </div>
    );
  }

  const trades = sessions.flatMap((s: any) => s.trades || []);
  const totR    = trades.reduce((s: number, t: any) => s + t.r, 0);
  const wins    = trades.filter((t: any) => t.r > 0).length;
  const wr      = trades.length ? Math.round(wins / trades.length * 100) : 0;
  const breaches = trades.filter((t: any) => t.rules?.some((r: any) => r.broken)).length;
  const compliance = trades.length ? Math.round((trades.length - breaches) / trades.length * 100) : 100;
  const bl = { interval: 1800000, size: 2, efdSamples: [], sciSamples: [] };
  const avgBSS = sessions.length ? Math.round(sessions.reduce((s: number, sess: any) => {
    const b = calcBSS(calcEFD(sess.trades || [], bl), calcPLB(sess.trades || []), calcSCI(sess.trades || [], bl));
    return s + (b.score ?? 50);
  }, 0) / sessions.length) : 0;

  const summary = totR > 1 && compliance >= 80
    ? `Disciplined ${label.toLowerCase()}. ${wr}% win rate across ${trades.length} trades with clean execution.`
    : breaches > 1
    ? `Rule breaches cost R ${label.toLowerCase()}. Compliant trades performed better.`
    : `${sessions.length} session${sessions.length > 1 ? "s" : ""} ${label.toLowerCase()}. ${trades.length} trades, ${wr}% win rate, ${totR >= 0 ? "+" : ""}${totR.toFixed(1)}R.`;

  const metrics = [
    { l: "Trades taken",    v: String(trades.length),                           color: "" },
    { l: "Net R",           v: `${totR >= 0 ? "+" : ""}${totR.toFixed(1)}R`,   color: totR > 0 ? "#2CC4A4" : totR < 0 ? "#E8724A" : "" },
    { l: "Win rate",        v: `${wr}%`,                                        color: "" },
    { l: "Rule compliance", v: `${compliance}%`,                                color: compliance >= 80 ? "#2CC4A4" : "" },
    { l: "Avg form score",  v: String(avgBSS),                                  color: avgBSS >= 70 ? "rgb(200,168,75)" : "" },
  ];

  return (
    <div style={{ position: "relative", overflow: "hidden" }}>
      {/* Soft gradient bloom behind section */}
      <SectionGlow color={glowColors[label]} intensity={0.18} position={glowPositions[label]} size="65%" />

      <SectionLabel>{label}</SectionLabel>
      <p className="t-editorial" style={{ position: "relative", zIndex: 1, color: "rgb(var(--t1))", marginBottom: 28, lineHeight: 1.72, letterSpacing: "-0.005em" }}>
        {summary}
      </p>
      <div style={{ position: "relative", zIndex: 1, borderTop: "1px solid var(--b1)" }}>
        {metrics.map((m) => (
          <div key={m.l} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid var(--b1)" }}>
            <span className="t-label" style={{ color: "rgb(var(--t3))", paddingRight: 16 }}>{m.l}</span>
            <span className="t-meta t-tab" style={{ fontWeight: 500, color: m.color || "rgb(var(--t1))" }}>{m.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function genSummary(signals: ReturnType<typeof useSignals>): string {
  const { bss, efd, trades } = signals;
  if (!trades.length) return "Log your first trade to activate live behavioural intelligence.";
  const totR = trades.reduce((s, t) => s + t.r, 0);
  const breaches = trades.filter(t => t.rules?.some(r => r.broken)).length;
  const score = bss.score;
  let streak = 0;
  for (let i = trades.length - 1; i >= 0; i--) { if (trades[i].r < -0.1) streak++; else break; }
  if (streak >= 2) return `${streak} consecutive losses. Your data shows that continuing past this point increases average drawdown by over 30%. This isn't a suggestion — it's your own history speaking.`;
  if (score !== null && score < 45 && trades.length >= 2) return `Form score at ${score}. Multiple signals are outside your baseline simultaneously. Treat every entry decision with extra scrutiny.`;
  if (breaches >= 2) return `${breaches} rule breaches this session. Each breach makes the next one more likely. Your process is slipping.`;
  if (score !== null && score >= 70 && breaches === 0 && trades.length >= 3) return `Form score at ${score}. Clean session — no rule breaches, all signals within baseline. Execute with confidence.`;
  return `${trades.length} trade${trades.length > 1 ? "s" : ""} logged. Net ${totR >= 0 ? "+" : ""}${totR.toFixed(1)}R. ${efd.state === "ok" ? "Entry rhythm is stable." : "Watch your entry pace."}`;
}

/* State-dependent glow colour for the HUD panel */
function hudGlowColor(state: string): string {
  return state === "ok" ? "rgba(44,196,164,1)"
    : state === "warning" ? "rgba(212,168,75,1)"
    : state === "critical" ? "rgba(232,114,74,1)"
    : "rgba(200,168,75,1)";
}

export function Overview() {
  const signals  = useSignals();
  const sessions = useStore((s) => s.sessions);
  const [hoveredTrade, setHoveredTrade] = useState<Trade | null>(null);
  const [hoveredScore, setHoveredScore] = useState(0);
  const handleHover = useCallback((t: Trade | null, score: number) => { setHoveredTrade(t); setHoveredScore(score); }, []);

  const now     = new Date();
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yest    = new Date(today); yest.setDate(yest.getDate() - 1);
  const wkStart = new Date(today); wkStart.setDate(wkStart.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1));
  const moStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const sestsYest  = sessions.filter(s => s.startMs >= yest.getTime()  && s.startMs < today.getTime());
  const sestsWeek  = sessions.filter(s => s.startMs >= wkStart.getTime());
  const sestsMonth = sessions.filter(s => s.startMs >= moStart.getTime());
  const summary    = genSummary(signals);

  return (
    <div style={{ overflowY: "auto", height: "100%", scrollbarWidth: "none" }}>
      <div style={{ padding: "40px 56px 120px" }}>

        {/* ── Today ── */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: "easeOut" }}>
          <SectionLabel>Today</SectionLabel>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", minHeight: 380, marginBottom: 96, gap: 0 }}>

            {/* Left: summary + signal rows */}
            <div style={{ paddingRight: 56, position: "relative" }}>
              {/* Pulsing bloom — only rendered in warning/critical state */}
              {(signals.bss.state === "warning" || signals.bss.state === "critical") && (
                <SectionGlow
                  color={signals.bss.state === "critical" ? "rgba(232,114,74,1)" : "rgba(200,168,75,1)"}
                  intensity={0.20}
                  position="top-left"
                  size="75%"
                  blur={64}
                  animation={
                    signals.bss.state === "critical" ? "sectionGlowPulseCrit 2.8s ease-in-out infinite" :
                    "sectionGlowPulseWarn 3.5s ease-in-out infinite"
                  }
                />
              )}

              <motion.p
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: 0.06, ease: "easeOut" }}
                style={{
                  position: "relative", zIndex: 1,
                  fontSize: "clamp(15px, 1.5vw, 20px)",
                  lineHeight: 1.65,
                  letterSpacing: "-0.005em",
                  fontWeight: 400,
                  color: "rgb(var(--t1))",
                  marginBottom: 40,
                }}
              >
                {summary}
              </motion.p>

              <div style={{ position: "relative", zIndex: 1, borderTop: "1px solid var(--b1)" }}>
                {[
                  {
                    label: "Entry Pace",
                    text: signals.efd.state === "insufficient" || !signals.trades.length ? `Baseline: ${Math.round(1800000 / 60000)}m between entries.`
                      : signals.efd.state === "ok" ? `${signals.efd.rawMins}m avg gap — within baseline. Rhythm is intact.`
                      : signals.efd.state === "warning" ? `Pace compressed to ${signals.efd.rawMins}m — below baseline. Watch for reactive entries.`
                      : `Entry pace at ${signals.efd.rawMins}m — significantly compressed. High reactivity risk.`,
                    state: signals.efd.state,
                  },
                  {
                    label: "After a Loss",
                    text: signals.plb.state === "insufficient" ? "No losses recorded yet."
                      : signals.plb.state === "ok" ? "Calm recovery pattern — entries are spaced after losses."
                      : signals.plb.state === "warning" ? "Slight compression after losses. Monitor for revenge trading."
                      : "Re-entering too quickly after losses. High emotional reactivity.",
                    state: signals.plb.state,
                  },
                  {
                    label: "Size Control",
                    text: signals.sci.state === "insufficient" || !signals.trades.length ? `Baseline: 2 contracts.`
                      : signals.sci.state === "ok" ? `Sizing consistent at ${signals.sci.label}.`
                      : `Sizing deviating from baseline. Current: ${signals.sci.label}.`,
                    state: signals.sci.state,
                  },
                ].map((row, i) => {
                  const isWarn = row.state === "warning";
                  const isCrit = row.state === "critical";
                  const isAlert = isWarn || isCrit;
                  return (
                    <motion.div key={row.label}
                      initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.21, delay: 0.10 + i * 0.04, ease: "easeOut" }}
                      style={{
                        padding: "14px 0",
                        paddingLeft: isAlert ? 10 : 0,
                        borderBottom: "1px solid var(--b1)",
                        animation: isAlert
                          ? `${isCrit ? "alertRowCrit 2.6s" : "alertRowWarn 3.4s"} ease-in-out infinite`
                          : undefined,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                        <span className="t-label" style={{ color: "rgb(var(--t3))" }}>{row.label}</span>
                        {isAlert && (
                          <span className="t-label" style={{
                            padding: "2px 7px", borderRadius: 1,
                            background: isCrit ? "rgba(232,114,74,0.07)" : "rgba(200,168,75,0.07)",
                            color: isCrit ? "rgb(232,114,74)" : "rgb(200,168,75)",
                            border: `1px solid ${isCrit ? "rgba(232,114,74,0.22)" : "rgba(200,168,75,0.22)"}`,
                          }}>
                            {isCrit ? "Critical" : "Watch"}
                          </span>
                        )}
                      </div>
                      <p className="t-meta" style={{ color: "rgb(var(--t2))", lineHeight: 1.65 }}>{row.text}</p>
                    </motion.div>
                  );
                })}
              </div>
            </div>

            {/* Right: HUD panel with state-responsive gradient */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.24, delay: 0.08, ease: "easeOut" }}
              style={{ position: "relative", minHeight: 320 }}>
              {/* Pulsing bloom — only rendered in warning/critical state */}
              {(signals.bss.state === "warning" || signals.bss.state === "critical") && (
                <SectionGlow
                  color={hudGlowColor(signals.bss.state)}
                  intensity={0.22}
                  position="top-right"
                  size="80%"
                  blur={72}
                  animation={
                    signals.bss.state === "critical" ? "sectionGlowPulseCrit 2.8s ease-in-out infinite" :
                    "sectionGlowPulseWarn 3.5s ease-in-out infinite"
                  }
                />
              )}

              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", zIndex: 1 }}>
                <div style={{ padding: "24px 24px 0", flexShrink: 0 }}><SignalMeters /></div>
                <div style={{ flex: 1, minHeight: 0, position: "relative", padding: "16px 16px 0" }}>
                  <div className="t-label" style={{ color: "rgb(var(--t3))", marginBottom: 8 }}>Session trend</div>
                  <div style={{ position: "relative", height: "calc(100% - 24px)" }}>
                    <HUDGraph onHoverTrade={handleHover} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "10px 16px 16px", flexShrink: 0 }}>
                  {[["#E8724A","Entry Pace"],["#2CC4A4","After a Loss"],["#7B7FD4","Size Control"]].map(([col, lbl]) => (
                    <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: col, flexShrink: 0 }} />
                      <span className="t-label" style={{ color: "rgb(var(--t3))" }}>{lbl}</span>
                    </div>
                  ))}
                </div>
              </div>

              {hoveredTrade && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  style={{ position: "absolute", top: 12, right: 12, zIndex: 10, background: "rgba(29,27,25,0.97)", border: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(12px)", boxShadow: "0 4px 20px rgba(0,0,0,0.5)", borderRadius: 3, padding: "12px 16px", minWidth: 160 }}>
                  <div className="t-label" style={{ color: "rgb(var(--t3))", marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    Trade · Form {hoveredScore}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div className="t-meta" style={{ color: "rgb(var(--t2))" }}>
                      <span style={{ color: "rgb(var(--t1))", fontWeight: 500 }}>{hoveredTrade.r >= 0 ? "+" : ""}{hoveredTrade.r.toFixed(1)}R</span>{" · "}{hoveredTrade.setup}
                    </div>
                    <div className="t-meta" style={{ color: "rgb(var(--t2))" }}>{hoveredTrade.emotion}</div>
                    {hoveredTrade.rules?.some(r => r.broken) && <div className="t-label" style={{ color: "#E8724A" }}>Rule breach</div>}
                  </div>
                </motion.div>
              )}
            </motion.div>
          </div>
        </motion.div>

        {/* ── Performance review ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", borderTop: "1px solid var(--b1)" }}>
          {[
            { label: "Yesterday",  sessions: sestsYest,  mid: false },
            { label: "This week",  sessions: sestsWeek,  mid: true  },
            { label: "This month", sessions: sestsMonth, mid: false },
          ].map(({ label, sessions: s, mid }, i) => (
            <motion.div key={label}
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.21, delay: 0.18 + i * 0.05, ease: "easeOut" }}
              style={{
                padding: "40px 0",
                ...(mid ? { paddingLeft: 48, paddingRight: 48, background: "rgba(255,255,255,0.015)" } : {}),
                ...(i === 2 ? { paddingLeft: 48 } : {}),
                overflow: "hidden",
                position: "relative",
              }}
            >
              <PeriodCol label={label} sessions={s} />
            </motion.div>
          ))}
        </div>

      </div>
    </div>
  );
}
