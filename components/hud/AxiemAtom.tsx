"use client";

/**
 * components/hud/AxiemAtom.tsx
 *
 * The Axiem brand mark rendered as a dithered particle field — three blades
 * (Frequency / Pace / Sizing) that sit near-solid when behaviour is aligned and
 * dither/disperse outward as each dimension's deviation grows. Pure presentation;
 * driven entirely by props derived from the live dashboard snapshot.
 *
 * Honours prefers-reduced-motion: when set, the field renders a single static
 * frame (no shimmer, no RAF) and only re-paints when the inputs change.
 */

import { useEffect, useRef } from "react";

export type AtomMode = "live" | "calibrating" | "disconnected";

export interface AxiemAtomProps {
  /** Per-blade dispersal 0..1 (0 = solid/aligned, 1 = fully fragmented). */
  intensity: { freq: number; pace: number; size: number };
  mode: AtomMode;
  /** Optional fixed width in px. Defaults to a responsive hero size. */
  size?: number;
  /** Force reduced motion. If omitted, prefers-reduced-motion is auto-detected. */
  reducedMotion?: boolean;
  /** Centered overlay (e.g. the A-Game alignment label). */
  children?: React.ReactNode;
}

const BLADE_D: Record<"freq" | "pace" | "size", string> = {
  freq: "M453.236 407.657C406.964 467.478 334.481 505.998 253 505.998C172.221 505.998 100.284 468.141 53.9639 409.201C60.5202 413.487 68.2783 415.998 76.7441 415.998H428.238C437.675 415.998 446.238 412.877 453.236 407.657Z",
  pace: "M253.93 0C393.23 0.501111 506 113.58 506 252.998C506 300.54 492.886 345.019 470.079 383.016C472.654 374.113 472.761 364.229 469.657 354.454H469.707C445.772 278.789 392.68 145.164 289.453 21.0225C283.1 10.6422 273.004 3.63365 261.923 1.05176C261.381 0.946389 260.84 0.84072 260.298 0.735352C259.855 0.630003 259.362 0.525365 258.919 0.472656C258.229 0.367279 257.589 0.314355 256.899 0.208984C256.506 0.208984 256.112 0.103594 255.718 0.103516C255.138 0.103516 254.511 0.0516484 253.93 0Z",
  size: "M250.061 0.0146484C249.775 0.0286961 249.491 0.0546892 249.217 0.103516C248.823 0.103516 248.428 0.208984 248.034 0.208984C247.345 0.261672 246.705 0.367305 246.016 0.472656C245.572 0.525348 245.079 0.629968 244.636 0.735352C244.094 0.840712 243.552 0.946398 243.011 1.05176C231.93 3.63368 221.883 10.6423 215.48 21.0225C112.352 145.164 59.3097 278.789 35.3252 354.454C32.5765 363.155 32.3635 371.944 34.166 380.049C12.442 342.712 0 299.308 0 252.998C0 114.251 111.687 1.58996 250.061 0.0146484Z",
};
const LAVA: Record<"freq" | "pace" | "size", [number, string][]> = {
  freq: [[0, "#FBA13C"], [0.42, "#F2702A"], [0.62, "#D63C7E"], [0.82, "#7A2E8E"], [1, "#241A4A"]],
  pace: [[0, "#F77BB0"], [0.42, "#EC4E96"], [0.64, "#B23C96"], [0.84, "#5E2E8E"], [1, "#201A48"]],
  size: [[0, "#B488EC"], [0.42, "#8A60DE"], [0.64, "#6A40C0"], [0.84, "#3E2E92"], [1, "#1C1A46"]],
};
const STALE = "#6E747C";
const LOGO_C = 253, STEP = 3.4, SCATTER = 150;
const BLADES = ["freq", "pace", "size"] as const;
type Blade = (typeof BLADES)[number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

interface Pt { x: number; y: number; ux: number; uy: number; tw: number; r1: number; r3: number; ph: number }

export function AxiemAtom({ intensity, mode, size, reducedMotion, children }: AxiemAtomProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ intensity, mode });
  stateRef.current = { intensity, mode };
  const drawRef = useRef<(t: number) => void>(() => {});
  const reducedRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = reducedMotion ?? (typeof window !== "undefined" &&
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    reducedRef.current = !!reduced;

    // Build point fields once via point-in-path on an offscreen canvas.
    const off = document.createElement("canvas");
    off.width = 506; off.height = 506;
    const octx = off.getContext("2d")!;
    const fields: Record<Blade, Pt[]> = { freq: [], pace: [], size: [] };
    for (const k of BLADES) {
      const path = new Path2D(BLADE_D[k]);
      for (let y = STEP / 2; y < 506; y += STEP) {
        for (let x = STEP / 2; x < 506; x += STEP) {
          if (!octx.isPointInPath(path, x, y)) continue;
          const jx = x + (Math.random() - 0.5) * STEP * 0.85;
          const jy = y + (Math.random() - 0.5) * STEP * 0.85;
          const dx = jx - LOGO_C, dy = jy - LOGO_C, dist = Math.hypot(dx, dy) || 1;
          fields[k].push({ x: jx, y: jy, ux: dx / dist, uy: dy / dist, tw: smooth(0.1, 1, dist / LOGO_C), r1: Math.random(), r3: Math.random(), ph: Math.random() * 6.28 });
        }
      }
    }

    let CW = 0, S2 = 0;
    const grads: Record<Blade, CanvasGradient> = {} as Record<Blade, CanvasGradient>;
    const sizeCanvas = () => {
      const w = wrap.clientWidth || 320;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      CW = w;
      canvas.width = w * dpr; canvas.height = w * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      S2 = (120 / 253) * CW / 336;
      const c = CW / 2, R = 300 * S2;
      for (const k of BLADES) {
        const g = ctx.createRadialGradient(c, c, 0, c, c, R);
        LAVA[k].forEach(([o, col]) => g.addColorStop(o, col));
        grads[k] = g;
      }
    };
    sizeCanvas();

    const l2c = (v: number) => CW / 2 + (v - LOGO_C) * S2;
    const draw = (t: number) => {
      const { intensity: inten, mode: m } = stateRef.current;
      ctx.clearRect(0, 0, CW, CW);
      ctx.globalAlpha = m === "disconnected" ? 0.28 : 1;
      for (const k of BLADES) {
        let p = inten[k];
        if (m === "calibrating") p = reducedRef.current ? 0.12 : 0.12 + 0.05 * Math.sin(t * 0.6);
        if (m === "disconnected") p = 0;
        const pts = fields[k];
        const dpx = STEP * S2 * (1.25 - 0.5 * clamp01(p));
        ctx.fillStyle = m === "disconnected" ? STALE : grads[k];
        for (let i = 0; i < pts.length; i++) {
          const c = pts[i];
          const burst = p * p * SCATTER * (0.06 + c.tw * 1.25) * (0.5 + 0.9 * c.r1);
          const disp = burst + (reducedRef.current ? 0 : Math.sin(t * 0.9 + c.ph) * 2 * p);
          const flown = disp / SCATTER;
          if (c.r3 > 1 - smooth(0.2, 1.15, flown)) continue;
          ctx.fillRect(l2c(c.x + c.ux * disp) - dpx / 2, l2c(c.y + c.uy * disp) - dpx / 2, dpx, dpx);
        }
      }
      ctx.globalAlpha = 1;
    };
    drawRef.current = draw;

    const ro = new ResizeObserver(() => { sizeCanvas(); if (reducedRef.current) draw(0); });
    ro.observe(wrap);

    let raf = 0;
    if (reduced) {
      draw(0); // single static frame
    } else {
      const frame = (ts: number) => { draw(ts / 1000); raf = requestAnimationFrame(frame); };
      raf = requestAnimationFrame(frame);
    }

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [reducedMotion]);

  // Reduced-motion: repaint a single frame when inputs change (no loop running).
  useEffect(() => {
    if (reducedRef.current) drawRef.current(0);
  }, [intensity, mode]);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: size ? `${size}px` : "min(360px, 86vw)", aspectRatio: "1" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
        {children}
      </div>
    </div>
  );
}
