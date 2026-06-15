// Minimal service worker for notification support on mobile browsers.
// Android Chrome requires ServiceWorkerRegistration.showNotification()
// instead of new Notification().

// Web Push: "your turn" nudges for async matches (payload from notify-turn fn).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* non-JSON */ }
  const title = data.title || '7 Seconds';
  const body = data.body || "It's your turn to plan!";
  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, { body, data: { url } })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
