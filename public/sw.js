const CACHE = "ledgermate-shell-v1";
const SHELL_FILES = ["/", "/style.css", "/app.js", "/manifest.json", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for API calls (always want fresh data), cache-first for the app shell.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // let API calls go straight to network

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
