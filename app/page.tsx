"use client";

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "@/lib/store/session";
import { useSignals } from "@/hooks/useSignals";
import { useInterfaceState } from "@/hooks/useInterfaceState";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { OverviewLive } from "@/components/screens/OverviewLive";
import { Behaviour } from "@/components/screens/Behaviour";
import { SessionsLive } from "@/components/screens/SessionsLive";
import { Settings } from "@/components/screens/Settings";
import { PauseOverlay } from "@/components/overlays/PauseOverlay";
import { LogTradeSheet } from "@/components/overlays/LogTradeSheet";
import { AutoTradePrompt } from "@/components/overlays/AutoTradePrompt";
import type { Screen, AppPhase } from "@/lib/types";
import { calcEFD, calcPLB, calcSCI, calcBSS } from "@/lib/engine";
import { usePushNotification } from "@/hooks/usePushNotification";
import { useConnectionManager } from "@/hooks/useConnectionManager";
import type { BrokerTrade } from "@/lib/broker/types";

// ── Demo data ──
function loadDemo(store: any) {
  const base = Date.now() - 3 * 3600000;
  const mk = (mIn: number, dur: number, r: number, sz: number, em: string, setup: string, broken: number[] = []) => ({
    entryMs: base + mIn * 60000, exitMs: base + (mIn + dur) * 60000,
    r, size: sz, emotion: em, setup,
    rules: ["Only A-grade setups","Pause 5m after a loss","Never increase size after a loss"].map((text, i) => ({ text, broken: broken.includes(i) })),
    notes: "",
  });
  store.setName("Shay");
  store.setBaseline({ interval: 1080000, size: 2 }); // 18m
  store.setRules(["Only A-grade setups","Pause 5m after a loss","Never increase size after a loss"]);
  store.startSession({ emotion: "focused", intent: "Trend continuation setups only.", readiness: 72 });
  [mk(15,22,1.5,2,"focused","Trend cont."),mk(52,18,0.8,2,"focused","Breakout"),mk(78,14,-0.8,2,"confident","Trend cont."),
   mk(84,9,-1.2,3,"elevated","Reversal",[1,2]),mk(96,12,-0.5,3,"elevated","Range fade",[0,2]),
   mk(122,20,1.0,2,"clear","Trend cont."),mk(158,25,2.0,2,"focused","Breakout"),mk(195,16,-0.6,2,"fatigued","Reversal",[0])
  ].forEach(t => store.logTrade(t));
}

