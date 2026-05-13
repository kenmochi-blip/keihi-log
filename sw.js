const CACHE = 'keihi-v3';

self.addEventListener('install', ev => {
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

  // Google API・CDN はキャッシュしない
  if (url.hostname !== self.location.hostname) return;

  // JS・CSS・HTML はネットワーク優先（常に最新を取得、失敗時のみキャッシュ）
  if (/\.(js|css|html)$/.test(url.pathname) || request.mode === 'navigate') {
    ev.respondWith(
      fetch(request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // その他（フォント・画像等）：キャッシュ優先
  ev.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
