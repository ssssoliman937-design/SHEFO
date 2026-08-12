// Service Worker for Deal or No Deal Football Draft PWA
//
// Bump CACHE_NAME any time this list changes, or returning visitors keep the
// old cached index.html/scripts (a stale index.html means it won't even
// request newly-added files like utils.js).
const CACHE_NAME = 'dond-football-v45';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/utils.js',
  '/js/sound-effects.js',
  '/js/player-database.js',
  '/js/firebase-engine.js',
  '/js/voice-chat.js',
  '/js/auth.js',
  '/js/user-profile.js',
  '/js/profile-settings.js',
  '/js/leaderboard.js',
  '/js/app.js',
  '/manifest.json',
  '/dond_app_icon.png',
  '/deal/',
  '/deal/index.html',
  '/mazad/',
  '/mazad/index.html',
  '/mazad/css/mazad.css',
  '/mazad/js/auction-engine.js',
  '/mazad/js/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
    // Auto-activate a new version as soon as it installs, instead of
    // sitting "waiting" until every open tab happens to close. Previously
    // the only way out of that wait was the manual "update now" banner,
    // which itself depended on version.json changing - and version.json
    // was never actually bumped on deploy, so returning visitors could be
    // stuck on an old cached build indefinitely with no visible way out.
  );
});

// Lets app.js force this waiting worker to activate immediately when the
// user clicks "update now", instead of relying on a plain reload (which the
// old cache-first strategy could just re-serve unchanged).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Stale-while-revalidate strategy
self.addEventListener('fetch', (event) => {
  // Always fetch version.json from network
  if (event.request.url.includes('version.json')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Only cache valid GET responses
        if (event.request.method === 'GET' && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback for offline if not in cache
        return cachedResponse;
      });
      return cachedResponse || fetchPromise;
    })
  );
});
