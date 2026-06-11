"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Props {
  open: boolean;
  insight: string;
  pattern: string;
  question: string;
  durationSecs: number;
  onDismiss: (decision: "proceed" | "delay" | "cancel") => void;
}

export function PauseOverlay({ open, insight, pattern, question, durationSecs, onDismiss }: Props) {
  const [remaining, setRemaining] = useState(durationSecs);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTimer = useCallback((secs: number) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setRemaining(secs);
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current!); return 0; }
        return r - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    if (!open) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setRemaining(durationSecs);
      return;
    }
    startTimer(durationSecs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [open, durationSecs, startTimer]);

  const handleDelay = () => {
    // Add 60 seconds to the current remaining time
    startTimer(remaining + 60);
  };

  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const progress = 1 - remaining / durationSecs;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: "easeInOut" }}
          style={{
            position: "fixed", inset: 0, zIndex: 9000,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            padding: "40px 28px", textAlign: "center", overflowY: "auto",
            background: "rgba(16,15,14,0.97)",
            backdropFilter: "blur(40px) saturate(0.8)",
            WebkitBackdropFilter: "blur(40px) saturate(0.8)",
          }}
        >
          {/* Atmospheric blobs */}
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
            <div style={{
              position: "absolute", top: "-10%", right: "-10%",
              width: "55%", aspectRatio: "1", borderRadius: "50%",
              background: "radial-gradient(circle at center, rgba(232,114,74,0.12) 0%, transparent 70%)",
              filter: "blur(60px)", animation: "ambientDrift0 14s ease-in-out infinite",
            }} />
            <div style={{
              position: "absolute", bottom: "-15%", left: "-10%",
              width: "50%", aspectRatio: "1", borderRadius: "50%",
              background: "radial-gradient(circle at center, rgba(154,74,64,0.09) 0%, transparent 70%)",
              filter: "blur(56px)", animation: "ambientDrift1 18s ease-in-out 3s infinite",
            }} />
            <div style={{
              position: "absolute", top: "30%", left: "10%",
              width: "40%", aspectRatio: "1", borderRadius: "50%",
              background: "radial-gradient(circle at center, rgba(200,168,75,0.06) 0%, transparent 70%)",
              filter: "blur(48px)", animation: "ambientDrift2 22s ease-in-out 6s infinite",
            }} />
          </div>

          <div style={{ position: "relative", zIndex: 1 }}>
            <div className="t-label" style={{ color: "rgb(var(--t4))", marginBottom: 48, letterSpacing: "0.17em" }}>
              Axiem · Pause
            </div>

            {/* Breathing ring with countdown */}
            <motion.div
              animate={{ scale: [1, 1.06, 1], borderColor: ["rgba(255,255,255,0.06)", "rgba(255,255,255,0.10)", "rgba(255,255,255,0.06)"] }}
              transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
              style={{
                width: 128, height: 128, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.06)",
                display: "flex", alignItems: "center", justifyContent: "center",
                margin: "0 auto 32px",
                boxShadow: "0 0 40px rgba(232,114,74,0.08), inset 0 0 20px rgba(0,0,0,0.4)",
              }}
            >
              <div style={{ fontSize: 34, lineHeight: 0.97, letterSpacing: "-0.06em", fontWeight: 400, color: "rgb(var(--t2))", fontFeatureSettings: '"tnum" 1' }}>
                {m}:{s.toString().padStart(2, "0")}
              </div>
            </motion.div>

            {/* Progress bar */}
            <div style={{ width: 200, height: 1, background: "rgba(255,255,255,0.06)", borderRadius: 99, overflow: "hidden", margin: "0 auto 32px" }}>
              <motion.div
                animate={{ width: `${Math.min(progress * 100, 100)}%` }}
                transition={{ duration: 1, ease: "linear" }}
                style={{ height: "100%", background: "rgba(232,114,74,0.5)", borderRadius: 99 }}
              />
            </div>

            <div style={{ maxWidth: 440, margin: "0 auto" }}>
              <motion.p
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.2 }}
                style={{ fontSize: 17, lineHeight: 1.65, letterSpacing: "-0.01em", fontWeight: 400, color: "rgb(var(--t1))", marginBottom: 24, fontStyle: "italic" }}
              >
                {insight}
              </motion.p>

              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.35 }}
                style={{ textAlign: "left", marginBottom: 24, padding: "14px 18px", borderRadius: 2, border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)", fontSize: 11, lineHeight: 1.75, color: "rgb(80,78,74)" }}
              >
                <div className="t-label" style={{ color: "rgb(48,46,44)", marginBottom: 6 }}>Pattern detected</div>
                {pattern}
              </motion.div>

              <motion.p
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.5 }}
                style={{ fontSize: 17, lineHeight: 1.6, letterSpacing: "-0.01em", color: "rgb(var(--t1))", marginBottom: 56, fontStyle: "italic" }}
              >
                {question}
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.65 }}
                style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}
              >
                <button onClick={() => onDismiss("proceed")}
                  style={{
                    height: 48, padding: "0 20px", borderRadius: 2, fontSize: 12, fontWeight: 500,
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    width: "100%", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em",
                    background: "rgba(232,228,220,0.06)", border: "1px solid rgba(255,255,255,0.10)",
                    color: "rgb(232,228,220)", transition: "background 180ms ease",
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = "rgba(232,228,220,0.10)")}
                  onMouseOut={e  => (e.currentTarget.style.background = "rgba(232,228,220,0.06)")}
                >
                  <span>Proceed with full awareness</span><span style={{ opacity: 0.4 }}>→</span>
                </button>

                <button onClick={handleDelay}
                  style={{
                    height: 48, padding: "0 20px", borderRadius: 2, fontSize: 12, fontWeight: 400,
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    width: "100%", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em",
                    background: "transparent", border: "1px solid rgba(255,255,255,0.05)",
                    color: "rgb(136,132,128)", transition: "background 180ms ease",
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                  onMouseOut={e  => (e.currentTarget.style.background = "transparent")}
                >
                  <span>Wait — one more minute</span><span style={{ opacity: 0.4 }}>+1:00</span>
                </button>

                <button onClick={() => onDismiss("cancel")}
                  style={{
                    height: 40, fontSize: 11, letterSpacing: "0.03em", color: "rgb(48,46,44)",
                    background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
                    transition: "color 180ms ease",
                  }}
                  onMouseOver={e => (e.currentTarget.style.color = "rgb(80,78,74)")}
                  onMouseOut={e  => (e.currentTarget.style.color = "rgb(48,46,44)")}
                >
                  Cancel this trade
                </button>
              </motion.div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