// ── Session control screen ──
function PreSession({ onStart }: { onStart: () => void }) {
  const store = useStore();
  const [emotion, setEmotion] = useState("");
  const [intent, setIntent] = useState("");
  const [sleep, setSleep] = useState(5);
  const [focus, setFocus] = useState(5);
  const readiness = Math.round((sleep + focus + 5 + 5) / 4 * 10);

  const now = new Date();
  const h = now.getHours();
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: "rgb(25,24,22)" }}>
      <div className="w-full max-w-[360px] rounded-lg overflow-hidden" style={{ background: "rgba(29,27,25,0.9)", border: "1px solid rgba(255,255,255,0.08)" }}>
        <div className="px-6 py-5" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-2xs font-semibold tracking-[0.12em] uppercase text-t3 mb-1.5">
            {days[now.getDay()]}, {now.getDate()} {months[now.getMonth()]}
          </div>
          <div className="font-display text-t1 text-[18px] tracking-[-0.02em]">
            Good {h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}{store.name ? `, ${store.name}` : ""}.
          </div>
        </div>
        <div className="px-6 py-5 space-y-5">
          <div>
            <div className="text-2xs font-semibold tracking-[0.10em] uppercase text-t3 mb-2.5">How are you arriving today?</div>
            <div className="grid grid-cols-5 gap-1.5">
              {["Clear","Focused","Confident","Elevated","Tired"].map(s => (
                <button key={s} onClick={() => setEmotion(s.toLowerCase())}
                  className="py-1.5 text-[10px] rounded-[2px] transition-all"
                  style={{ border: `1px solid ${emotion === s.toLowerCase() ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.07)"}`, color: emotion === s.toLowerCase() ? "rgb(232 228 220)" : "rgb(80 78 74)", background: emotion === s.toLowerCase() ? "rgba(255,255,255,0.04)" : "transparent" }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-2xs font-semibold tracking-[0.10em] uppercase text-t3 mb-2.5">Readiness check <span className="text-t4 font-normal normal-case tracking-normal">· {readiness}/100</span></div>
            <div className="grid grid-cols-2 gap-3">
              {([["Sleep", sleep as number, setSleep as Function], ["Focus", focus as number, setFocus as Function]] as const).map(([lbl, val, set]) => (
                <div key={String(lbl)}>
                  <div className="flex justify-between text-2xs text-t3 mb-1.5"><span>{String(lbl)}</span><span>{val}</span></div>
                  <input type="range" min={1} max={10} value={Number(val)} onChange={e => (set as Function)(+e.target.value)}
                    className="w-full h-0.5 appearance-none rounded-full cursor-pointer"
                    style={{ background: "rgba(255,255,255,0.08)", accentColor: "#C8A84B" }} />
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-2xs font-semibold tracking-[0.10em] uppercase text-t3 mb-1.5">Intention — optional</div>
            <textarea value={intent} onChange={e => setIntent(e.target.value)} rows={2}
              placeholder="What are you focused on today?"
              className="w-full text-xs text-t1 placeholder:text-t4 resize-none outline-none rounded-[2px] px-2.5 py-2 bg-s3"
              style={{ border: "1px solid rgba(255,255,255,0.07)" }} />
          </div>
        </div>
        <div className="flex items-center justify-between px-6 py-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-2xs text-t4">{readiness}/100 readiness</div>
          <button onClick={() => { store.startSession({ emotion, intent, readiness }); onStart(); }}
            className="h-9 px-4 text-xs font-medium rounded-[2px]"
            style={{ background: "rgba(232,228,220,0.92)", color: "rgb(25,24,22)" }}>
            Begin session
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Onboarding ──
function Onboarding({ onDone }: { onDone: () => void }) {
  const store = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [interval, setInterval] = useState(1800000);
  const [size, setSize] = useState(2);
  const steps = ["Who are you?", "Entry pace", "Position size", "Trading rules"];
  const [ruleInput, setRuleInput] = useState("");
  const [rules, setRules] = useState<string[]>([]);

  const next = () => {
    if (step === 0) { if (!name.trim()) return; store.setName(name.trim()); }
    if (step === 1) store.setBaseline({ interval });
    if (step === 2) store.setBaseline({ size });
    if (step === 3) { store.setRules(rules); onDone(); return; }
    setStep(s => s + 1);
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: "rgb(25,24,22)" }}>
      <div className="font-display text-t1 text-[22px] mb-1.5">Axiem</div>
      <div className="text-xs text-t3 mb-8 text-center max-w-[280px] leading-relaxed">A pause-first system for serious discretionary traders</div>
      <div className="w-full max-w-[340px] rounded-lg overflow-hidden" style={{ background: "rgba(29,27,25,0.92)", border: "1px solid rgba(255,255,255,0.08)" }}>
        <div className="px-6 pt-5 pb-0">
          <div className="flex gap-1 mb-0">
            {steps.map((_, i) => (
              <div key={i} className="flex-1 h-[1.5px] rounded-full transition-all duration-300"
                style={{ background: i < step ? "#2CC4A4" : i === step ? "rgb(136 132 128)" : "rgba(255,255,255,0.08)" }} />
            ))}
          </div>
        </div>
        <div className="px-6 py-5">
          <div className="font-display text-t1 text-[17px] mb-1.5">{steps[step]}</div>
          <div className="text-xs text-t2 leading-relaxed mb-4">
            {["Axiem works best for funded or near-funded prop traders with real stakes.",
              "When your gap compresses significantly, Axiem treats it as a risk signal.",
              "Sizing deviation is among the earliest signals of emotional drift.",
              "Axiem surfaces these during the Pause when relevant."][step]}
          </div>
          {step === 0 && <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" autoFocus
            onKeyDown={e => e.key === "Enter" && next()}
            className="w-full h-[34px] px-2.5 text-xs text-t1 placeholder:text-t4 rounded-[2px] outline-none bg-s3"
            style={{ border: "1px solid rgba(255,255,255,0.07)" }} />}
          {step === 1 && <div className="grid grid-cols-2 gap-1.5">
            {[[300,"<5m"],[900,"5–15m"],[1800000/60000*60000,"15–30m"],[3600000,"30–60m"],[7200000,"1–2h"],[14400000,"2h+"]].map(([v, l]) => (
              <button key={Number(v)} onClick={() => setInterval(Number(v))}
                className="py-2 text-xs rounded-[2px] transition-all"
                style={{ border: `1px solid ${interval === v ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)"}`, color: interval === v ? "rgb(232 228 220)" : "rgb(80 78 74)", background: interval === v ? "rgba(255,255,255,0.04)" : "transparent" }}>
                {String(l)}
              </button>
            ))}
          </div>}
          {step === 2 && <div className="grid grid-cols-3 gap-1.5">
            {[1,2,5,10,20,50].map(v => (
              <button key={v} onClick={() => setSize(v)}
                className="py-2 text-xs rounded-[2px] transition-all"
                style={{ border: `1px solid ${size === v ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.07)"}`, color: size === v ? "rgb(232 228 220)" : "rgb(80 78 74)", background: size === v ? "rgba(255,255,255,0.04)" : "transparent" }}>
                {v}
              </button>
            ))}
          </div>}
          {step === 3 && <>
            <div className="space-y-1.5 mb-2">
              {rules.map((r, i) => <div key={i} className="flex items-center gap-2 text-xs text-t1">
                <span className="text-t4 text-[10px] w-3">{i+1}</span><span className="flex-1">{r}</span>
                <button onClick={() => setRules(rs => rs.filter((_,j) => j !== i))} className="text-t4 hover:text-[#E8724A] transition-colors">×</button>
              </div>)}
            </div>
            <div className="flex gap-1.5">
              <input value={ruleInput} onChange={e => setRuleInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && ruleInput.trim()) { setRules(r => [...r, ruleInput.trim()]); setRuleInput(""); }}}
                placeholder="e.g. Only A-grade setups"
                className="flex-1 h-[34px] px-2.5 text-xs text-t1 placeholder:text-t4 rounded-[2px] outline-none bg-s3"
                style={{ border: "1px solid rgba(255,255,255,0.07)" }} />
              <button onClick={() => { if (ruleInput.trim()) { setRules(r => [...r, ruleInput.trim()]); setRuleInput(""); }}}
                className="h-[34px] px-3 text-xs text-t3 rounded-[2px]" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>+</button>
            </div>
          </>}
        </div>
        <div className="flex gap-2 px-6 py-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {step > 0 && <button onClick={() => setStep(s => s - 1)} className="h-8 px-3 text-xs text-t3 rounded-[2px]" style={{ border: "1px solid rgba(255,255,255,0.07)" }}>Back</button>}
          <button onClick={next} className="flex-1 h-8 text-xs font-medium rounded-[2px]"
            style={{ background: "rgba(232,228,220,0.92)", color: "rgb(25,24,22)" }}>
            {step === 3 ? "Launch Axiem" : "Continue"}
          </button>
        </div>
      </div>
      <button onClick={() => { loadDemo(useStore.getState()); onDone(); }}
        className="mt-5 text-xs text-t4 underline underline-offset-2 hover:text-t3 transition-colors">
        Load sample data instead
      </button>
    </div>
  );
}

// ── Root app ──
export default function App() {
  const store = useStore();
  const signals = useSignals();
  const [screen, setScreen] = useState<Screen>("overview");
  const [phase, setPhase] = useState<AppPhase>("onboarding");
  const [logOpen, setLogOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [lastPauseMs, setLastPauseMs] = useState(0);
  const [tradeCancelledUntil, setTradeCancelledUntil] = useState(0);
  const [toast, setToast] = useState("");
  const [pendingTvTrade, setPendingTvTrade] = useState<BrokerTrade | null>(null);

  const { requestAndSubscribe, sendPauseNotification } = usePushNotification();
  const {
    state: tvState,
    recentFills: tvFills,
    connectWithCredentials: tvConnect,
    connectWithToken: tvConnectWithToken,
    disconnect: tvDisconnect,
  } = useConnectionManager({
    onTradeClosed: (event) => setPendingTvTrade(event.trade),
  });

  useInterfaceState();

  // Request push permission once user is in a session
  useEffect(() => {
    if (phase === "session") requestAndSubscribe();
  }, [phase, requestAndSubscribe]);

  useEffect(() => {
    if (store.name) setPhase(store.session ? "session" : "presession");
    else setPhase("onboarding");
  }, [store.name, store.session]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  // Auto-pause trigger
  useEffect(() => {
    const { bss, trades } = signals;
    if (phase !== "session" || pauseOpen) return;
    if (bss.score !== null && bss.score <= store.pauseThreshold && trades.length >= 2) {
      const now = Date.now();
      if (now - lastPauseMs > 1800000) {
        setLastPauseMs(now);
        setPauseOpen(true);
        sendPauseNotification(pauseInsight);
      }
    }
  }, [signals, store.pauseThreshold, phase, pauseOpen, lastPauseMs, sendPauseNotification]);

  const pauseInsight = (() => {
    const { efd, plb, bss } = signals;
    const prevLowSessions = store.sessions.filter(s => {
      const bl = store.baseline;
      const b = calcBSS(calcEFD(s.trades, bl), calcPLB(s.trades), calcSCI(s.trades, bl));
      return b.score !== null && b.score <= store.pauseThreshold;
    }).length;
    if (efd.state === "critical") return `Entry gap at ${efd.rawMins}m — significantly below your baseline. This pattern appeared in ${prevLowSessions > 0 ? prevLowSessions : "previous"} session${prevLowSessions !== 1 ? "s" : ""} before a deterioration.`;
    if (plb.state === "critical") return `You're re-entering quickly after losses. Across your ${store.sessions.length} recorded sessions, this pattern preceded your largest drawdowns.`;
    return `Form score at ${bss.score}. Multiple signals are outside your baseline simultaneously${prevLowSessions > 0 ? ` — this has happened in ${prevLowSessions} of your previous sessions` : ""}.`;
  })();

  const pausePattern = (() => {
    const count = store.sessions.filter(s => {
      const bl = store.baseline;
      const b = calcBSS(calcEFD(s.trades, bl), calcPLB(s.trades), calcSCI(s.trades, bl));
      return b.score !== null && b.score <= store.pauseThreshold;
    }).length;
    if (count === 0) return "This is the first time your signals have reached this level. Treat it as a signal worth respecting.";
    return `This combination has appeared in ${count} of your previous ${store.sessions.length} session${store.sessions.length !== 1 ? "s" : ""}. In those sessions, continuing past this point increased average drawdown.`;
  })();

  const questions = [
    "\"What are you seeing that makes this trade A-grade right now?\"",
    "\"Is your edge present, or are you manufacturing a trade?\"",
    "\"What would you tell a student trader about to make this decision?\"",
  ];
  const pauseQuestion = questions[(store.session?.trades.length ?? 0) % 3];

  const screenComponents: Record<Screen, React.ReactNode> = {
    overview:  <OverviewLive />,
    behaviour: <Behaviour />,
    history:   <SessionsLive />,
    settings:  <Settings onOpenSub={() => {}} tradovate={{ state: tvState, recentFills: tvFills, connect: tvConnect, connectWithToken: tvConnectWithToken, disconnect: tvDisconnect }} />,
  };

  if (phase === "onboarding") return <Onboarding onDone={() => setPhase("presession")} />;
  if (phase === "presession") return <PreSession onStart={() => setPhase("session")} />;

  return (
    <>
      {/* App shell */}
      <div className="fixed inset-0 flex flex-col">
<TopBar onLogTrade={() => setLogOpen(true)} onEndSession={() => {
          if (confirm("End session and reflect?")) { store.endSession(); setPhase("presession"); }
        }} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar current={screen} onNavigate={setScreen} />
          <main className="flex-1 min-w-0 overflow-hidden relative">
            <AnimatePresence mode="wait">
              <motion.div key={screen} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.21, ease: "easeInOut" }} className="absolute inset-0">
                {screenComponents[screen]}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>

      {/* Overlays */}
      <AutoTradePrompt trade={pendingTvTrade} onClose={() => setPendingTvTrade(null)} />
      <LogTradeSheet
        open={logOpen && Date.now() > tradeCancelledUntil}
        onClose={() => setLogOpen(false)}
      />
      <PauseOverlay
        open={pauseOpen}
        insight={pauseInsight}
        pattern={pausePattern}
        question={pauseQuestion}
        durationSecs={store.pauseMinutes * 60}
        onDismiss={(d) => {
          setPauseOpen(false);
          if (d === "cancel") {
            setTradeCancelledUntil(Date.now() + 5 * 60 * 1000);
            showToast("Trade cancelled — next entry blocked for 5 minutes.");
          } else if (d === "proceed") {
            showToast("Proceeding with full awareness. Stay disciplined.");
          }
        }}
      />

      {/* Toast */}
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          style={{
            position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
            zIndex: 9999, background: "rgba(39,37,34,0.97)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 4, padding: "10px 20px", fontSize: 12, color: "rgb(var(--t2))",
            backdropFilter: "blur(12px)", whiteSpace: "nowrap",
          }}
        >
          {toast}
        </motion.div>
      )}

      <style>{`
        @keyframes livepulse {
          0%,100% { opacity:1; box-shadow: 0 0 0 0 rgba(44,196,164,0.3); }
          50% { opacity:0.5; box-shadow: 0 0 0 4px rgba(44,196,164,0); }
        }
        select option { background: rgb(39,37,34); color: rgb(232,228,220); }
      `}</style>
    </>
  );
}
