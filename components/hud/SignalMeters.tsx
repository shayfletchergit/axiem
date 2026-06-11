"use client";

import { motion } from "framer-motion";
import { useSignals } from "@/hooks/useSignals";

export function SignalMeters() {
  const { bss, trades } = useSignals();

  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
      <div>
        <div className="t-label" style={{ color: "rgb(var(--t3))", marginBottom: 6 }}>Form Score</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <motion.div
            key={bss.score}
            initial={{ opacity: 0.6 }}
            animate={{ opacity: 1 }}
            style={{
              fontSize: "clamp(36px, 4vw, 52px)",
              lineHeight: 0.97,
              letterSpacing: "-0.04em",
              fontWeight: 400,
              color: bss.score === null ? "rgb(var(--t3))"
                : bss.score >= 70 ? "#2CC4A4"
                : bss.score >= 50 ? "#D4A84B"
                : "#E8724A",
              transition: "color 500ms ease",
              fontFeatureSettings: '"tnum" 1',
            }}
          >
            {bss.score ?? "--"}
          </motion.div>
          {bss.score !== null && (
            <div
              className="t-meta"
              style={{
                fontWeight: 500,
                color: bss.score >= 70 ? "#2CC4A4" : bss.score >= 50 ? "#D4A84B" : "#E8724A",
                transition: "color 400ms ease",
              }}
            >
              {bss.score >= 70 ? "In form" : bss.score >= 50 ? "Watch zone" : "Stop trading"}
            </div>
          )}
        </div>
      </div>
      <div className="t-label" style={{ color: "rgb(var(--t4))", marginLeft: "auto", alignSelf: "flex-end", paddingBottom: 2 }}>
        {trades.length === 0 ? "Log a trade to begin"
          : trades.length === 1 ? "1 trade logged"
          : `${trades.length} trades`}
      </div>
    </div>
  );
}
