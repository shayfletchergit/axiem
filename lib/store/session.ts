import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AximStore, Session, Trade, Baseline } from "../types";

const DEFAULT_BASELINE: Baseline = {
  interval: 1800000, // 30 min
  size: 2,
  efdSamples: [],
  sciSamples: [],
};

interface StoreActions {
  setName: (name: string) => void;
  setSub: (sub: AximStore["sub"]) => void;
  setBaseline: (baseline: Partial<Baseline>) => void;
  setRules: (rules: string[]) => void;
  addRule: (rule: string) => void;
  removeRule: (idx: number) => void;
  setPauseThreshold: (v: number) => void;
  setPauseMinutes: (v: number) => void;
  startSession: (opts: { emotion?: string; intent?: string; readiness?: number }) => void;
  endSession: (reflection?: string) => void;
  logTrade: (trade: Omit<Trade, "id">) => void;
  reset: () => void;
}

const INITIAL: AximStore = {
  name: "",
  sub: "free",
  baseline: DEFAULT_BASELINE,
  rules: [],
  session: null,
  sessions: [],
  pauseThreshold: 40,
  pauseMinutes: 5,
};

export const useStore = create<AximStore & StoreActions>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      setName: (name) => set({ name }),
      setSub: (sub) => set({ sub }),
      setBaseline: (b) => set((s) => ({ baseline: { ...s.baseline, ...b } })),
      setRules: (rules) => set({ rules }),
      addRule: (rule) => set((s) => ({ rules: [...s.rules, rule] })),
      removeRule: (idx) => set((s) => ({ rules: s.rules.filter((_, i) => i !== idx) })),
      setPauseThreshold: (v) => set({ pauseThreshold: v }),
      setPauseMinutes: (v) => set({ pauseMinutes: v }),

      startSession: ({ emotion = "", intent = "", readiness } = {}) => {
        set({
          session: {
            startMs: Date.now(),
            trades: [],
            emotion,
            intent,
            readiness,
          },
        });
      },

      endSession: (reflection) => {
        const { session, sessions } = get();
        if (!session) return;
        const completed: Session = {
          ...session,
          endMs: Date.now(),
          reflection,
        };
        set({ sessions: [...sessions, completed], session: null });
      },

      logTrade: (trade) => {
        set((s) => {
          if (!s.session) return s;
          return {
            session: {
              ...s.session,
              trades: [...s.session.trades, { ...trade, id: Date.now() }],
            },
          };
        });
      },

      reset: () => set(INITIAL),
    }),
    {
      name: "axiem-v1",
      partialize: (s) => ({
        name: s.name,
        sub: s.sub,
        baseline: s.baseline,
        rules: s.rules,
        session: s.session,
        sessions: s.sessions,
        pauseThreshold: s.pauseThreshold,
        pauseMinutes: s.pauseMinutes,
      }),
    }
  )
);
