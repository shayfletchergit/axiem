"use client";

import { useEffect, useRef, useCallback } from "react";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))).buffer as ArrayBuffer;
}

export function usePushNotification() {
  const subscriptionRef = useRef<PushSubscription | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(async (reg) => {
      // Reuse existing subscription or create one
      let sub = await reg.pushManager.getSubscription();
      if (!sub && Notification.permission === "granted") {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      subscriptionRef.current = sub;
    }).catch(() => {
      // Service worker registration failed silently — push won't work
    });
  }, []);

  const requestAndSubscribe = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return false;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return false;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      subscriptionRef.current = sub;
      return true;
    } catch {
      return false;
    }
  }, []);

  const sendPauseNotification = useCallback(async (insight: string) => {
    // Always try a foreground notification first (works even without push sub)
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      new Notification("Axiem — Pause", {
        body: insight,
        tag: "axiem-pause",
        requireInteraction: true,
      });
    }

    // Also send via push API so it works when the tab is closed
    const sub = subscriptionRef.current;
    if (!sub) return;
    await fetch("/api/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        title: "Axiem — Pause",
        body: insight,
        url: "/",
      }),
    });
  }, []);

  return { requestAndSubscribe, sendPauseNotification };
}
