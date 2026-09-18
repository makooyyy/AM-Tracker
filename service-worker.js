const CACHE_NAME = 'am-tracker-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json'
];

// Install event: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting(); // Activate immediately
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
  const currentCaches = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!currentCaches.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim(); // Take control of all clients
});

// Fetch event: Cache First for static, Network First for API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Strategy for AniList API (Network First with fallback to cache if offline/error)
  if (url.hostname === 'graphql.anilist.co') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone response and add to cache dynamically if needed, 
          // but usually we don't want to cache dynamic GraphQL queries long-term.
          // For now, just pass through. If strict offline search is needed, implement custom logic.
          return response;
        })
        .catch(() => {
          // Optional: Return a cached error message or empty result if network fails completely
          return new Response(JSON.stringify({ errors: [{ message: 'Offline mode: Search unavailable' }] }), {
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // Strategy for Static Assets (Cache First)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetch(event.request).then((networkResponse) => {
        // Update cache in background
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback for navigation requests (if index.html missing from cache somehow)
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
