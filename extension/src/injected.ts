// Injected into the Tradovate page's main world at document_start.
// Wraps WebSocket to intercept fill events before the page opens any connections.
(() => {
  console.log("[Axiem] injected — wrapping WebSocket");
  const OrigWS = window.WebSocket;

  window.WebSocket = new Proxy(OrigWS, {
    construct(Target, args: ConstructorParameters<typeof WebSocket>) {
      const ws = new Target(...args);
      const url = String(args[0]);
      console.log("[Axiem] WebSocket opened:", url);

      if (url.includes("tradovate")) {
        ws.addEventListener("message", ({ data }: MessageEvent<string>) => {
          if (typeof data !== "string" || !data.startsWith("a")) return;
          try {
            const frames = JSON.parse(data.slice(1)) as Array<{
              e?: string;
              d?: { entity?: unknown };
            }>;
            for (const f of frames) {
              if (f.e === "props" && (f.d as Record<string, unknown>)?.entityType === "fill") {
                const entity = (f.d as Record<string, unknown>).entity;
                console.log("[Axiem] Fill intercepted:", entity);
                window.postMessage({ __axiem: true, fill: entity }, "*");
              }
            }
          } catch (e) {
            console.error("[Axiem] parse error:", e);
          }
        });
      }
      return ws;
    },
  });
})();
