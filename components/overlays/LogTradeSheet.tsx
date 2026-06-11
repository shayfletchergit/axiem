"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@/lib/store/session";
import type { Trade } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

function fmt(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}T${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

export function LogTradeSheet({ open, onClose }: Props) {
  const { rules, logTrade, baseline } = useStore();
  const [entry, setEntry] = useState(fmt(new Date()));
  const [exit,  setExit]  = useState(fmt(new Date()));
  const [r,     setR]     = useState("");
  const [sz,    setSz]    = useState(String(baseline.size));
  const [setup, setSetup] = useState("Trend cont.");
  const [em,    setEm]    = useState("");
  const [brokenRules, setBrokenRules] = useState<boolean[]>(rules.map(() => false));
  const [notes, setNotes] = useState("");

  const handleSubmit = () => {
    if (!exit || isNaN(parseFloat(r))) return;
    const entryMs = new Date(entry).getTime();
    const exitMs  = new Date(exit).getTime();
    logTrade({
      entryMs, exitMs, r: parseFloat(r),
      size: parseInt(sz) || baseline.size,
      setup, emotion: em,
      rules: rules.map((text, i) => ({ text, broken: brokenRules[i] })),
      notes,
    });
    onClose();
    setR(""); setNotes("");
    setBrokenRules(rules.map(() => false));
  };

  const inputCls = "w-full h-[34px] px-2.5 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4 focus:ring-0";
  const inputStyle = { border: "1px solid rgba(255,255,255,0.07)" };
  const focusStyle = { border: "1px solid rgba(255,255,255,0.11)" };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.21 }}
            className="fixed inset-0 z-[7000]"
            style={{ background: "rgba(16,15,14,0.75)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
            onClick={onClose} />
          <motion.div
            initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16,1,0.3,1] }}
            className="fixed bottom-0 left-1/2 -translate-x-1/2 z-[7001] w-full max-w-[480px] rounded-t-lg overflow-hidden"
            style={{ background: "rgba(29,27,25,0.97)", border: "1px solid rgba(255,255,255,0.08)", borderBottom: "none",
              backdropFilter: "blur(32px)", WebkitBackdropFilter: "blur(32px)",
              boxShadow: "0 -8px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)" }}
          >
            <div className="w-7 h-0.5 rounded-full mx-auto mt-3 mb-5" style={{ background: "rgba(255,255,255,0.15)" }} />
            <div className="px-8 pb-8">
              <div className="text-sm font-medium text-t1 mb-5">Log a trade</div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div><label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-1.5">Entry</label>
                  <input type="datetime-local" value={entry} onChange={e => setEntry(e.target.value)} className={inputCls} style={inputStyle} /></div>
                <div><label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-1.5">Exit</label>
                  <input type="datetime-local" value={exit} onChange={e => setExit(e.target.value)} className={inputCls} style={inputStyle} /></div>
                <div><label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-1.5">Result (R)</label>
                  <input type="number" step="0.1" value={r} onChange={e => setR(e.target.value)} placeholder="+1.5 or −0.8" className={inputCls} style={inputStyle} /></div>
                <div><label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-1.5">Contracts</label>
                  <input type="number" value={sz} onChange={e => setSz(e.target.value)} className={inputCls} style={inputStyle} /></div>
                <div><label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-1.5">Setup</label>
                  <select value={setup} onChange={e => setSetup(e.target.value)} className={inputCls + " cursor-pointer"} style={inputStyle}>
                    {["Trend cont.","Reversal","Breakout","Range fade","Other"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select></div>
                <div><label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-1.5">State</label>
                  <select value={em} onChange={e => setEm(e.target.value)} className={inputCls + " cursor-pointer"} style={inputStyle}>
                    <option value="">Select...</option>
                    {["clear","focused","confident","elevated","fatigued"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select></div>
              </div>
              {rules.length > 0 && (
                <div className="mb-3">
                  <label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-2">Rules broken?</label>
                  <div className="space-y-1.5">
                    {rules.map((rule, i) => (
                      <label key={i} className="flex items-center gap-2.5 cursor-pointer text-xs text-t2">
                        <input type="checkbox" checked={brokenRules[i]} onChange={e => setBrokenRules(b => b.map((v, j) => j === i ? e.target.checked : v))}
                          className="w-3.5 h-3.5 rounded-[1px]" style={{ accentColor: "#2CC4A4" }} />
                        {rule}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="mb-5">
                <label className="text-2xs font-semibold tracking-[0.09em] uppercase text-t3 block mb-1.5">Notes</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional"
                  className={inputCls + " h-auto py-2 resize-none"} style={inputStyle} />
              </div>
              <div className="flex gap-2 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <button onClick={onClose} className="h-8 px-4 text-xs text-t3 rounded-[2px] transition-all" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>Cancel</button>
                <button onClick={handleSubmit} className="flex-1 h-8 text-xs font-medium rounded-[2px] transition-all"
                  style={{ background: "rgba(232,228,220,0.92)", color: "rgb(25,24,22)", border: "none" }}>
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
