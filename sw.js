/**
 * Service Worker — Sailboat Polar Builder
 * Cache-first for app shell assets; network-only for external API calls.
 */

const CACHE_NAME = 'polar-builder-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
];

// Install: pre-cache all app-shell assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first for same-origin assets; pass through for external requests
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Let Wikipedia / Wikimedia API calls go straight to network (need live data)
  if (url.origin !== self.location.origin) return;

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache valid same-origin responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
