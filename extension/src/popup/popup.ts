interface Settings {
  axiemUrl: string;
  webhookSecret: string;
  env: "demo" | "live";
  enabled: boolean;
}

const DEFAULT: Settings = {
  axiemUrl: "http://localhost:3000",
  webhookSecret: "axiem-dev-secret-change-in-production",
  env: "demo",
  enabled: true,
};

// ── DOM refs ──────────────────────────────────────────────────────────────
const dot        = document.getElementById("statusDot")!;
const label      = document.getElementById("statusLabel")!;
const syncLabel  = document.getElementById("syncLabel")!;
const axiemUrl   = document.getElementById("axiemUrl") as HTMLInputElement;
const secret     = document.getElementById("webhookSecret") as HTMLInputElement;
const envDemo    = document.getElementById("envDemo") as HTMLButtonElement;
const envLive    = document.getElementById("envLive") as HTMLButtonElement;
const saveBtn    = document.getElementById("saveBtn") as HTMLButtonElement;
const disconnBtn = document.getElementById("disconnectBtn") as HTMLButtonElement;

let selectedEnv: "demo" | "live" = "demo";

// ── Load saved settings ───────────────────────────────────────────────────
chrome.storage.sync.get("settings", (data) => {
  const s: Settings = { ...DEFAULT, ...(data.settings ?? {}) };
  axiemUrl.value = s.axiemUrl;
  secret.value   = s.webhookSecret;
  setEnv(s.env);
});

// ── Poll connection status from background ────────────────────────────────
function refreshStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    const status: string = res.status ?? "waiting";
    const count: number = res.relayCount ?? 0;

    dot.className = `status-dot ${status === "watching" ? "connected" : ""}`;
    label.textContent =
      status === "watching" ? "Watching for fills" :
      "Open Tradovate to activate";

    syncLabel.textContent = status === "watching"
      ? `${count} fill${count === 1 ? "" : "s"} relayed`
      : "No activity yet";
  });
}

refreshStatus();
setInterval(refreshStatus, 2_000);

// ── Env toggle ────────────────────────────────────────────────────────────
function setEnv(env: "demo" | "live") {
  selectedEnv = env;
  envDemo.className = `env-btn${env === "demo" ? " active" : ""}`;
  envLive.className = `env-btn${env === "live" ? " active" : ""}`;
}

envDemo.addEventListener("click", () => setEnv("demo"));
envLive.addEventListener("click", () => setEnv("live"));

// ── Save ──────────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const settings: Settings = {
    axiemUrl: axiemUrl.value.trim().replace(/\/$/, ""),
    webhookSecret: secret.value.trim(),
    env: selectedEnv,
    enabled: true,
  };
  chrome.storage.sync.set({ settings }, () => {
    saveBtn.textContent = "Saved ✓";
    setTimeout(() => { saveBtn.textContent = "Save settings"; }, 1_500);
  });
});

// ── Disconnect ────────────────────────────────────────────────────────────
disconnBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "DISCONNECT" });
  dot.className = "status-dot";
  label.textContent = "Disconnected";
});
