"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store/session";
import { useSignals } from "@/hooks/useSignals";
import { fmtDur } from "@/lib/engine";
import { createClient } from "@/lib/supabase/client";
import type { ConnectionState, TradovateEnv, Execution } from "@/lib/broker/types";

function Row({ label, sub, right }: { label: string; sub?: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 min-h-[48px] py-2"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <div className="flex-1">
        <div className="text-sm text-t1">{label}</div>
        {sub && <div className="text-2xs text-t3 mt-0.5">{sub}</div>}
      </div>
      <div>{right}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-2xs font-semibold tracking-[0.12em] uppercase text-t3 mt-9 mb-2.5 pb-2.5"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      {children}
    </div>
  );
}

function timeAgo(ts: string | number): string {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface TradovateProp {
  state: ConnectionState;
  recentFills?: Execution[];
  connect: (username: string, password: string, env: TradovateEnv) => Promise<boolean>;
  connectWithToken: (token: string, env: TradovateEnv) => Promise<void>;
  disconnect: () => void;
}

export function Settings({ onOpenSub, tradovate }: { onOpenSub: () => void; tradovate?: TradovateProp }) {
  const { name, sub, baseline, rules, pauseThreshold, pauseMinutes, session,
          setRules, addRule, removeRule, setPauseThreshold, setPauseMinutes, reset } = useStore();
  const { trades } = useSignals();
  const [newRule, setNewRule] = useState("");
  const r = trades.reduce((s, t) => s + t.r, 0);

  const fills = tradovate?.recentFills ?? [];
  const router = useRouter();
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.from("profiles").select("webhook_secret").eq("id", user.id).single()
        .then(({ data }) => { if (data) setWebhookSecret(data.webhook_secret); });
    });
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  function copySecret() {
    if (!webhookSecret) return;
    navigator.clipboard.writeText(webhookSecret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 2000);
  }

  const [tvUser, setTvUser] = useState("");
  const [tvPass, setTvPass] = useState("");
  const [tvToken, setTvToken] = useState("");
  const [tvEnv, setTvEnv] = useState<TradovateEnv>("demo");
  const [tvConnecting, setTvConnecting] = useState(false);
  const [tvMode, setTvMode] = useState<"login" | "token">("token");

  const tvStatus = tradovate?.state.status ?? "disconnected";
  const tvConnectedOrPolling = tvStatus === "connected" || tvStatus === "polling";

  async function handleConnect() {
    if (!tradovate) return;
    setTvConnecting(true);
    await tradovate.connect(tvUser, tvPass, tvEnv);
    setTvConnecting(false);
    if (tradovate.state.status === "connected") setTvPass("");
  }

  function handleConnectToken() {
    if (!tradovate || !tvToken.trim()) return;
    tradovate.connectWithToken(tvToken.trim(), tvEnv);
    setTvToken("");
  }

  return (
    <div className="overflow-y-auto h-full" style={{ scrollbarWidth: "none" }}>
      <div className="px-14 pt-12 pb-24 max-w-[660px]">
        <motion.h2 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}
          className="font-display text-t1 text-[30px] tracking-[-0.02em] mb-10">
          Settings
        </motion.h2>

        <div className="grid grid-cols-2 gap-x-16">
          <div>
            <SectionLabel>Profile</SectionLabel>
            <Row label="Name" right={<span className="text-xs text-t2">{name || "—"}</span>} />
            <Row label="Plan" right={
              <div className="flex items-center gap-2">
                <span className="text-xs text-t2">{sub === "pro" ? "Pro" : sub === "elite" ? "Elite" : "Free"}</span>
                {sub === "free" && (
                  <button onClick={onOpenSub} className="text-2xs font-medium px-2 py-0.5 rounded-[1px] transition-all"
                    style={{ background: "rgba(200,168,75,0.08)", color: "rgb(200 168 75)", border: "1px solid rgba(200,168,75,0.16)" }}>
                    Upgrade
                  </button>
                )}
              </div>
            } />

            <SectionLabel>The Pause</SectionLabel>
            <Row label="Trigger threshold" sub="Pause activates at or below this Form Score"
              right={
                <input type="number" min={20} max={60} defaultValue={pauseThreshold}
                  onChange={e => setPauseThreshold(+e.target.value)}
                  className="w-16 h-7 text-center text-xs text-t1 rounded-[2px] outline-none bg-s3 tabular-nums"
                  style={{ border: "1px solid rgba(255,255,255,0.07)" }} />
              } />
            <Row label="Duration (minutes)"
              right={
                <input type="number" min={1} max={15} defaultValue={pauseMinutes}
                  onChange={e => setPauseMinutes(+e.target.value)}
                  className="w-16 h-7 text-center text-xs text-t1 rounded-[2px] outline-none bg-s3 tabular-nums"
                  style={{ border: "1px solid rgba(255,255,255,0.07)" }} />
              } />

            <SectionLabel>Session</SectionLabel>
            <Row label="Net R this session" right={<span className={`text-xs tabular-nums font-medium ${r > 0 ? "text-[#2CC4A4]" : r < 0 ? "text-[#E8724A]" : "text-t2"}`}>{trades.length ? `${r >= 0 ? "+" : ""}${r.toFixed(1)}R` : "—"}</span>} />
            <Row label="Trades logged" right={<span className="text-xs text-t2 tabular-nums">{trades.length}</span>} />
            <div className="mt-4 space-y-2">
              <button onClick={() => { if (confirm("Reset all Axiem data? This cannot be undone.")) { reset(); location.reload(); } }}
                className="text-xs px-3 h-8 rounded-[2px] transition-all w-full text-center"
                style={{ border: "1px solid rgba(154,74,64,0.18)", color: "#E8724A", background: "transparent" }}>
                Reset all data
              </button>
              <button onClick={handleLogout}
                className="text-xs px-3 h-8 rounded-[2px] transition-all w-full text-center"
                style={{ border: "1px solid rgba(255,255,255,0.07)", color: "rgb(var(--t4))", background: "transparent" }}>
                Sign out
              </button>
            </div>
          </div>

          <div>
            <SectionLabel>Trading rules</SectionLabel>
            <div className="space-y-0">
              {rules.map((rule, i) => (
                <div key={i} className="flex items-center gap-3 py-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <span className="text-2xs text-t4 w-3.5">{i + 1}</span>
                  <span className="text-xs text-t1 flex-1 leading-relaxed">{rule}</span>
                  <button onClick={() => removeRule(i)} className="text-t4 hover:text-[#E8724A] transition-colors text-xs">×</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input value={newRule} onChange={e => setNewRule(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newRule.trim()) { addRule(newRule.trim()); setNewRule(""); } }}
                placeholder="Add a rule..."
                className="flex-1 h-8 px-2.5 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4"
                style={{ border: "1px solid rgba(255,255,255,0.07)" }} />
              <button onClick={() => { if (newRule.trim()) { addRule(newRule.trim()); setNewRule(""); } }}
                className="h-8 px-3 text-2xs font-medium rounded-[2px] transition-all"
                style={{ border: "1px solid rgba(255,255,255,0.07)", color: "rgb(136 132 128)" }}>
                Add
              </button>
            </div>

            <SectionLabel>Your webhook secret</SectionLabel>
            <div className="py-2 space-y-2">
              <p className="text-2xs text-t4 leading-relaxed">
                Paste this into the Axiem Bridge extension popup to connect your trades.
              </p>
              <div className="flex gap-2">
                <div className="flex-1 px-2.5 py-2 rounded-[2px] font-mono text-[10px] text-t2 select-all break-all"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  {webhookSecret ?? "Loading…"}
                </div>
                <button onClick={copySecret}
                  className="px-3 text-2xs rounded-[2px] shrink-0 transition-all"
                  style={{ border: "1px solid rgba(255,255,255,0.07)", color: secretCopied ? "#2CC4A4" : "rgb(var(--t3))" }}>
                  {secretCopied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>

            <SectionLabel>Baseline</SectionLabel>
            <Row label="Entry pace" right={<span className="text-xs text-t2">{Math.round(baseline.interval / 60000)}m</span>} />
            <Row label="Position size" right={<span className="text-xs text-t2">{baseline.size} contracts</span>} />

            <SectionLabel>Tradovate</SectionLabel>
            {tvConnectedOrPolling ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2.5 py-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#2CC4A4]" style={{ boxShadow: "0 0 6px rgba(44,196,164,0.7)" }} />
                  <div className="flex-1">
                    <div className="text-xs text-t1">
                      {tvStatus === "polling" ? "Polling" : "Connected"} · {tradovate?.state.env === "live" ? "Live" : "Demo"}
                    </div>
                    {tradovate?.state.accountName && (
                      <div className="text-2xs text-t3 mt-0.5">{tradovate.state.accountName}</div>
                    )}
                  </div>
                  <button
                    onClick={() => tradovate?.disconnect()}
                    className="text-2xs px-3 h-7 rounded-[2px] transition-all"
                    style={{ border: "1px solid rgba(255,255,255,0.07)", color: "rgb(var(--t3))" }}
                  >
                    Disconnect
                  </button>
                </div>
                <p className="text-2xs text-t4 leading-relaxed">
                  Trades are imported automatically when positions close. You'll be prompted to add emotion and R-multiple.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 py-1">
                {tvStatus === "error" && tradovate?.state.error && (
                  <div className="text-2xs text-[#E8724A] py-1.5 px-2.5 rounded-[2px]"
                    style={{ background: "rgba(232,114,74,0.08)", border: "1px solid rgba(232,114,74,0.15)" }}>
                    {tradovate.state.error}
                  </div>
                )}

                {/* Environment */}
                <div className="flex gap-1.5">
                  {(["demo", "live"] as TradovateEnv[]).map(env => (
                    <button key={env} onClick={() => setTvEnv(env)}
                      className="flex-1 h-7 text-2xs font-medium rounded-[2px] capitalize transition-all"
                      style={{
                        border: `1px solid ${tvEnv === env ? "rgba(44,196,164,0.35)" : "rgba(255,255,255,0.07)"}`,
                        background: tvEnv === env ? "rgba(44,196,164,0.08)" : "transparent",
                        color: tvEnv === env ? "#2CC4A4" : "rgb(var(--t3))",
                      }}
                    >{env}</button>
                  ))}
                </div>

                {/* Mode toggle */}
                <div className="flex gap-1.5 pt-0.5">
                  {(["token", "login"] as const).map(m => (
                    <button key={m} onClick={() => setTvMode(m)}
                      className="flex-1 h-7 text-2xs rounded-[2px] transition-all"
                      style={{
                        border: `1px solid ${tvMode === m ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.06)"}`,
                        background: tvMode === m ? "rgba(255,255,255,0.06)" : "transparent",
                        color: tvMode === m ? "rgb(var(--t1))" : "rgb(var(--t4))",
                      }}
                    >{m === "token" ? "Paste token" : "Sign in"}</button>
                  ))}
                </div>

                {tvMode === "token" ? (
                  <>
                    <div className="text-2xs leading-relaxed pt-0.5" style={{ color: "rgb(var(--t4))" }}>
                      <p className="mb-1.5">Get your token from the Tradovate web app:</p>
                      <ol className="space-y-1 list-decimal list-inside">
                        <li>Open <span style={{ color: "rgb(var(--t2))" }}>trader.tradovate.com</span> and log in</li>
                        <li>Open DevTools — <span style={{ color: "rgb(var(--t2))" }}>F12</span> (Windows) or <span style={{ color: "rgb(var(--t2))" }}>Cmd+Option+I</span> (Mac)</li>
                        <li>Click the <span style={{ color: "rgb(var(--t2))" }}>Console</span> tab</li>
                        <li>Paste this and press Enter:</li>
                      </ol>
                      <div className="mt-2 mb-1.5 px-2.5 py-2 rounded-[2px] font-mono select-all"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "rgb(var(--t2))", fontSize: 10, lineHeight: 1.5 }}>
                        {`copy(Object.entries(localStorage).find(([k])=>k.toLowerCase().includes('access'))?.[1])`}
                      </div>
                      <li className="list-none">5. The token is now in your clipboard — paste it below</li>
                    </div>
                    <textarea
                      value={tvToken} onChange={e => setTvToken(e.target.value)} rows={3}
                      placeholder="Paste access token here…"
                      className="w-full py-2 px-2.5 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4 resize-none font-mono"
                      style={{ border: "1px solid rgba(255,255,255,0.07)", fontSize: 10 }}
                    />
                    <button
                      onClick={handleConnectToken}
                      disabled={!tvToken.trim()}
                      className="w-full h-8 text-xs font-medium rounded-[2px] transition-all disabled:opacity-40"
                      style={{ background: "rgba(232,228,220,0.92)", color: "rgb(25,24,22)", border: "none" }}
                    >
                      Connect with token
                    </button>
                    <p className="text-2xs pt-0.5" style={{ color: "rgb(var(--t4))" }}>
                      Token expires after a few hours — reconnect when polling stops working.
                    </p>
                  </>
                ) : (
                  <>
                    <input
                      type="text" value={tvUser} onChange={e => setTvUser(e.target.value)}
                      placeholder="Username"
                      autoComplete="username"
                      className="w-full h-8 px-2.5 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4"
                      style={{ border: "1px solid rgba(255,255,255,0.07)" }}
                    />
                    <input
                      type="password" value={tvPass} onChange={e => setTvPass(e.target.value)}
                      placeholder="Password"
                      autoComplete="current-password"
                      onKeyDown={e => { if (e.key === "Enter" && tvUser && tvPass) handleConnect(); }}
                      className="w-full h-8 px-2.5 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4"
                      style={{ border: "1px solid rgba(255,255,255,0.07)" }}
                    />
                    <button
                      onClick={handleConnect}
                      disabled={!tvUser || !tvPass || tvConnecting}
                      className="w-full h-8 text-xs font-medium rounded-[2px] transition-all disabled:opacity-40"
                      style={{ background: "rgba(232,228,220,0.92)", color: "rgb(25,24,22)", border: "none" }}
                    >
                      {tvConnecting ? "Connecting…" : "Connect Tradovate"}
                    </button>
                    <p className="text-2xs pt-0.5" style={{ color: "rgb(var(--t4))" }}>
                      Requires registered Tradovate API credentials.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Broker fill feed ── */}
        <div className="mt-10">
          <div className="text-2xs font-semibold tracking-[0.12em] uppercase text-t3 mb-3 pb-2.5"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            Broker feed
            {fills.length > 0 && (
              <span className="ml-2 font-normal normal-case tracking-normal text-t4">
                · {fills.length} fill{fills.length !== 1 ? "s" : ""} received
              </span>
            )}
          </div>

          {fills.length === 0 ? (
            <div className="flex items-center gap-3 py-4">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: "rgba(255,255,255,0.12)" }} />
              <span className="text-xs text-t4">No fills yet — place a trade in Tradovate to confirm the connection.</span>
            </div>
          ) : (
            <div className="space-y-0">
              <div className="grid text-2xs text-t4 pb-1.5 mb-1"
                style={{ gridTemplateColumns: "80px 1fr 60px 90px 80px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <span>Time</span><span>Symbol</span><span>Side</span><span>Qty · Price</span><span className="text-right">ID</span>
              </div>
              {fills.map((f, i) => (
                <motion.div
                  key={f.brokerExecId}
                  initial={i === 0 ? { opacity: 0, backgroundColor: "rgba(44,196,164,0.08)" } : false}
                  animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                  transition={{ duration: 1.2 }}
                  className="grid items-center py-2 text-xs"
                  style={{
                    gridTemplateColumns: "80px 1fr 60px 90px 80px",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                  }}
                >
                  <span className="text-2xs text-t4 tabular-nums">{timeAgo(f.timestamp)}</span>
                  <span className="text-t2 font-mono text-[11px]">{f.symbol}</span>
                  <span className="font-medium text-[11px]"
                    style={{ color: f.side === "buy" ? "#2CC4A4" : "#E8724A" }}>
                    {f.side.toUpperCase()}
                  </span>
                  <span className="text-t2 tabular-nums text-[11px]">
                    {f.qty} @ {f.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-t4 text-[10px] text-right tabular-nums">{f.brokerExecId}</span>
                </motion.div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
