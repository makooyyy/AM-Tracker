var CACHE_NAME = "manhwa-tracker-v73";

// The Firebase SDK files are versioned, immutable URLs, so they get their own
// long-lived cache (surviving app updates) and are served cache-first. That lets
// sign-in and sync load offline after the first visit.
var FIREBASE_CACHE = "manhwa-tracker-firebase-sdk";
var FIREBASE_PREFIX = "https://www.gstatic.com/firebasejs/";

// Without these the app can't start, so a failed download aborts the install
// (the previous service worker and cache then keep running untouched).
var CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./sync.js",
  "./manifest.json"
];

// Nice to have offline, but a missing icon must never block an update.
var OPTIONAL_ASSETS = [
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

// How long to wait for the network before falling back to the cached copy.
var NETWORK_TIMEOUT_MS = 4000;

// cache: "reload" skips the browser's HTTP cache. GitHub Pages sends
// max-age=600, so a plain cache.addAll() could store 10-minute-old files.
function fetchFresh(url) {
  return fetch(new Request(url, { cache: "reload" })).then(function (response) {
    if (!response || !response.ok) throw new Error(url + " -> " + (response && response.status));
    return response;
  });
}

function offlineResponse() {
  return new Response("", { status: 503, statusText: "Offline" });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      var core = CORE_ASSETS.map(function (url) {
        return fetchFresh(url).then(function (response) { return cache.put(url, response); });
      });
      var optional = OPTIONAL_ASSETS.map(function (url) {
        return fetchFresh(url)
          .then(function (response) { return cache.put(url, response); })
          .catch(function () { /* ignore */ });
      });
      return Promise.all(core.concat(optional));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_NAME && key !== FIREBASE_CACHE; })
          .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  // Only manage our own files. Fonts, the Telegram script, AniList covers and
  // API calls go straight to the network as if there were no service worker,
  // so offline they fail normally instead of via a broken respondWith().
  var url = new URL(request.url);

  if (request.url.indexOf(FIREBASE_PREFIX) === 0) {
    event.respondWith(
      caches.open(FIREBASE_CACHE).then(function (cache) {
        return cache.match(request).then(function (cached) {
          if (cached) return cached;
          return fetch(request).then(function (response) {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          });
        });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Network first: online, every launch gets the latest files (no more
  // "the update only appears on the second open"). Offline or on a slow
  // connection, the cached copy is served instead.
  var network = fetch(request.url, { cache: "no-cache" }).then(function (response) {
    if (response && response.ok && response.type === "basic") {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(request.url, copy); });
    }
    return response;
  });

  // If we answer from the cache after the timeout, keep the SW alive so the
  // in-flight request can still refresh the cache for next time.
  event.waitUntil(network.catch(function () { /* handled below */ }));

  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, NETWORK_TIMEOUT_MS);
  });

  event.respondWith(
    Promise.race([network.catch(function () { return null; }), timeout]).then(function (response) {
      if (response && response.ok) return response;

      return caches.match(request.url, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;

        // Nothing cached for this URL: wait for the real network answer
        // instead of failing early on a slow connection.
        return network.catch(function () { return null; }).then(function (late) {
          if (late) return late;
          // Offline navigation to an uncached page (e.g. a deep link) still gets the app shell.
          if (request.mode === "navigate") {
            return caches.match("./index.html").then(function (shell) {
              return shell || offlineResponse();
            });
          }
          return offlineResponse();
        });
      });
    })
  );
});
