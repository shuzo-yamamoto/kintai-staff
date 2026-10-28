/**
 * sw.js — Service Worker（画面の部品だけをキャッシュする）
 *
 * - 画面（HTML・CSS・JS・アイコン）は同じオリジンの GET だけキャッシュする
 * - API（GAS への POST）はキャッシュせずそのまま通す。打刻はネットが無いと受け付けない（§13.6・Q10）
 * - 画面を変えたら CACHE_VERSION を必ず上げる（古いキャッシュを消すため）
 */
'use strict';

const CACHE_VERSION = 'kintai-staff-v0.3.0';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/api.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
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
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // キャッシュを先に返し、裏で新しいものに入れ替える
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
