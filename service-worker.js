const CACHE_NAME = "bibliotheque-marina-v1-1-0";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/sync.js",
  "./js/app.js",
  "./js/kindle-captures.js",
  "./js/kindle-cover-sync.js",
  "./js/captures-import.js",
  "./data/books.json",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Réseau d'abord (le site et books.json changent à chaque synchronisation),
// cache seulement en secours hors ligne. Les appels à l'API GitHub et aux
// autres domaines ne passent pas par le cache.
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match("./index.html")))
  );
});
