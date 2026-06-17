// Extension background service worker.
// Receives intercepted fills from the content script → relays to Axiem webhook.

interface Settings {
  axiemUrl: string;
  webhookSecret: string;
  enabled: boolean;
  ingestToken: string;   // axm_… bearer token for /api/rail/ingest (live RAIL)
  railAccount: string;   // the Axiem account_id this P&L maps to (e.g. "APEX-A")
}

interface TvFillEntity {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  action: "Buy" | "Sell";
  qty: number;
  price: number;
}

const DEFAULT_SETTINGS: Settings = {
  axiemUrl: "http://localhost:3000",
  webhookSecret: "axiem-dev-secret-change-in-production",
  enabled: true,
  ingestToken: "",
  railAccount: "",
};

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> ?? {}) };
}

const seen = new Set<string>();
let relayCount = 0;
let active = false;

function setActive(on: boolean) {
  active = on;
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2CC4A4" });
}

async function handleFill(fill: TvFillEntity) {
  const execId = String(fill.id);
  console.log("[Axiem] handleFill:", execId, fill);
  if (seen.has(execId)) return;
  seen.add(execId);

  const settings = await getSettings();
  if (!settings.enabled) return;

  const execution = {
    id: `extension:${execId}`,
    brokerExecId: execId,
    accountId: "default",
    symbol: String(fill.contractId),
    side: fill.action === "Buy" ? "buy" : "sell",
    qty: fill.qty,
    price: fill.price,
    timestamp: fill.timestamp,
    receivedAt: Date.now(),
    orderId: String(fill.orderId),
  };

  try {
    const res = await fetch(`${settings.axiemUrl}/api/webhook/execution`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-axiem-secret": settings.webhookSecret,
      },
      body: JSON.stringify({ executions: [execution] }),
    });
    console.log("[Axiem] relay response:", res.status);
    relayCount++;
    chrome.action.setBadgeText({ text: String(relayCount) });
  } catch (e) {
    console.error("[Axiem] relay error:", e);
  }
}

// ── Live open P&L → RAIL ───────────────────────────────────────────────────
// Extract an open-P&L (and optionally day-realized) value from a broker entity.
// ⚠ Field names vary by platform — VERIFY in DevTools (see RAIL.md). These are
//   defensive heuristics, not guarantees.
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function findKey(entity: Record<string, unknown>, re: RegExp): number | null {
  for (const [k, v] of Object.entries(entity)) {
    if (re.test(k)) { const n = num(v); if (n != null) return n; }
  }
  return null;
}
function extractOpenPnl(entity: Record<string, unknown>): { openPnl: number | null; dayRealizedPnl: number | null } {
  return {
    openPnl:        findKey(entity, /open.*p.?n.?l|unrealized/i),
    dayRealizedPnl: findKey(entity, /realized|day.?p.?n.?l/i),
  };
}

interface RailTick { account: string; openPnl?: number; dayRealizedPnl?: number; timestamp: number }
let pendingTick: RailTick | null = null;
let lastSentAt = 0;
let railTimer: ReturnType<typeof setTimeout> | null = null;

async function railPost(tick: RailTick) {
  const s = await getSettings();
  if (!s.ingestToken || !s.railAccount) return;
  try {
    await fetch(`${s.axiemUrl}/api/rail/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.ingestToken}` },
      body: JSON.stringify(tick),
    });
  } catch (e) {
    console.error("[Axiem] rail post error:", e);
  }
}

// Throttle to ~500ms, latest-wins (the server batches to 250ms regardless).
function queueRail(tick: RailTick) {
  pendingTick = tick;
  if (railTimer) return;
  const wait = Math.max(0, 500 - (Date.now() - lastSentAt));
  railTimer = setTimeout(() => {
    railTimer = null;
    if (!pendingTick) return;
    const t = pendingTick; pendingTick = null; lastSentAt = Date.now();
    void railPost(t);
  }, wait);
}

async function handlePnl(entity: Record<string, unknown>) {
  const s = await getSettings();
  if (!s.enabled || !s.ingestToken || !s.railAccount) return;
  const { openPnl, dayRealizedPnl } = extractOpenPnl(entity);
  if (openPnl == null && dayRealizedPnl == null) return;
  queueRail({
    account: s.railAccount,
    openPnl: openPnl ?? undefined,
    dayRealizedPnl: dayRealizedPnl ?? undefined,
    timestamp: Date.now(),
  });
}

chrome.runtime.onMessage.addListener(
  (msg: { type: string; fill?: TvFillEntity; pnl?: Record<string, unknown> }, _sender, sendResponse) => {
    if (msg.type === "CONTENT_READY") {
      setActive(true);
    }

    if (msg.type === "FILL_DETECTED" && msg.fill) {
      void handleFill(msg.fill);
    }

    if (msg.type === "PNL_DETECTED" && msg.pnl) {
      void handlePnl(msg.pnl);
    }

    if (msg.type === "GET_STATUS") {
      sendResponse({ status: active ? "watching" : "waiting", relayCount });
      return true;
    }

    if (msg.type === "DISCONNECT") {
      setActive(false);
    }
  },
);

// Keep service worker alive (MV3 service workers get suspended)
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});
