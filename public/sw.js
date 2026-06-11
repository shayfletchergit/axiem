self.addEventListener("push", (event) => {
  if (!event.data) return;
  const { title, body, url } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/next.svg",
      badge: "/next.svg",
      tag: "axiem-pause",
      renotify: true,
      requireInteraction: true,
      data: { url: url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.includes(self.location.origin) && "focus" in c);
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })
  );
});
