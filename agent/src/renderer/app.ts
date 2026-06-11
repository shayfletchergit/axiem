// Renderer process — communicates with main via window.axiem (preload bridge)

interface AgentAPI {
  getSettings: () => Promise<unknown>;
  saveSettings: (s: unknown) => Promise<void>;
  getStatus: () => Promise<unknown>;
  quit: () => void;
  onStatusUpdate: (cb: (status: unknown) => void) => void;
}

declare const window: Window & { axiem: AgentAPI };

// ── DOM refs ──────────────────────────────────────────────────────────────
const axiemUrl     = document.getElementById("axiemUrl") as HTMLInputElement;
const webhookSec   = document.getElementById("webhookSecret") as HTMLInputElement;
const tvToggle     = document.getElementById("tvToggle") as HTMLButtonElement;
const tvFields     = document.getElementById("tvFields") as HTMLDivElement;
const tvToken      = document.getElementById("tvToken") as HTMLInputElement;
const tvDot        = document.getElementById("tvDot") as HTMLElement;
const tvLabel      = document.getElementById("tvLabel") as HTMLElement;
const envDemo      = document.getElementById("envDemo") as HTMLButtonElement;
const envLive      = document.getElementById("envLive") as HTMLButtonElement;
const fwToggle     = document.getElementById("fwToggle") as HTMLButtonElement;
const fwLabel      = document.getElementById("fwLabel") as HTMLElement;
const watchPaths   = document.getElementById("watchPaths") as HTMLTextAreaElement;
const saveBtn      = document.getElementById("saveBtn") as HTMLButtonElement;
const quitBtn      = document.getElementById("quitBtn") as HTMLButtonElement;
const execCount    = document.getElementById("execCount") as HTMLElement;
const lastSync     = document.getElementById("lastSync") as HTMLElement;
const toastEl      = document.getElementById("toastMsg") as HTMLElement;

let tvEnabled = false;
let fwEnabled = false;
let selectedEnv: "demo" | "live" = "demo";

// ── Helpers ───────────────────────────────────────────────────────────────

function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.style.display = "block";
  setTimeout(() => { toastEl.style.display = "none"; }, 2_500);
}

function setEnv(env: "demo" | "live") {
  selectedEnv = env;
  envDemo.style.cssText = env === "demo"
    ? "border-color:rgba(44,196,164,0.35)!important;background:rgba(44,196,164,0.08);color:#2CC4A4;"
    : "";
  envLive.style.cssText = env === "live"
    ? "border-color:rgba(44,196,164,0.35)!important;background:rgba(44,196,164,0.08);color:#2CC4A4;"
    : "";
}

function setToggle(btn: HTMLButtonElement, on: boolean) {
  btn.className = `toggle no-drag${on ? " on" : ""}`;
}

function updateTvStatus(status: string) {
  tvDot.className = `status-dot ${status === "connected" ? "connected" : status === "polling" ? "polling" : status === "error" ? "error" : ""}`;
  tvLabel.textContent =
    status === "connected"  ? "Connected (WS)" :
    status === "polling"    ? "Polling" :
    status === "error"      ? "Error" :
    status === "connecting" ? "Connecting…" :
    "Inactive";
}

// ── Load settings ─────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await window.axiem.getSettings() as Record<string, unknown>;
  axiemUrl.value   = (s.axiemUrl as string) ?? "http://localhost:3000";
  webhookSec.value = (s.webhookSecret as string) ?? "";
  tvEnabled        = Boolean(s.tradovateEnabled);
  fwEnabled        = Boolean(s.fileWatchEnabled);
  tvToken.value    = (s.tradovateToken as string) ?? "";
  setEnv((s.tradovateEnv as "demo" | "live") ?? "demo");
  watchPaths.value = ((s.watchPaths as string[]) ?? []).join("\n");
  setToggle(tvToggle, tvEnabled);
  setToggle(fwToggle, fwEnabled);
  tvFields.style.display = tvEnabled ? "block" : "none";
}

void loadSettings();

// ── Status updates (from main process) ───────────────────────────────────

window.axiem.onStatusUpdate((raw) => {
  const status = raw as Record<string, unknown>;
  updateTvStatus(status.tradovate as string);
  fwLabel.textContent = status.fileWatch === "watching" ? "Watching" : status.fileWatch === "error" ? "Error" : "Inactive";
  execCount.textContent = String(status.executionCount ?? 0);
  const ts = status.lastSyncAt as number | null;
  lastSync.textContent = ts ? new Date(ts).toLocaleTimeString() : "—";
});

// Poll status every 2s
setInterval(async () => {
  const status = await window.axiem.getStatus() as Record<string, unknown>;
  updateTvStatus(status.tradovate as string);
  execCount.textContent = String(status.executionCount ?? 0);
  const ts = status.lastSyncAt as number | null;
  lastSync.textContent = ts ? new Date(ts).toLocaleTimeString() : "—";
}, 2_000);

// ── Interactions ──────────────────────────────────────────────────────────

tvToggle.addEventListener("click", () => {
  tvEnabled = !tvEnabled;
  setToggle(tvToggle, tvEnabled);
  tvFields.style.display = tvEnabled ? "block" : "none";
});

fwToggle.addEventListener("click", () => {
  fwEnabled = !fwEnabled;
  setToggle(fwToggle, fwEnabled);
});

envDemo.addEventListener("click", () => setEnv("demo"));
envLive.addEventListener("click", () => setEnv("live"));

saveBtn.addEventListener("click", async () => {
  await window.axiem.saveSettings({
    axiemUrl: axiemUrl.value.trim().replace(/\/$/, ""),
    webhookSecret: webhookSec.value.trim(),
    tradovateEnabled: tvEnabled,
    tradovateToken: tvToken.value.trim(),
    tradovateEnv: selectedEnv,
    fileWatchEnabled: fwEnabled,
    watchPaths: watchPaths.value.split("\n").map((p) => p.trim()).filter(Boolean),
  });
  toast("Settings saved and applied");
});

quitBtn.addEventListener("click", () => window.axiem.quit());
