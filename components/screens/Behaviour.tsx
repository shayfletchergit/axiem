"use client";

import { motion } from "framer-motion";
import { useSignals } from "@/hooks/useSignals";

export function Behaviour() {
  const { efd, plb, sci, bss, trades } = useSignals();
  const breaches = trades.filter(t => t.rules?.some(r => r.broken)).length;

  const items: { title: string; text: string; sev: "ok"|"warn"|"crit"|"neu"; tag: string }[] = [];
  if (breaches > 0) items.push({ title: `${breaches} rule breach${breaches > 1 ? "es" : ""} this session`, text: "Your rules exist because past-you knew this would happen. Follow them.", sev: "crit", tag: "Discipline" });
  if (efd.state === "critical") items.push({ title: "Entry pace critically compressed", text: `Averaging ${efd.rawMins}m — significantly below baseline. Strongest early blowup signal.`, sev: "crit", tag: "Entry Pace" });
  else if (efd.state === "warning") items.push({ title: "Entry pace elevating", text: "Gap between entries is narrowing. Watch for the urge to chase.", sev: "warn", tag: "Entry Pace" });
  else if (efd.state === "ok" && trades.length >= 2) items.push({ title: "Entry rhythm stable", text: `Pace at ${efd.rawMins}m — within baseline. Continue at this cadence.`, sev: "ok", tag: "Entry Pace" });
  if (plb.state === "critical") items.push({ title: "Reactive behaviour after losses", text: "Re-entering quickly after losing trades. This pattern precedes the largest drawdowns in your history.", sev: "crit", tag: "After a Loss" });
  else if (plb.state === "ok" && trades.some(t => t.r < -0.1)) items.push({ title: "Composure after losses", text: "Maintaining space between losing trades and re-entries. One of the hardest disciplines to sustain.", sev: "ok", tag: "After a Loss" });
  if (sci.state !== "insufficient" && sci.state !== "ok") items.push({ title: "Size deviation detected", text: `Current sizing at ${sci.label}. Deviation from baseline is an emotional signal.`, sev: sci.state === "critical" ? "crit" : "warn", tag: "Size Control" });
  if (!items.length) items.push({ title: "Building baseline", text: "Log more trades across a few sessions to surface behavioural patterns.", sev: "neu", tag: "Getting started" });

  const sevCol = { ok: "#2CC4A4", warn: "#D4A84B", crit: "#E8724A", neu: "rgb(var(--t3))" };

  return (
    <div style={{ overflowY: "auto", height: "100%", scrollbarWidth: "none" }}>
      <div style={{ padding: "40px 56px 120px", maxWidth: 780 }}>
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: "easeOut" }}>
          <h2 style={{ fontSize: "var(--fs-d3)", lineHeight: "var(--lh-heading)", letterSpacing: "var(--ls-heading)", fontWeight: 400, color: "rgb(var(--t1))", marginBottom: 10 }}>
            Behaviour
          </h2>
          <p className="t-meta" style={{ color: "rgb(var(--t3))", marginBottom: 48 }}>
            Live pattern analysis — updated with every trade.
          </p>
        </motion.div>
        <div>
          {items.map((item, i) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.21, delay: i * 0.04, ease: "easeOut" }}
              style={{
                borderTop: i === 0 ? "1px solid rgba(255,255,255,0.04)" : "none",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                padding: "22px 0",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: sevCol[item.sev], flexShrink: 0 }} />
                <span className="t-body" style={{ color: "rgb(var(--t1))", fontWeight: 500 }}>{item.title}</span>
                <span
                  className="t-label"
                  style={{ marginLeft: "auto", padding: "2px 7px", borderRadius: 1, background: "rgba(255,255,255,0.04)", color: "rgb(var(--t3))" }}
                >
                  {item.tag}
                </span>
              </div>
              <p className="t-meta" style={{ color: "rgb(var(--t2))", lineHeight: 1.65, paddingLeft: 14 }}>{item.text}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
