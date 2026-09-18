const VERSION = 'am-tracker-v68';

const REQUIRED_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

const OPTIONAL_ASSETS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);

    await Promise.all(
      REQUIRED_ASSETS.map((asset) => cache.add(asset))
    );

    await Promise.allSettled(
      OPTIONAL_ASSETS.map((asset) => cache.add(asset))
    );

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== VERSION)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Не-GET запросы: для AniList отдаём понятную офлайн-ошибку
  if (request.method !== 'GET') {
    if (url.hostname === 'graphql.anilist.co') {
      event.respondWith(
        fetch(request).catch(() => {
          return new Response(
            JSON.stringify({
              data: { Page: { media: [] } },
              errors: [{ message: 'Нет сети. Поиск AniList недоступен офлайн.' }]
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        })
      );
    }
    return;
  }

  // Свои ресурсы
  if (url.origin === self.location.origin) {
    // Навигация: сеть -> фолбэк на index.html
    if (request.mode === 'navigate') {
      event.respondWith(
        fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
            return response;
          })
          .catch(() => caches.match('./index.html'))
      );
      return;
    }

    // Обычные GET-запросы: cache first
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;

        return fetch(request)
          .then((response) => {
            if (response && response.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
            }
            return response;
          })
          .catch(() => {
            if (request.destination === 'document') {
              return caches.match('./index.html');
            }
            return cached;
          });
      })
    );
    return;
  }

  // Внешние GET-запросы: network first, немного кэшируем успешные ответы
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response &&
          response.ok &&
          (
            url.hostname.endsWith('anilist.co') ||
            url.hostname.endsWith('cloudinary.com')
          )
        ) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
