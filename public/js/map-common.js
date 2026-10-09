// Gemeinsame Leaflet-Helfer (window.OWIA.map) für report-map.js (Editor),
// overview-map.js (Startseite/Dashboard), photo-edit.js (Foto-Dialog),
// report-inline.js (Karten-Vorschau in der Liste) und analyse-admin.js.
// Braucht common.js (window.OWIA) und darf VOR Leaflet geladen werden: L wird
// erst beim Aufruf angefasst – photo-edit.js/report-inline.js laden Leaflet
// per loadLeaflet() nach. Eingebunden von den Views, die diese Skripte laden
// (dashboard/index.ejs, public/index.ejs, public/analyse.ejs,
// reports/edit.ejs, partials/report-table.ejs); das Dashboard bindet es
// dadurch doppelt ein – der Wächter unten macht den zweiten Lauf zum No-op.
;(function () {
  'use strict'
  if (window.OWIA.map) return

  var TILE_URL = '/tiles/{z}/{x}/{y}.png' // same-origin, Proxy auf basemap.de (src/routes/tiles.ts)
  var ATTRIBUTION = '<a href="https://basemap.de" target="_blank" rel="noopener">© basemap.de / BKG</a>'

  // Standard-Marker-Icons auf die lokal mitgelieferten Bilder setzen – sonst
  // sucht Leaflet sie relativ zum eigenen Pfad und liefert 404 (graues Icon).
  function fixDefaultIcon() {
    if (!(window.L && L.Icon && L.Icon.Default)) return
    var base = '/public/vendor/leaflet/images/'
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: base + 'marker-icon-2x.png',
      iconUrl: base + 'marker-icon.png',
      shadowUrl: base + 'marker-shadow.png',
    })
  }

  // Koordinate aus data-*/JSON → Zahl oder null. `Number('')` und
  // `Number(null)` sind 0 – ohne die Leerprüfung landet eine Anzeige ohne
  // Tatort auf 0/0 (Golf von Guinea), fitBounds() zoomt auf die halbe Welt.
  // Exakt 0 ist kein gültiger Wert: die App ist auf deutsche Städte beschränkt
  // (gleiche Regel beim Speichern in src/routes/reports/shared.ts).
  function coord(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null
    var n = Number(v)
    return Number.isFinite(n) && n !== 0 ? n : null
  }

  // Marker als kleines Vorschaubild (erstes Foto) statt Standard-Pin.
  // opts: size (px, Standard 44), border (Farbe), radius (Eckenradius).
  function photoIcon(url, opts) {
    opts = opts || {}
    var size = opts.size || 44
    return L.divIcon({
      className: 'photo-marker',
      html: '<img src="' + encodeURI(url) + '" alt="" style="width:' + size + 'px;height:' + size +
        'px;object-fit:cover;border-radius:' + (opts.radius || 8) + 'px;border:2px solid ' +
        (opts.border || '#495057') + ';box-shadow:0 1px 4px rgba(0,0,0,.45)">',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    })
  }

  // Kachel-Layer der App (noch nicht zur Karte hinzugefügt). opts gehen an
  // L.tileLayer; attribution: false lässt den basemap.de-Hinweis weg (Karten
  // mit attributionControl: false).
  function tileLayer(opts) {
    var o = { maxZoom: 19, attribution: ATTRIBUTION }
    for (var k in opts || {}) o[k] = opts[k]
    if (o.attribution === false) delete o.attribution
    return L.tileLayer(TILE_URL, o)
  }

  // Hinweis-Banner oben auf der Karte, falls die Kacheln (noch) nicht verfügbar
  // sind – z.B. weil basemap.de gerade nicht antwortet. Blendet sich aus,
  // sobald die erste Kachel erfolgreich lädt.
  function attachTileStatus(el, layer) {
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    var banner = document.createElement('div')
    banner.className = 'alert alert-warning small shadow-sm'
    banner.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;z-index:1000;margin:0'
    banner.textContent =
      'Wir haben ein Update durchgeführt und die Karte wird serverseitig neu ' +
      'verarbeitet. Bitte komm in ein paar Minuten wieder.'
    banner.style.display = 'none'
    el.appendChild(banner)
    var ok = false
    layer.on('tileload', function () {
      ok = true
      banner.style.display = 'none'
    })
    layer.on('tileerror', function () {
      if (!ok) banner.style.display = 'block'
    })
  }

  // Grenzen der freigeschalteten Städte als Umriss einzeichnen (GeoJSON aus
  // OSM-Verwaltungsgrenzen, /api/geo/boundaries) – zeigt, wo Anzeigen möglich
  // sind. Nicht interaktiv, damit Marker-Drag und Klicks ungestört bleiben;
  // ohne erreichbaren Endpoint einfach keine Umrisse.
  function drawCityBoundaries(map) {
    return window.OWIA.tryJson('/api/geo/boundaries').then(function (geo) {
      if (!geo) return
      L.geoJSON(geo, {
        interactive: false,
        style: { color: '#6f42c1', weight: 2.5, dashArray: '6 4', fillColor: '#6f42c1', fillOpacity: 0.05 },
      }).addTo(map)
    }).catch(function () { /* Grenzen unbrauchbar – Karte funktioniert auch ohne */ })
  }

  // Standard-Karte der App: Kacheln + Banner bei Kachel-Ausfall + Stadtgrenzen
  // + Neuvermessung nach kurzem Tick (Container haben beim Init evtl. noch
  // kein finales Layout, sonst bleibt die Karte grau). Liefert den Kachel-Layer.
  function setupBaseMap(map, el, tileOpts) {
    var layer = tileLayer(tileOpts).addTo(map)
    attachTileStatus(el, layer)
    drawCityBoundaries(map)
    setTimeout(function () { map.invalidateSize() }, 200)
    return layer
  }

  // Leaflet bei Bedarf nachladen (Listenseiten binden es nicht ein). Ein
  // fehlgeschlagener Versuch leert den Cache, damit der nächste neu lädt.
  var leafletLoading = null
  function loadLeaflet() {
    if (window.L) return Promise.resolve()
    if (!leafletLoading) {
      leafletLoading = new Promise(function (resolve, reject) {
        var css = document.createElement('link')
        css.rel = 'stylesheet'
        css.href = '/public/vendor/leaflet.css'
        document.head.appendChild(css)
        var js = document.createElement('script')
        js.src = '/public/vendor/leaflet.js'
        js.onload = function () { fixDefaultIcon(); resolve() }
        js.onerror = function () { leafletLoading = null; reject() }
        document.head.appendChild(js)
      })
    }
    return leafletLoading
  }

  window.OWIA.map = {
    fixDefaultIcon: fixDefaultIcon,
    coord: coord,
    photoIcon: photoIcon,
    tileLayer: tileLayer,
    attachTileStatus: attachTileStatus,
    drawCityBoundaries: drawCityBoundaries,
    setupBaseMap: setupBaseMap,
    loadLeaflet: loadLeaflet,
  }
})()
