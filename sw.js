/* Network-first service worker: always tries the network (so bets.json and app updates are
   fresh), falls back to the last cached copy when offline. ESPN (cross-origin) is not touched. */
const CACHE = "betslip-v6";
const SHELL = ["./", "index.html", "style.css?v=6", "app.js?v=5", "calendar.js?v=1", "historical.js?v=1", "sub.js?v=1", "calendar.css?v=1", "sub.css?v=1", "manifest.json", "bets.json",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const isData = url.pathname.endsWith(".json");
  e.respondWith(
    fetch(req, isData ? {cache: "no-store"} : undefined).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        const key = req;
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(req, {ignoreSearch: isData}))
  );
});