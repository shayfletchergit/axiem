import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "path";
import Store from "electron-store";
import { createTray } from "./tray";
import { TradovateConnector } from "./connectors/TradovateConnector";
import { FileWatcher } from "./connectors/FileWatcher";
import { relayExecutions } from "./webhook";
import type { AgentSettings, AgentStatus, Execution } from "./types";
import { DEFAULT_SETTINGS } from "./types";

// ── Persistent settings ───────────────────────────────────────────────────
const store = new Store<{ settings: AgentSettings }>({
  defaults: { settings: DEFAULT_SETTINGS },
});

function getSettings(): AgentSettings {
  return store.get("settings");
}

function saveSettings(s: AgentSettings): void {
  store.set("settings", { ...DEFAULT_SETTINGS, ...s });
}

// ── Runtime status ────────────────────────────────────────────────────────
const status: AgentStatus = {
  tradovate: "disconnected",
  fileWatch: "inactive",
  lastSyncAt: null,
  executionCount: 0,
  error: null,
};

// ── Connectors ────────────────────────────────────────────────────────────
let tvConnector: TradovateConnector | null = null;
let fileWatcher: FileWatcher | null = null;

function onExecutions(execs: Execution[]): void {
  const s = getSettings();
  status.executionCount += execs.length;
  status.lastSyncAt = Date.now();

  relayExecutions(s.axiemUrl, s.webhookSecret, execs).catch((err) => {
    status.error = String(err);
  });

  mainWindow?.webContents.send("status-update", { ...status });
}

function applySettings(s: AgentSettings): void {
  // Stop existing connectors
  tvConnector?.stop();
  fileWatcher?.stop();
  tvConnector = null;
  fileWatcher = null;

  // Start Tradovate connector
  if (s.tradovateEnabled && s.tradovateToken) {
    tvConnector = new TradovateConnector(
      s.tradovateToken,
      s.tradovateEnv,
      onExecutions,
      (connStatus) => {
        status.tradovate = connStatus as AgentStatus["tradovate"];
        mainWindow?.webContents.send("status-update", { ...status });
      },
    );
    tvConnector.start();
  } else {
    status.tradovate = "disconnected";
  }

  // Start file watcher
  if (s.fileWatchEnabled && s.watchPaths.length > 0) {
    fileWatcher = new FileWatcher(
      s.watchPaths,
      onExecutions,
      (watchStatus) => {
        status.fileWatch = watchStatus;
        mainWindow?.webContents.send("status-update", { ...status });
      },
    );
    fileWatcher.start();
  } else {
    status.fileWatch = "inactive";
  }
}

// ── Window ────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 380,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1a1917",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  win.loadFile(join(__dirname, "renderer/index.html"));

  win.once("ready-to-show", () => win.show());

  // Hide to tray on close rather than quit
  win.on("close", (e) => {
    e.preventDefault();
    win.hide();
  });

  // Open external links in browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

// ── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle("get-settings", () => getSettings());

ipcMain.handle("save-settings", (_event, s: AgentSettings) => {
  saveSettings(s);
  applySettings(s);
});

ipcMain.handle("get-status", () => ({ ...status }));

ipcMain.on("quit", () => {
  tvConnector?.stop();
  fileWatcher?.stop();
  app.quit();
});

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  mainWindow = createWindow();
  createTray(mainWindow, () => ({
    tradovate: status.tradovate,
    executionCount: status.executionCount,
  }));

  // Apply saved settings on startup
  applySettings(getSettings());
});

app.on("window-all-closed", (e: Event) => {
  // Keep running in tray — don't quit when window closes
  e.preventDefault();
});

app.on("activate", () => {
  mainWindow?.show();
});
