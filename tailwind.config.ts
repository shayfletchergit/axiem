import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Axiem surface system
        bg:   "rgb(var(--bg) / <alpha-value>)",
        s1:   "rgb(var(--s1) / <alpha-value>)",
        s2:   "rgb(var(--s2) / <alpha-value>)",
        s3:   "rgb(var(--s3) / <alpha-value>)",
        s4:   "rgb(var(--s4) / <alpha-value>)",
        // Text
        t1:   "rgb(var(--t1) / <alpha-value>)",
        t2:   "rgb(var(--t2) / <alpha-value>)",
        t3:   "rgb(var(--t3) / <alpha-value>)",
        t4:   "rgb(var(--t4) / <alpha-value>)",
        // Brand
        gold:     "rgb(var(--gold) / <alpha-value>)",
        "gold-t": "rgb(var(--gold-t) / <alpha-value>)",
        // Signal palette
        "sig-orange": "#E8724A",
        "sig-teal":   "#2CC4A4",
        "sig-purple": "#7B7FD4",
        // State
        "state-pos":  "#2CC4A4",
        "state-warn": "#D4A84B",
        "state-neg":  "#E8724A",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans:    ["var(--font-sans)",    "system-ui", "sans-serif"],
      },
      spacing: {
        // 8px base grid
        "18": "4.5rem",   // 72px
        "22": "5.5rem",   // 88px
        "26": "6.5rem",   // 104px
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "1rem", letterSpacing: "0.08em" }],
        xs:    ["0.75rem",  { lineHeight: "1rem" }],
        sm:    ["0.8125rem",{ lineHeight: "1.25rem" }],
        base:  ["0.875rem", { lineHeight: "1.5rem" }],
      },
      animation: {
        "fade-in":  "fade-in 210ms ease-out both",
        "fade-up":  "fade-up 240ms ease-out both",
        "hud-pulse":"hud-pulse 2.8s ease-in-out infinite",
      },
      keyframes: {
        "fade-in":  { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-up":  { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "none" } },
        "hud-pulse":{ "0%,100%": { opacity: "0.12", r: "7" }, "50%": { opacity: "0", r: "11" } },
      },
      transitionTimingFunction: {
        "out-soft":  "cubic-bezier(0.16, 1, 0.3, 1)",
        "in-out-soft": "cubic-bezier(0.25, 0.1, 0.25, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
