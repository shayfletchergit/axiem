"use client";

import { useEffect, useRef } from "react";
import { useSignals } from "@/hooks/useSignals";

/**
 * AmbientGradient — state-responsive atmospheric background
 *
 * Like the Nike reference: soft radial blobs, diffuse edges,
 * slow breathing animation. Three blobs that shift colour
 * based on the trader's behavioural state.
 *
 * Calm/disciplined → cool teal + gold
 * Watch zone       → amber + muted gold
 * Stop zone        → deep red-orange + amber
 * Volatile         → red-amber tension
 * No data          → neutral charcoal warmth
 */

interface BlobConfig {
  x: string;       // CSS left
  y: string;       // CSS top
  size: string;    // width/height
  color: string;   // gradient centre colour
  opacity: number;
  duration: number; // animation cycle seconds
  delay: number;
}

function getBlobs(state: string, score: number | null): BlobConfig[] {
  // Base blob positions inspired by Nike reference
  // — anchor points that drift slowly
  if (state === "ok" || (score !== null && score >= 70)) {
    // In form: cool teal top-left, gold centre-right, deep green bottom
    return [
      { x: "-10%",  y: "10%",  size: "70%", color: "rgba(44,196,164,0.35)", opacity: 1, duration: 14, delay: 0 },
      { x: "55%",   y: "25%",  size: "58%", color: "rgba(200,168,75,0.28)", opacity: 1, duration: 18, delay: 3 },
      { x: "20%",   y: "60%",  size: "65%", color: "rgba(44,196,164,0.18)", opacity: 1, duration: 22, delay: 6 },
    ];
  }
  if (state === "warning" || (score !== null && score >= 50 && score < 70)) {
    // Watch zone: warm amber dominant, muted gold secondary
    return [
      { x: "40%",   y: "-5%",  size: "70%", color: "rgba(212,168,75,0.38)", opacity: 1, duration: 12, delay: 0 },
      { x: "-5%",   y: "45%",  size: "58%", color: "rgba(232,114,74,0.28)", opacity: 1, duration: 16, delay: 4 },
      { x: "60%",   y: "55%",  size: "52%", color: "rgba(212,168,75,0.20)", opacity: 1, duration: 20, delay: 2 },
    ];
  }
  if (state === "critical" || (score !== null && score < 50)) {
    // Stop zone: orange-red tension, amber secondary
    return [
      { x: "50%",   y: "5%",   size: "75%", color: "rgba(232,114,74,0.40)", opacity: 1, duration: 10, delay: 0 },
      { x: "-15%",  y: "30%",  size: "65%", color: "rgba(154,74,64,0.30)", opacity: 1, duration: 14, delay: 3 },
      { x: "30%",   y: "55%",  size: "65%", color: "rgba(232,114,74,0.22)", opacity: 1, duration: 18, delay: 1 },
    ];
  }
  // Default / no data: warm neutral
  return [
    { x: "60%",   y: "-10%", size: "65%", color: "rgba(200,168,75,0.22)", opacity: 1, duration: 20, delay: 0 },
    { x: "-10%",  y: "50%",  size: "58%", color: "rgba(232,228,220,0.10)", opacity: 1, duration: 25, delay: 8 },
    { x: "30%",   y: "70%",  size: "52%", color: "rgba(200,168,75,0.14)", opacity: 1, duration: 18, delay: 4 },
  ];
}

export function AmbientGradient() {
  const { bss } = useSignals();
  const score = bss.score;
  const state = bss.state;
  const blobs = getBlobs(state, score);

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {blobs.map((blob, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: blob.x,
            top: blob.y,
            width: blob.size,
            aspectRatio: "1",
            borderRadius: "50%",
            background: `radial-gradient(circle at center, ${blob.color} 0%, transparent 70%)`,
            filter: "blur(48px)",
            opacity: blob.opacity,
            animation: `ambientDrift${i % 3} ${blob.duration}s ease-in-out ${blob.delay}s infinite`,
            transition: "background 2s ease, opacity 2s ease",
            willChange: "transform",
          }}
        />
      ))}
      <style>{`
        @keyframes ambientDrift0 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33%       { transform: translate(3%, -4%) scale(1.04); }
          66%       { transform: translate(-2%, 3%) scale(0.97); }
        }
        @keyframes ambientDrift1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          40%       { transform: translate(-4%, 3%) scale(1.06); }
          70%       { transform: translate(2%, -2%) scale(0.96); }
        }
        @keyframes ambientDrift2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50%       { transform: translate(3%, 4%) scale(1.03); }
          80%       { transform: translate(-1%, -3%) scale(0.98); }
        }
      `}</style>
    </div>
  );
}
