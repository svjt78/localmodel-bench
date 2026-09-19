// Minimal service worker: exists so the app satisfies PWA installability
// criteria. No offline caching in v1 — the controller is always the source
// of truth and this is a loopback-only local app, so a fetch passthrough is
// all that's needed.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
