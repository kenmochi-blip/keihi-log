// Service Worker 無効化スタブ — 既存クライアントのSWを解除してキャッシュを削除する
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
});
