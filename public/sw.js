// Service Worker für die PWA-Installierbarkeit. Bewusst minimal und
// datenschutzkonform: gecacht werden AUSSCHLIESSLICH statische Assets unter
// /public/ (CSS, JS, Icons, gevendorte Libraries) – niemals Seiten oder
// Bilder unter /anzeige*, /import* usw.: Beweisfotos und personenbezogene
// Inhalte gehören nicht in den Cache-Storage des Browsers.
// Cache-Name bei Asset-Änderungen hochzählen, damit alte Dateien nicht hängen.
var CACHE = 'owia-static-v2'

// Offline-Ersatzseite samt allem, was sie zum Anzeigen braucht. Statisch und
// ohne Nutzerdaten – Seiteninhalte selbst werden weiterhin nie gecacht.
var OFFLINE_URL = '/public/offline.html'
var OFFLINE_ASSETS = [OFFLINE_URL, '/public/js/offline.js', '/public/js/theme-init.js', '/public/css/app.css', '/public/vendor/bootstrap.min.css']

self.addEventListener('install', function (event) {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(OFFLINE_ASSETS) }).catch(function () {})
  )
})

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE }).map(function (k) { return caches.delete(k) })
      )
    }).then(function () { return self.clients.claim() })
  )
})

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url)
  // Seitenaufrufe: immer übers Netz (kein Cachen von Seiten!); nur wenn das
  // scheitert (offline), die Ersatzseite statt der Browser-Fehlerseite.
  if (event.request.mode === 'navigate' && event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request).catch(function () {
        return caches.match(OFFLINE_URL).then(function (hit) { return hit || Response.error() })
      })
    )
    return
  }
  var cacheable =
    event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    url.pathname.startsWith('/public/')
  if (!cacheable) return // alles andere: reiner Netzwerk-Passthrough

  // Statische Assets: Netzwerk zuerst (tsx watch/Deploys ändern Dateien ohne
  // Versionierung im Pfad), bei Offline/Fehler aus dem Cache.
  event.respondWith(
    fetch(event.request)
      .then(function (res) {
        if (res.ok) {
          var copy = res.clone()
          caches.open(CACHE).then(function (cache) { cache.put(event.request, copy) })
        }
        return res
      })
      .catch(function () {
        return caches.match(event.request).then(function (hit) {
          return hit || Response.error()
        })
      })
  )
})
