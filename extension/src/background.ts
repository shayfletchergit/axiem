// Extension background service worker.
// Receives intercepted fills from the content script → relays to Axiem webhook.

interface Settings {
  axiemUrl: string;
  webhookSecret: string;
  enabled: boolean;
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

chrome.runtime.onMessage.addListener(
  (msg: { type: string; fill?: TvFillEntity }, _sender, sendResponse) => {
    if (msg.type === "CONTENT_READY") {
      setActive(true);
    }

    if (msg.type === "FILL_DETECTED" && msg.fill) {
      void handleFill(msg.fill);
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
