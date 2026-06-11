"use client";

import { useClock } from "@/hooks/useClock";
import { useStore } from "@/lib/store/session";
import { fmtDur } from "@/lib/engine";

interface Props {
  onLogTrade: () => void;
  onEndSession: () => void;
}

export function TopBar({ onLogTrade, onEndSession }: Props) {
  const now     = useClock();
  const name    = useStore((s) => s.name);
  const session = useStore((s) => s.session);

  const h = now.getHours();
  const greeting = `Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"},\u00A0${name || "trader"}.`;

  const days   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dateStr = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]}`;
  const timeStr = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;

  return (
    <header
      className="flex-shrink-0"
      style={{
        height: 80,
        display: "grid",
        gridTemplateColumns: "var(--sidebar-w) 1fr auto",
        alignItems: "center",
        background: "rgba(25,24,22,0.85)",
        backdropFilter: "blur(20px) saturate(1.3)",
        WebkitBackdropFilter: "blur(20px) saturate(1.3)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {/* Wordmark — TREVAREFABRIKKEN reference: small, very spaced, uppercase */}
      <div
        className="t-label"
        style={{ padding: "0 32px", color: "rgb(var(--t1))", letterSpacing: "0.14em" }}
      >
        Axiem
      </div>

      {/* Greeting — the centrepiece. Large, tight, regular weight. */}
      <div style={{ padding: "0 40px 0 0", overflow: "hidden" }}>
        <h1
          className="t-tab"
          style={{
            fontSize: "clamp(22px, 3.2vw, 48px)",
            lineHeight: 0.97,
            letterSpacing: "-0.03em",
            fontWeight: 400,
            color: "rgb(var(--t1))",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {greeting}
        </h1>
      </div>

      {/* Right — datetime + controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "0 32px",
        }}
      >
        {session && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 5, height: 5, borderRadius: "50%",
                  background: "#2CC4A4",
                  animation: "livepulse 2.4s ease infinite",
                  boxShadow: "0 0 8px 2px rgba(44,196,164,0.22)",
                  flexShrink: 0,
                }}
              />
              <span className="t-meta t-tab" style={{ color: "rgb(var(--t3))" }}>
                {fmtDur(Date.now() - session.startMs)}
              </span>
            </div>
            <button
              onClick={onEndSession}
              className="t-label-sm"
              style={{
                height: 28,
                padding: "0 12px",
                borderRadius: 2,
                border: "1px solid rgba(154,74,64,0.2)",
                color: "#E8724A",
                background: "transparent",
                cursor: "pointer",
                transition: "background 180ms ease",
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = "rgba(232,114,74,0.07)")}
              onMouseOut={(e)  => (e.currentTarget.style.background = "transparent")}
            >
              End session
            </button>
          </div>
        )}

        <div style={{ textAlign: "right" }}>
          <div className="t-label" style={{ color: "rgb(var(--t3))", marginBottom: 2 }}>
            {dateStr}
          </div>
          <div className="t-meta t-tab" style={{ color: "rgb(var(--t3))" }}>
            {timeStr}
          </div>
        </div>

        <button
          onClick={onLogTrade}
          className="t-label-sm"
          style={{
            height: 28,
            padding: "0 14px",
            borderRadius: 2,
            border: "1px solid var(--b3)",
            color: "rgb(var(--t1))",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 5,
            transition: "background 180ms ease",
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
          onMouseOut={(e)  => (e.currentTarget.style.background = "transparent")}
        >
          ↑ Log trade
        </button>
      </div>
    </header>
  );
}
