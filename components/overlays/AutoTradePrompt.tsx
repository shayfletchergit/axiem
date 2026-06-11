"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@/lib/store/session";
import type { BrokerTrade } from "@/lib/broker/types";

interface Props {
  trade: BrokerTrade | null;
  onClose: () => void;
}

const EMOTIONS = ["clear", "focused", "confident", "elevated", "fatigued"] as const;

function fmt(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AutoTradePrompt({ trade, onClose }: Props) {
  const { rules, logTrade } = useStore();
  const [emotion, setEmotion] = useState("");
  const [r, setR] = useState("");
  const [brokenRules, setBrokenRules] = useState<boolean[]>(rules.map(() => false));
  const [notes, setNotes] = useState("");

  const pnl = trade?.pnlPoints ?? 0;
  const pnlSign = pnl >= 0 ? "+" : "";
  const inputStyle = { border: "1px solid rgba(255,255,255,0.07)" };

  const handleSave = () => {
    if (!trade) return;
    logTrade({
      entryMs: new Date(trade.openedAt).getTime(),
      exitMs:  new Date(trade.closedAt!).getTime(),
      r:       parseFloat(r) || 0,
      size:    trade.closedSize,
      setup:   "Auto-imported",
      emotion,
      rules:   rules.map((text, i) => ({ text, broken: brokenRules[i] })),
      notes,
    });
    setEmotion(""); setR(""); setNotes("");
    setBrokenRules(rules.map(() => false));
    onClose();
  };

  const handleSkip = () => {
    if (!trade) return;
    logTrade({
      entryMs: new Date(trade.openedAt).getTime(),
      exitMs:  new Date(trade.closedAt!).getTime(),
      r:       pnl >= 0 ? 1 : -1,
      size:    trade.closedSize,
      setup:   "Auto-imported",
      emotion: "",
      rules:   rules.map((text) => ({ text, broken: false })),
      notes:   "",
    });
    onClose();
  };

  return (
    <AnimatePresence>
      {trade && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[7000]"
            style={{ background: "rgba(16,15,14,0.75)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
            onClick={onClose}
          />
          <motion.div
            initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-0 left-1/2 -translate-x-1/2 z-[7001] w-full max-w-[480px] rounded-t-lg overflow-hidden"
            style={{
              background: "rgba(29,27,25,0.97)", backdropFilter: "blur(32px)", WebkitBackdropFilter: "blur(32px)",
              border: "1px solid rgba(255,255,255,0.08)", borderBottom: "none",
              boxShadow: "0 -8px 40px rgba(0,0,0,0.55)",
            }}
          >
            <div className="w-7 h-0.5 rounded-full mx-auto mt-3 mb-5" style={{ background: "rgba(255,255,255,0.15)" }} />
            <div className="px-8 pb-8">

              <div className="flex items-start justify-between mb-5">
                <div>
                  <div className="text-2xs font-semibold tracking-[0.09em] uppercase mb-1" style={{ color: "rgb(var(--t4))" }}>
                    Tradovate · Trade closed
                  </div>
                  <div className="text-sm font-medium" style={{ color: "rgb(var(--t1))" }}>
                    {trade.direction === "long" ? "Long" : "Short"} · {trade.closedSize} contract{trade.closedSize !== 1 ? "s" : ""}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: "rgb(var(--t3))" }}>
                    {fmt(trade.openedAt)} → {fmt(trade.closedAt!)}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className="text-lg font-medium"
                    style={{ color: pnl >= 0 ? "#2CC4A4" : "#E8724A", fontFeatureSettings: '"tnum" 1' }}
                  >
                    {pnlSign}{pnl.toFixed(2)} pts
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: "rgb(var(--t4))" }}>
                    {trade.entryPrice.toFixed(2)} → {trade.exitPrice?.toFixed(2)}
                  </div>
                </div>
              </div>

              <div style={{ height: "1px", background: "rgba(255,255,255,0.05)", marginBottom: 20 }} />

              <div className="mb-4">
                <label className="text-2xs font-semibold tracking-[0.09em] uppercase block mb-1.5" style={{ color: "rgb(var(--t3))" }}>
                  R-multiple — your risk was?
                </label>
                <input
                  type="number" step="0.1" value={r} onChange={e => setR(e.target.value)}
                  placeholder={`e.g. ${pnl >= 0 ? "+1.5" : "−0.8"}`}
                  className="w-full h-[34px] px-2.5 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4"
                  style={inputStyle}
                />
                <p className="text-xs mt-1.5" style={{ color: "rgb(var(--t4))" }}>
                  Skip to log as {pnl >= 0 ? "+1R (win)" : "−1R (loss)"} automatically.
                </p>
              </div>

              <div className="mb-4">
                <label className="text-2xs font-semibold tracking-[0.09em] uppercase block mb-1.5" style={{ color: "rgb(var(--t3))" }}>
                  State during trade
                </label>
                <div className="flex gap-1.5 flex-wrap">
                  {EMOTIONS.map(em => (
                    <button key={em} onClick={() => setEmotion(em === emotion ? "" : em)}
                      className="px-3 py-1 text-xs rounded-[2px] transition-all capitalize"
                      style={{
                        border: `1px solid ${emotion === em ? "rgba(44,196,164,0.35)" : "rgba(255,255,255,0.07)"}`,
                        background: emotion === em ? "rgba(44,196,164,0.08)" : "transparent",
                        color: emotion === em ? "#2CC4A4" : "rgb(var(--t3))",
                      }}
                    >{em}</button>
                  ))}
                </div>
              </div>

              {rules.length > 0 && (
                <div className="mb-4">
                  <label className="text-2xs font-semibold tracking-[0.09em] uppercase block mb-2" style={{ color: "rgb(var(--t3))" }}>
                    Rules broken?
                  </label>
                  <div className="space-y-1.5">
                    {rules.map((rule, i) => (
                      <label key={i} className="flex items-center gap-2.5 cursor-pointer text-xs" style={{ color: "rgb(var(--t2))" }}>
                        <input
                          type="checkbox" checked={brokenRules[i]}
                          onChange={e => setBrokenRules(b => b.map((v, j) => j === i ? e.target.checked : v))}
                          className="w-3.5 h-3.5 rounded-[1px]" style={{ accentColor: "#2CC4A4" }}
                        />
                        {rule}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="mb-5">
                <label className="text-2xs font-semibold tracking-[0.09em] uppercase block mb-1.5" style={{ color: "rgb(var(--t3))" }}>
                  Notes
                </label>
                <textarea
                  value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional"
                  className="w-full h-auto py-2 px-2.5 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4 resize-none"
                  style={inputStyle}
                />
              </div>

              <div className="flex gap-2 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <button onClick={handleSkip}
                  className="h-8 px-4 text-xs rounded-[2px] transition-all"
                  style={{ color: "rgb(var(--t3))", border: "1px solid rgba(255,255,255,0.07)" }}
                >
                  Skip
                </button>
                <button onClick={handleSave}
                  className="flex-1 h-8 text-xs font-medium rounded-[2px] transition-all"
                  style={{ background: "rgba(232,228,220,0.92)", color: "rgb(25,24,22)", border: "none" }}
                >
                  Save trade
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
