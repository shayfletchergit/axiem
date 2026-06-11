import { Tray, Menu, nativeImage, BrowserWindow } from "electron";
import { join } from "path";

let tray: Tray | null = null;

export function createTray(
  win: BrowserWindow,
  getStatus: () => { tradovate: string; executionCount: number },
): Tray {
  // Use a template image (white, automatically inverted on macOS dark/light)
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAALEwAACxMBAJqcGAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADASURBVDiNxZM9DoJAEIXfLIWJiYmJiYmxMTExMTExMTExMSYmxMTExMTExMTE" +
    "xMTExMTY2NjY2NjY2NjY2NjY2NjY2NjYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYA==",
  );
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip("Axiem Agent");

  function updateMenu() {
    const { tradovate, executionCount } = getStatus();
    const statusLabel =
      tradovate === "connected" ? "● Connected (WS)" :
      tradovate === "polling"   ? "◐ Polling" :
      tradovate === "error"     ? "✕ Error" :
      "○ Inactive";

    tray!.setContextMenu(Menu.buildFromTemplate([
      { label: "Axiem Agent", enabled: false },
      { type: "separator" },
      { label: `Tradovate: ${statusLabel}`, enabled: false },
      { label: `Executions relayed: ${executionCount}`, enabled: false },
      { type: "separator" },
      { label: "Open settings", click: () => { win.show(); win.focus(); } },
      { type: "separator" },
      { label: "Quit", click: () => { win.destroy(); process.exit(0); } },
    ]));
  }

  updateMenu();
  setInterval(updateMenu, 5_000);

  tray.on("click", () => { win.show(); win.focus(); });
  return tray;
}
