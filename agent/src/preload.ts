import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("axiem", {
  getSettings: ()             => ipcRenderer.invoke("get-settings"),
  saveSettings: (s: unknown)  => ipcRenderer.invoke("save-settings", s),
  getStatus: ()               => ipcRenderer.invoke("get-status"),
  quit: ()                    => ipcRenderer.send("quit"),
  onStatusUpdate: (cb: (s: unknown) => void) =>
    ipcRenderer.on("status-update", (_event, s) => cb(s)),
});
