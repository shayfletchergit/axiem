/**
 * lib/sessions/segment.test.ts
 *
 * Phase 0 — session segmentation tests.
 *
 * Plain assertions, no test framework (matches reducer.test.ts).
 * Run with:  npx tsx lib/sessions/segment.test.ts
 *
 * Coverage
 * ────────
 *   S1   Trades within G collapse into one session
 *   S2   Idle gap ≥ G splits into two sessions
 *   S3   Determinism: shuffled input → identical output
 *   S4   Out-of-order input is sorted internally
 *   S5   Open trade (closed_at null) → status "open", absorbs later trades
 *   S6   Multi-instrument overlap: flat = ALL instruments flat (no false split)
 *   S7   Eligibility threshold (≥ 4 trades)
 *   S8   provisional vs closed depends on `now`
 *   S9   Long closed trade spanning a gap is not split; gap measured from its close
 *   S10  Per-account isolation
 *   S11  Zero trades → []
 *   S12  CME day-boundary (17:00 CT) split even when gap < G
 *   S13  Every trade belongs to exactly one session
 */

import { buildSessions } from "./segment";
import type { SessionTrade } from "./types";

// ── harness ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓  ${msg}`); passed++; }
  else      { console.error(`  ✗  ${msg}`); failed++; }
}
function run(name: string, fn: () => void): void { console.log(`\n── ${name}`); fn(); }

const USER = "11111111-1111-1111-1111-111111111111";
const MIN = 60_000;

let _n = 0;
function trade(opts: {
  open: string;
  close: string | null;
  account?: string;
  instrument?: string;
  size?: number;
  pnl?: number | null;
  dir?: "long" | "short";
  status?: "ok" | "skipped";
  id?: string;
}): SessionTrade {
  _n += 1;
  return {
    id:                    opts.id ?? `t-${String(_n).padStart(4, "0")}`,
    account_id:            opts.account ?? "ACC-A",
    instrument:            opts.instrument ?? "ES",
    opened_at:             opts.open,
    closed_at:             opts.close,
    max_size:              opts.size ?? 1,
    net_pnl:               opts.pnl ?? 0,
    direction:             opts.dir ?? "long",
    reconstruction_status: opts.status ?? "ok",
  };
}

/** ISO helper: a base day at 14:00 UTC (mid US session) + minute offset. */
function t(min: number): string {
  return new Date(Date.UTC(2025, 5, 3, 14, 0, 0) + min * MIN).toISOString();
}

// ── S1 ───────────────────────────────────────────────────────────────────────
run("S1 trades within G collapse into one session", () => {
  const trades = [
    trade({ open: t(0),  close: t(5) }),
    trade({ open: t(20), close: t(25) }),
    trade({ open: t(50), close: t(55) }),
  ];
  const s = buildSessions(USER, trades, { now: Date.parse(t(10000)) });
  assert(s.length === 1, "one session");
  assert(s[0].trade_count === 3, "3 trades in session");
  assert(s[0].status === "closed", "closed (now ≫ end + G)");
});

// ── S2 ───────────────────────────────────────────────────────────────────────
run("S2 idle gap ≥ G splits sessions", () => {
  const trades = [
    trade({ open: t(0),   close: t(5) }),
    trade({ open: t(10),  close: t(15) }),
    // gap from frontier(15) to 100 = 85 min ≥ 75 → split
    trade({ open: t(100), close: t(105) }),
    trade({ open: t(120), close: t(125) }),
  ];
  const s = buildSessions(USER, trades, { now: Date.parse(t(10000)) });
  assert(s.length === 2, "two sessions");
  assert(s[0].trade_count === 2 && s[1].trade_count === 2, "2 + 2 split");
});

