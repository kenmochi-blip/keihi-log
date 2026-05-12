const CACHE = 'keihi-v1';
const STATIC = [
  '/',
  '/index.html',
  '/app.html',
  '/css/style.css',
  '/js/config.js',
  '/js/demo.js',
  '/js/auth.js',
  '/js/sheets.js',
  '/js/drive.js',
  '/js/gemini.js',
  '/js/license.js',
  '/js/setup.js',
  '/js/views/submit.js',
  '/js/views/list.js',
  '/js/views/summary.js',
  '/js/views/settings.js',
  '/js/views/admin.js',
  '/js/router.js',
  '/js/app.js',
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', ev => {
  const { request } = ev;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google API・CDN はキャッシュしない（常に最新データが必要）
  if (url.hostname !== self.location.hostname) return;

  // ページナビゲーション：ネットワーク優先、失敗時はキャッシュ
  if (request.mode === 'navigate') {
    ev.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 静的アセット：キャッシュ優先、なければネットワークから取得してキャッシュ
  ev.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
        return res;
      });
    })
  );
});
