/* Offline support. Bump CACHE_VERSION whenever questions.json or the shell changes. */
const CACHE_VERSION = 'chemquiz-v3';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // cache:'reload' so a CACHE_VERSION bump can't re-cache stale HTTP copies.
      .then((c) => c.addAll(
        SHELL.concat(['questions.json']).map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Never cache the worker itself — a stale copy makes updates impossible to ship.
  if (url.pathname.endsWith('/sw.js')) return;

  // Any navigation resolves to the cached shell, whatever query string it carries.
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }

  // The question bank changes as the bank grows: prefer the network, fall back to cache.
  if (url.pathname.endsWith('questions.json')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // Everything else: cache first.
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      // Skip query-string variants so cache-busted URLs don't pile up.
      if (res.ok && res.type === 'basic' && !url.search) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
