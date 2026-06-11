"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@/lib/store/session";
import { calcEFD, calcPLB, calcSCI, calcBSS, fmtD, fmtDur } from "@/lib/engine";

export function History() {
  const sessions = useStore((s) => s.sessions);
  const baseline = useStore((s) => s.baseline);
  const [open, setOpen] = useState<number | null>(null);
  const reversed = [...sessions].reverse();

  return (
    <div style={{ overflowY: "auto", height: "100%", scrollbarWidth: "none" }}>
      <div style={{ padding: "40px 56px 120px", maxWidth: 780 }}>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: "easeOut" }}>
          <h2
            style={{
              fontSize: "var(--fs-d3)",
              lineHeight: "var(--lh-heading)",
              letterSpacing: "var(--ls-heading)",
              fontWeight: 400,
              color: "rgb(var(--t1))",
              marginBottom: 10,
            }}
          >
            Sessions
          </h2>
          <p className="t-meta" style={{ color: "rgb(var(--t3))", marginBottom: 48 }}>
            Your session record — not analytics. Your discipline over time.
          </p>
        </motion.div>

        {!reversed.length && (
          <p className="t-body" style={{ color: "rgb(var(--t4))", fontStyle: "italic", padding: "40px 0" }}>
            No sessions yet. End a session to begin your record.
          </p>
        )}

        <div>
          {reversed.map((sess, i) => {
            const t = sess.trades;
            const bss = calcBSS(calcEFD(t, baseline), calcPLB(t), calcSCI(t, baseline));
            const r   = t.reduce((s, tr) => s + tr.r, 0);
            const wr  = t.length ? Math.round(t.filter(tr => tr.r > 0).length / t.length * 100) : 0;
            const dur = sess.endMs ? fmtDur(sess.endMs - sess.startMs) : "--";
            const breaches = t.filter(tr => tr.rules?.some(ru => ru.broken)).length;
            const sc = bss.score ?? 0;
            const stateCol = sc >= 70 ? "#2CC4A4" : sc >= 50 ? "#D4A84B" : "#E8724A";
            const stateLabel = sc >= 70 ? "In form" : sc >= 50 ? "Caution" : "Off form";
            const isOpen = open === i;

            return (
              <motion.div
                key={sess.startMs}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.21, delay: i * 0.025, ease: "easeOut" }}
                style={{
                  borderTop: i === 0 ? "1px solid rgba(255,255,255,0.04)" : "none",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  padding: "22px 0",
                  cursor: "pointer",
                }}
                onClick={() => setOpen(isOpen ? null : i)}
                onMouseOver={(e) => (e.currentTarget.style.opacity = "0.75")}
                onMouseOut={(e)  => (e.currentTarget.style.opacity = "1")}
              >
                {/* Row 1: date + badge */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span className="t-body" style={{ color: "rgb(var(--t1))", fontWeight: 500 }}>
                    {fmtD(sess.startMs)}
                  </span>
                  {bss.score !== null && (
                    <span
                      className="t-label"
                      style={{
                        padding: "2px 8px", borderRadius: 1, border: `1px solid ${stateCol}30`,
                        color: stateCol, background: `${stateCol}15`,
                      }}
                    >
                      {stateLabel}
                    </span>
                  )}
                </div>

                {/* Row 2: meta stats */}
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "baseline" }}>
                  {[
                    { v: `${t.length} trades`,                             c: "rgb(var(--t2))" },
                    { v: `${r >= 0 ? "+" : ""}${r.toFixed(1)}R`,          c: r >= 0 ? "#2CC4A4" : "#E8724A" },
                    { v: `${wr}% win rate`,                                c: "rgb(var(--t3))" },
                    { v: dur,                                               c: "rgb(var(--t3))" },
                    ...(breaches > 0 ? [{ v: `${breaches} breach${breaches > 1 ? "es" : ""}`, c: "#D4A84B" }] : []),
                  ].map(({ v, c }) => (
                    <span key={v} className="t-meta t-tab" style={{ color: c, fontWeight: 500 }}>{v}</span>
                  ))}
                </div>

                {/* Reflection (expanded) */}
                <AnimatePresence>
                  {isOpen && sess.reflection && (
                    <motion.p
                      initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.21, ease: "easeOut" }}
                      className="t-meta"
                      style={{ color: "rgb(var(--t3))", fontStyle: "italic", marginTop: 12, overflow: "hidden", lineHeight: 1.7 }}
                    >
                      {sess.reflection}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
