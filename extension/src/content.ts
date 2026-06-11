// Receives fill events from injected.js (MAIN world) and forwards to background.
console.log("[Axiem] content script loaded");

chrome.runtime.sendMessage({ type: "CONTENT_READY" });

window.addEventListener("message", ({ data }: MessageEvent) => {
  if (data?.__axiem && data.fill) {
    console.log("[Axiem] content forwarding fill to background:", data.fill);
    chrome.runtime.sendMessage({ type: "FILL_DETECTED", fill: data.fill });
  }
});
