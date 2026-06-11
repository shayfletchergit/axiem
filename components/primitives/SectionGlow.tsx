"use client";

/**
 * SectionGlow — targeted radial bloom behind a section
 *
 * Usage:
 *   <SectionGlow color="#2CC4A4" intensity={0.08} position="top-left" />
 *
 * Places a soft radial gradient anchored to a section.
 * Used to give the HUD graph panel, Today summary, and
 * performance columns subtle tonal depth without boxing.
 */

interface Props {
  color?: string;
  intensity?: number;         // 0–1, opacity multiplier
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  size?: string;              // CSS size e.g. "80%"
  blur?: number;              // px
  className?: string;
  animation?: string;         // full CSS animation shorthand, e.g. "sectionGlowPulseWarn 3s ease-in-out infinite"
}

const POSITIONS: Record<string, { top?: string; bottom?: string; left?: string; right?: string; transform?: string }> = {
  "top-left":     { top: "-20%", left: "-15%" },
  "top-right":    { top: "-20%", right: "-15%" },
  "bottom-left":  { bottom: "-20%", left: "-15%" },
  "bottom-right": { bottom: "-20%", right: "-15%" },
  "center":       { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
};

export function SectionGlow({
  color = "rgba(200,168,75,1)",
  intensity = 0.08,
  position = "top-right",
  size = "70%",
  blur = 56,
  className,
  animation,
}: Props) {
  const pos = POSITIONS[position] || POSITIONS["top-right"];

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        position: "absolute",
        pointerEvents: "none",
        zIndex: 0,
        width: size,
        aspectRatio: "1",
        borderRadius: "50%",
        background: `radial-gradient(circle at center, ${color} 0%, transparent 70%)`,
        filter: `blur(${blur}px)`,
        opacity: intensity,
        animation,
        willChange: animation ? "opacity, transform" : undefined,
        ...pos,
      }}
    />
  );
}