// ── S3 ───────────────────────────────────────────────────────────────────────
run("S3 determinism under shuffle", () => {
  const base = [
    trade({ open: t(0),   close: t(5),   id: "a" }),
    trade({ open: t(10),  close: t(15),  id: "b" }),
    trade({ open: t(100), close: t(105), id: "c" }),
    trade({ open: t(120), close: t(130), id: "d" }),
  ];
  const shuffled = [base[2], base[0], base[3], base[1]];
  const now = Date.parse(t(10000));
  const a = buildSessions(USER, base, { now });
  const b = buildSessions(USER, shuffled, { now });
  assert(JSON.stringify(a) === JSON.stringify(b), "identical output regardless of input order");
  assert(a[0].session_id === b[0].session_id, "stable deterministic session_id");
});

// ── S4 ───────────────────────────────────────────────────────────────────────
run("S4 out-of-order input sorted internally", () => {
  const trades = [
    trade({ open: t(50), close: t(55), id: "late" }),
    trade({ open: t(0),  close: t(5),  id: "early" }),
  ];
  const s = buildSessions(USER, trades, { now: Date.parse(t(10000)) });
  assert(s.length === 1, "one session");
  assert(s[0].first_trade_id === "early", "first trade is the earliest opened_at");
  assert(s[0].last_trade_id === "late", "last trade is the latest opened_at");
});

// ── S5 ───────────────────────────────────────────────────────────────────────
run("S5 open trade keeps session open and absorbs later trades", () => {
  const trades = [
    trade({ open: t(0),   close: t(5) }),
    trade({ open: t(10),  close: null }),         // open position
    // even a 200-min later trade cannot split: account never went flat
    trade({ open: t(210), close: t(215) }),
  ];
  const s = buildSessions(USER, trades, { now: Date.parse(t(10000)) });
  assert(s.length === 1, "single session despite a large gap");
  assert(s[0].status === "open", "status is open (live position)");
  assert(s[0].trade_count === 3, "all 3 trades included");
});

// ── S6 ───────────────────────────────────────────────────────────────────────
run("S6 multi-instrument flat = all instruments flat", () => {
  // ES closes at 30, but NQ (opened 10) stays open until 120. Account is NOT
  // flat until 120, so a trade at 150 (gap 30 from 120) must NOT split,
  // even though it is 120 min after the ES close.
  const trades = [
    trade({ open: t(0),   close: t(30),  instrument: "ES" }),
    trade({ open: t(10),  close: t(120), instrument: "NQ" }),
    trade({ open: t(150), close: t(155), instrument: "ES" }),
  ];
  const s = buildSessions(USER, trades, { now: Date.parse(t(10000)) });
  assert(s.length === 1, "one session (frontier tracks the latest close across instruments)");
  assert(s[0].trade_count === 3, "all instruments share the session");
});

// ── S7 ───────────────────────────────────────────────────────────────────────
run("S7 eligibility threshold (≥4 trades)", () => {
  const three = buildSessions(USER, [
    trade({ open: t(0), close: t(1) }),
    trade({ open: t(2), close: t(3) }),
    trade({ open: t(4), close: t(5) }),
  ], { now: Date.parse(t(10000)) });
  assert(three[0].eligible_for_analysis === false, "3 trades → not eligible");

  const four = buildSessions(USER, [
    trade({ open: t(0), close: t(1) }),
    trade({ open: t(2), close: t(3) }),
    trade({ open: t(4), close: t(5) }),
    trade({ open: t(6), close: t(7) }),
  ], { now: Date.parse(t(10000)) });
  assert(four[0].eligible_for_analysis === true, "4 trades → eligible");
});

// ── S8 ───────────────────────────────────────────────────────────────────────
run("S8 provisional vs closed depends on now", () => {
  const trades = [
    trade({ open: t(0), close: t(5) }),
    trade({ open: t(8), close: t(12) }),
  ];
  // now only 10 min after end(12) → within G → provisional
  const prov = buildSessions(USER, trades, { now: Date.parse(t(22)) });
  assert(prov[0].status === "provisional", "within G of end → provisional");
  // now 200 min after end → closed
  const closed = buildSessions(USER, trades, { now: Date.parse(t(212)) });
  assert(closed[0].status === "closed", "beyond G of end → closed");
});

