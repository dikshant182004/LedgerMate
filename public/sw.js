const CACHE = "ledgermate-shell-v6";
const SHELL_FILES = [
  "/",
  "/landing.css?v=3",
  "/app/",
  "/style.css?v=5",
  "/app.js?v=5",
  "/manifest.json",
  "/vendor/chart.umd.min.js",
  "/vendor/qrcode.min.js",
  "/icons/icon-192.png",
  "/icons/favicon-32.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Bypass API and Auth calls completely
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Navigation requests: Network-first, fallback to cache if offline
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match("/app/")))
    );
    return;
  }

  // Static assets (CSS, JS, images, fonts): Stale-While-Revalidate for near-zero latency
  if (/\.(?:css|js|png|jpe?g|svg|ico|woff2?|webp)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, clone)).catch(() => {});
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // Default: Network fetch
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
