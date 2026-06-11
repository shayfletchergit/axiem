export interface RuleCheck {
  text: string;
  broken: boolean;
}

export interface Trade {
  id: number;
  entryMs: number;
  exitMs: number;
  r: number;
  size: number;
  setup: string;
  emotion: string;
  rules: RuleCheck[];
  notes: string;
}

export interface Session {
  startMs: number;
  endMs?: number;
  trades: Trade[];
  emotion?: string;
  intent?: string;
  reflection?: string;
  readiness?: number;
  finalBSS?: number | null;
}

export interface Baseline {
  interval: number;   // ms between entries
  size: number;       // contracts
  efdSamples: number[];
  sciSamples: number[];
}

export interface AximStore {
  name: string;
  sub: "free" | "pro" | "elite";
  baseline: Baseline;
  rules: string[];
  session: Session | null;
  sessions: Session[];
  pauseThreshold: number;
  pauseMinutes: number;
  partnerName?: string;
  partnerEmail?: string;
  brokers?: string[];
}

export type SignalState = "ok" | "warning" | "critical" | "insufficient";

export interface EFDResult {
  state: SignalState;
  rawMins: number | null;
  score: number;
}

export interface PLBResult {
  state: SignalState;
  score: number;
}

export interface SCIResult {
  state: SignalState;
  label: string;
  rawValue: number | null;
}

export interface BSSResult {
  score: number | null;
  state: SignalState;
}

export interface Signals {
  efd: EFDResult;
  plb: PLBResult;
  sci: SCIResult;
  bss: BSSResult;
  trades: Trade[];
}

export type Screen = "overview" | "behaviour" | "history" | "settings";
export type AppPhase = "onboarding" | "presession" | "session";
