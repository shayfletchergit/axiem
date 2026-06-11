"use client";

import { useRef, useEffect, useCallback } from "react";
import { useStore } from "@/lib/store/session";
import { calcEFD, calcPLB, calcSCI, calcBSS, sigHealth } from "@/lib/engine";
import type { Trade, Baseline } from "@/lib/types";

function signalHealthAtTime(trades: Trade[], t: number, baseline: Baseline) {
  const tt = trades.filter(tr => tr.exitMs <= t);
  return {
    efd: sigHealth(calcEFD(tt, baseline).state),
    plb: sigHealth(calcPLB(tt).state),
    sci: sigHealth(calcSCI(tt, baseline).state),
  };
}

function bssAtTime(trades: Trade[], t: number, baseline: Baseline): number {
  const tt = trades.filter(tr => tr.exitMs <= t);
  return calcBSS(calcEFD(tt, baseline), calcPLB(tt), calcSCI(tt, baseline)).score ?? 65;
}

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const cpx = ((a.x + b.x) / 2).toFixed(1);
    d += ` C ${cpx} ${a.y.toFixed(1)} ${cpx} ${b.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  }
  return d;
}

interface MarkerDatum {
  x: number; groundY: number;
  trade: Trade; idx: number; score: number;
}

interface Props {
  onHoverTrade?: (t: Trade | null, score: number) => void;
}

export function HUDGraph({ onHoverTrade }: Props) {
  const canvasRef  = useRef<SVGSVGElement>(null);
  const markersRef = useRef<MarkerDatum[]>([]);

  const session  = useStore(s => s.session);
  const sessions = useStore(s => s.sessions);
  const baseline = useStore(s => s.baseline);
  const trades   = session?.trades ?? [];

  const draw = useCallback(() => {
    const svg = canvasRef.current;
    if (!svg) return;
    const W = svg.clientWidth || 380;
    const H = svg.clientHeight || 160;
    const pL = 6, pR = 28, pT = 8, pB = 28;
    const iW = W - pL - pR, iH = H - pT - pB;
    const toY = (v: number) => pT + (1 - Math.max(0, Math.min(100, v)) / 100) * iH;

    const sessStart = session?.startMs ?? Date.now() - 3 * 3600000;
    const sessEnd   = Date.now();
    const dur       = Math.max(1, sessEnd - sessStart);
    const N = Math.min(48, Math.max(10, trades.length * 5 + 4));

    // Compute all 3 signal series in one pass
    const signalPts = Array.from({ length: N + 1 }, (_, i) => {
      const t = sessStart + (i / N) * dur;
      const x = pL + (i / N) * iW;
      const h = signalHealthAtTime(trades, t, baseline);
      return { x, efd: toY(h.efd), plb: toY(h.plb), sci: toY(h.sci) };
    });
    const efdPts = signalPts.map(p => ({ x: p.x, y: p.efd }));
    const plbPts = signalPts.map(p => ({ x: p.x, y: p.plb }));
    const sciPts = signalPts.map(p => ({ x: p.x, y: p.sci }));

    // Previous session ghost (EFD only, very faint)
    let ghost = "";
    if (sessions.length > 0) {
      const prev = sessions[sessions.length - 1];
      const pDur = (prev.endMs ?? prev.startMs + 21600000) - prev.startMs;
      const gPts = Array.from({ length: N + 1 }, (_, i) => {
        const tg = prev.startMs + (i / N) * pDur;
        const h  = signalHealthAtTime(prev.trades, tg, baseline);
        return { x: pL + (i / N) * iW, y: toY((h.efd + h.plb + h.sci) / 3) };
      });
      ghost = `<path d="${smoothPath(gPts)}" stroke="rgba(255,255,255,0.07)" stroke-width="1" fill="none" stroke-dasharray="3 5" stroke-linecap="round"/>`;
    }

    // Grid lines
    const grid = [
      { v: 70, dash: "4 5", op: 0.10, lbl: "In form" },
      { v: 50, dash: "3 5", op: 0.05, lbl: "Watch" },
    ].map(({ v, dash, op, lbl }) => {
      const gy = toY(v);
      return `<line x1="${pL}" x2="${W - pR}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,${op})" stroke-width="0.75" stroke-dasharray="${dash}"/>
              <text x="${W - pR + 3}" y="${(gy + 3.5).toFixed(1)}" font-family="Syne,sans-serif" font-size="8" fill="rgba(255,255,255,0.18)" text-anchor="start">${lbl}</text>`;
    }).join("");

    // Trade markers along the bottom axis
    let markers = "";
    markersRef.current = [];
    trades.forEach((trade, i) => {
      const relT = (trade.exitMs - sessStart) / dur;
      if (relT < 0 || relT > 1.02) return;
      const mx  = pL + relT * iW;
      const sc  = bssAtTime(trades.slice(0, i + 1), trade.exitMs + 1, baseline);
      const dc  = trade.r > 0.1 ? "#2CC4A4" : trade.r < -0.1 ? "#E8724A" : "#888480";
      const gY  = pT + iH;
      const breach = trade.rules?.some(r => r.broken);
      markers += `<line x1="${mx.toFixed(1)}" y1="${gY}" x2="${mx.toFixed(1)}" y2="${gY + 5}" stroke="${dc}" stroke-width="1.25" opacity="0.5"/>`;
      markers += `<text x="${mx.toFixed(1)}" y="${gY + 14}" font-family="Syne,sans-serif" font-size="8" font-weight="500" fill="${dc}" text-anchor="middle" opacity="0.85">${i + 1}</text>`;
      if (breach) markers += `<rect x="${(mx - 1.5).toFixed(1)}" y="${gY + 16}" width="3" height="3" fill="#E8724A" opacity="0.7"/>`;
      markersRef.current.push({ x: mx, groundY: gY + 14, trade, idx: i + 1, score: sc });
    });

    // Leading endpoint dots
    const leadDots = trades.length > 0 ? (
      [
        { pts: efdPts, col: "#E8724A" },
        { pts: plbPts, col: "#2CC4A4" },
        { pts: sciPts, col: "#7B7FD4" },
      ].map(({ pts, col }) => {
        const last = pts[pts.length - 1];
        return `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="rgb(25,24,22)" stroke="${col}" stroke-width="1.5"/>` +
               `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="1" fill="${col}"/>`;
      }).join("")
    ) : "";

    // Time axis
    const nT = Math.min(5, Math.max(2, Math.floor(iW / 72)));
    const timeAxis = Array.from({ length: nT + 1 }, (_, ti) => {
      const tx  = pL + (ti / nT) * iW;
      const tMs = sessStart + (ti / nT) * dur;
      const tD  = new Date(tMs);
      const tl  = `${tD.getHours().toString().padStart(2, "0")}:${tD.getMinutes().toString().padStart(2, "0")}`;
      return `<text x="${tx.toFixed(1)}" y="${H - 4}" font-family="Syne,sans-serif" font-size="8" fill="rgba(255,255,255,0.12)" text-anchor="middle">${tl}</text>`;
    }).join("");

    const ch = `<line id="hud-ch" x1="0" y1="${pT}" x2="0" y2="${pT + iH}" stroke="rgba(255,255,255,0.10)" stroke-width="0.75" style="display:none" pointer-events="none"/>`;

    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = grid + ghost
      + `<path d="${smoothPath(efdPts)}" stroke="#E8724A" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`
      + `<path d="${smoothPath(plbPts)}" stroke="#2CC4A4" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`
      + `<path d="${smoothPath(sciPts)}" stroke="#7B7FD4" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`
      + leadDots + markers + ch + timeAxis;
  }, [trades, sessions, baseline, session]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const svg = canvasRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(draw);
    ro.observe(svg.parentElement!);
    return () => ro.disconnect();
  }, [draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = canvasRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const W    = svg.clientWidth || 380;
    const mx   = (e.clientX - rect.left) * (W / rect.width);
    const ch   = svg.querySelector("#hud-ch") as SVGLineElement | null;
    if (ch) { ch.setAttribute("x1", mx.toFixed(1)); ch.setAttribute("x2", mx.toFixed(1)); ch.style.display = ""; }
    const nearest = markersRef.current.reduce<MarkerDatum | null>((n, m) => {
      const d = Math.abs(mx - m.x);
      return d < 24 && (!n || d < Math.abs(mx - n.x)) ? m : n;
    }, null);
    onHoverTrade?.(nearest?.trade ?? null, nearest?.score ?? 0);
  }, [onHoverTrade]);

  const handleMouseLeave = useCallback(() => {
    const svg = canvasRef.current;
    const ch  = svg?.querySelector("#hud-ch") as SVGLineElement | null;
    if (ch) ch.style.display = "none";
    onHoverTrade?.(null, 0);
  }, [onHoverTrade]);

  return (
    <svg
      ref={canvasRef}
      className="w-full h-full block overflow-visible"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    />
  );
}
