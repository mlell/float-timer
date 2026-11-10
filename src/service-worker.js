// Cache complete releases of the app shell independently of web app installation.
/* global APP_VERSION, APP_ASSETS */
const cachePrefix = `timer-shell:${self.registration.scope}:`;
const cacheName = `${cachePrefix}${APP_VERSION}`;
const assets = APP_ASSETS.map(
  (asset) => new URL(asset, self.registration.scope).href,
);
const indexUrl = new URL("index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  // Reject incomplete releases and bypass HTTP caches when fetching a new shell.
  // Leave updates waiting until existing tabs close rather than interrupting a timer.
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) =>
        cache.addAll(
          assets.map((url) => new Request(url, { cache: "reload" })),
        ),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  const assetUrl = url.href === self.registration.scope ? indexUrl : url.href;
  if (!assets.includes(assetUrl)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      return (await cache.match(assetUrl)) ?? fetch(event.request);
    })(),
  );
});
