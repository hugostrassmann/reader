/* Service Worker: App komplett offline verfügbar. Bei Änderungen die Versionsnummer erhöhen. */
const VERSION = 'epub-reader-pwa-1.5.4';
const RUNTIME = 'epub-reader-runtime-v1'; // grosse Sprachdateien, bleiben bei Updates erhalten
const FILES = [
  './', './index.html', './jszip.min.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
  './piper/piper-tts.js', './piper/piper-worker.js'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(FILES.map(f => fetch(f, {cache: 'reload'}).then(r => { if (!r.ok) throw new Error(f); return c.put(f, r); })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== RUNTIME && k.indexOf('piper-voices') !== 0).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  if (isPage) {
    // Seite: zuerst Netz (damit Updates sofort ankommen), ohne Netz aus dem Speicher
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  const big = /\/piper\/.+\.(wasm|data|js)$/.test(url.pathname) && !/piper-tts\.js$/.test(url.pathname);
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (big && res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(RUNTIME).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => Response.error());
    })
  );
});
