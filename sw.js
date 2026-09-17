/* Offline support. Bump CACHE_VERSION whenever the bank or the shell changes. */
const CACHE_VERSION = 'examprep-v8';
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

// cache:'reload' so a CACHE_VERSION bump can't re-cache stale HTTP copies.
const fresh = (u) => new Request(u, { cache: 'reload' });

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);

    // The subject files are whatever the catalogue names, so it has to be read
    // before the precache list can be built.
    const indexReq = fresh('data/index.json');
    const indexRes = await fetch(indexReq);
    if (!indexRes.ok) throw new Error('data/index.json — HTTP ' + indexRes.status);
    const index = await indexRes.clone().json();
    const files = (index.subjects || []).map((s) => s.file).filter(Boolean);

    // Any failure here rejects the install, so the previous worker stays active and
    // keeps serving. That beats going live with a half-filled cache.
    await cache.addAll(SHELL.map(fresh));
    await cache.addAll(files.map(fresh));
    await cache.put(indexReq, indexRes);

    await self.skipWaiting();
  })());
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

  // The bank grows as subjects and chapters are added: prefer the network, fall
  // back to cache. Matched on the path so a sub-path deployment works too.
  if (url.pathname.indexOf('/data/') !== -1) {
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