// ── S9 ───────────────────────────────────────────────────────────────────────
run("S9 long closed trade is one trade; gap measured from its close", () => {
  // A single 26-hour closed position is NOT split (it is one trade).
  const trades = [
    trade({ open: t(0), close: t(26 * 60) }), // closes 26h later
    // next trade 30 min after the close → same session (gap < G), but a day
    // boundary will have been crossed; with splitOnDayBoundary off we isolate
    // the gap behaviour here.
    trade({ open: t(26 * 60 + 30), close: t(26 * 60 + 35) }),
  ];
  const s = buildSessions(USER, trades, {
    now: Date.parse(t(100000)),
    splitOnDayBoundary: false,
  });
  assert(s.length === 1, "long position + close-adjacent trade → one session");
  assert(s[0].trade_count === 2, "the 26h trade is a single trade, not split");
});

// ── S10 ──────────────────────────────────────────────────────────────────────
run("S10 per-account isolation", () => {
  const trades = [
    trade({ open: t(0), close: t(5), account: "ACC-A" }),
    trade({ open: t(6), close: t(9), account: "ACC-B" }),
    trade({ open: t(8), close: t(9), account: "ACC-A" }),
  ];
  const s = buildSessions(USER, trades, { now: Date.parse(t(10000)) });
  const accounts = new Set(s.map((x) => x.account_id));
  assert(accounts.has("ACC-A") && accounts.has("ACC-B"), "both accounts produced sessions");
  const accA = s.filter((x) => x.account_id === "ACC-A");
  const accB = s.filter((x) => x.account_id === "ACC-B");
  assert(accA.reduce((n, x) => n + x.trade_count, 0) === 2, "ACC-A holds its 2 trades");
  assert(accB.reduce((n, x) => n + x.trade_count, 0) === 1, "ACC-B holds its 1 trade");
});

// ── S11 ──────────────────────────────────────────────────────────────────────
run("S11 zero trades", () => {
  assert(buildSessions(USER, [], {}).length === 0, "empty input → []");
});

// ── S12 ──────────────────────────────────────────────────────────────────────
run("S12 CME day-boundary split even when gap < G", () => {
  // 16:55 CT then 17:10 CT same calendar day, gap 15 min < G, but the 17:00 CT
  // roll lies between them → split. 16:55 CT = 21:55 UTC (CDT, UTC-5).
  const a = new Date(Date.UTC(2025, 5, 3, 21, 55, 0)).toISOString(); // 16:55 CT
  const aClose = new Date(Date.UTC(2025, 5, 3, 21, 58, 0)).toISOString();
  const b = new Date(Date.UTC(2025, 5, 3, 22, 10, 0)).toISOString(); // 17:10 CT
  const bClose = new Date(Date.UTC(2025, 5, 3, 22, 12, 0)).toISOString();
  const trades = [
    trade({ open: a, close: aClose }),
    trade({ open: b, close: bClose }),
  ];
  const withRoll = buildSessions(USER, trades, { now: Date.now(), splitOnDayBoundary: true });
  assert(withRoll.length === 2, "split at 17:00 CT roll despite small gap");
  const noRoll = buildSessions(USER, trades, { now: Date.now(), splitOnDayBoundary: false });
  assert(noRoll.length === 1, "no roll-split when disabled (gap < G)");
});

// ── S13 ──────────────────────────────────────────────────────────────────────
run("S13 every trade belongs to exactly one session", () => {
  const trades = [
    trade({ open: t(0),   close: t(5) }),
    trade({ open: t(10),  close: null }),
    trade({ open: t(200), close: t(205) }),
    trade({ open: t(500), close: t(505), account: "ACC-B" }),
  ];
  const s = buildSessions(USER, trades, { now: Date.parse(t(10000)) });
  const total = s.reduce((n, x) => n + x.trade_count, 0);
  assert(total === trades.length, `trade_count sums to input count (${total} === ${trades.length})`);
});

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
