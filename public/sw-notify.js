// Minimal service worker for notification support on mobile browsers.
// Android Chrome requires ServiceWorkerRegistration.showNotification()
// instead of new Notification().

// Web Push: turn alerts for online matches (payload from the match-referee function).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* non-JSON */ }
  const title = data.title || '7 Seconds';
  const body = data.body || "It's your turn to plan!";
  const url = data.url || '/';
  // One alert per match: a newer one replaces the older.
  const options = { body, data: { url } };
  if (typeof data.tag === 'string') { options.tag = data.tag; options.renotify = true; }
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target;
  try {
    target = new URL(event.notification.data?.url || self.registration.scope, self.registration.scope);
    if (target.origin !== self.location.origin || !target.href.startsWith(self.registration.scope)) {
      target = new URL(self.registration.scope);
    }
  } catch {
    target = new URL(self.registration.scope);
  }
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'navigate' in client) {
          return client.navigate(target.href).then((navigated) => navigated?.focus());
        }
      }
      return clients.openWindow(target.href);
    })
  );
});
