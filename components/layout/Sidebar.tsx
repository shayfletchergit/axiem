"use client";

import { motion } from "framer-motion";
import { useStore } from "@/lib/store/session";
import type { Screen } from "@/lib/types";

const NAV_ITEMS: { id: Screen; label: string }[] = [
  { id: "overview",  label: "Overview" },
  { id: "behaviour", label: "Behaviour" },
  { id: "history",   label: "Sessions" },
  { id: "settings",  label: "Settings" },
];

interface Props {
  current: Screen;
  onNavigate: (s: Screen) => void;
}

export function Sidebar({ current, onNavigate }: Props) {
  const name = useStore((s) => s.name);

  return (
    <aside
      style={{
        width: "var(--sidebar-w)",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "rgba(25,24,22,0.72)",
        backdropFilter: "blur(24px) saturate(1.4)",
        WebkitBackdropFilter: "blur(24px) saturate(1.4)",
        borderRight: "1px solid var(--b1)",
      }}
    >
      {/* Nav */}
      <nav style={{ flex: 1, padding: "28px 8px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
        {NAV_ITEMS.map((item) => {
          const active = current === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                height: 36,
                padding: "0 14px",
                borderRadius: 2,
                fontSize: "var(--fs-sm)",
                lineHeight: 1,
                letterSpacing: "var(--ls-body)",
                fontWeight: active ? 500 : 400,
                color: active ? "rgb(var(--t1))" : "rgb(var(--t3))",
                background: active ? "rgba(255,255,255,0.04)" : "transparent",
                border: "none",
                cursor: "pointer",
                width: "100%",
                textAlign: "left",
                transition: "color 210ms ease, background 210ms ease",
              }}
              onMouseOver={(e) => {
                if (!active) {
                  e.currentTarget.style.color = "rgb(var(--t2))";
                  e.currentTarget.style.background = "rgba(255,255,255,0.02)";
                }
              }}
              onMouseOut={(e) => {
                if (!active) {
                  e.currentTarget.style.color = "rgb(var(--t3))";
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              {active && (
                <motion.div
                  layoutId="nav-indicator"
                  style={{
                    position: "absolute",
                    left: 0, top: 8, bottom: 8,
                    width: 1.5,
                    background: "rgb(var(--t1))",
                    borderRadius: "0 1px 1px 0",
                  }}
                  transition={{ duration: 0.21, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
              <span>{item.label}</span>
              {/* Arrow — visible only on active */}
              <span
                style={{
                  fontSize: 11,
                  opacity: active ? 0.4 : 0,
                  color: "rgb(var(--t1))",
                  transition: "opacity 210ms ease",
                }}
              >
                →
              </span>
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: "18px 20px",
          borderTop: "1px solid var(--b1)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 24, height: 24,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid var(--b2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span
            className="t-label"
            style={{ color: "rgb(var(--t2))", letterSpacing: "0.04em" }}
          >
            {name.slice(0, 2).toUpperCase() || "—"}
          </span>
        </div>
        <span
          className="t-meta"
          style={{ color: "rgb(var(--t2))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {name || "Trader"}
        </span>
        {/* Upgrade arrow */}
        <span
          style={{ marginLeft: "auto", color: "rgb(var(--t4))", fontSize: 12, cursor: "pointer", transition: "color 180ms ease" }}
          onMouseOver={(e) => (e.currentTarget.style.color = "rgb(var(--t2))")}
          onMouseOut={(e)  => (e.currentTarget.style.color = "rgb(var(--t4))")}
        >
          ↑
        </span>
      </div>
    </aside>
  );
}
