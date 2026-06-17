// Receives fill events from injected.js (MAIN world) and forwards to background.
console.log("[Axiem] content script loaded");

chrome.runtime.sendMessage({ type: "CONTENT_READY" });

window.addEventListener("message", ({ data }: MessageEvent) => {
  if (!data?.__axiem) return;
  if (data.fill) {
    console.log("[Axiem] content forwarding fill to background:", data.fill);
    chrome.runtime.sendMessage({ type: "FILL_DETECTED", fill: data.fill });
  } else if (data.pnl) {
    chrome.runtime.sendMessage({ type: "PNL_DETECTED", pnl: data.pnl, entityType: data.entityType });
  }
});
