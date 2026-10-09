// Anonyme Übersichtskarte aller versendeter Anzeigen (Startseite + Dashboard).
//
// Lädt die Marker-Daten von /api/public/reports und die Kacheln same-origin von
// /tiles/.... Pro Marker ein Popup mit Verstoßart, Tattag und – falls vorhanden –
// einem anonymisierten Foto (/api/public/bild/:id/pixel.jpg, serverseitig
// anonymisiert). Es werden keine personenbezogenen Daten angezeigt.
(function () {
  if (window.L && L.Icon && L.Icon.Default) {
    const base = '/public/vendor/leaflet/images/'
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: base + 'marker-icon-2x.png',
      iconUrl: base + 'marker-icon.png',
      shadowUrl: base + 'marker-shadow.png',
    })
  }

  // `Number('')` und `Number(null)` sind 0 – ohne die Leerprüfung landet eine
  // Anzeige ohne Tatort als Marker auf 0/0 (Golf von Guinea) und fitBounds()
  // zoomt die Karte auf die halbe Weltkugel heraus. Exakt 0 ist hier kein
  // gültiger Wert: die App ist auf deutsche Städte beschränkt.
  function num(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n !== 0 ? n : null
  }

  // Marker als kleines Vorschaubild (erstes Foto) statt Standard-Pin. Für öffentliche
  // Anzeigen ist die URL bereits die verpixelte Fassung; eigene Entwürfe zeigen das Original.
  function imageIcon(url, border) {
    const size = 44
    return L.divIcon({
      className: 'photo-marker',
      html:
        '<img src="' +
        encodeURI(url) +
        '" alt="" style="width:' +
        size +
        'px;height:' +
        size +
        'px;object-fit:cover;border-radius:8px;border:2px solid ' +
        (border || '#495057') +
        ';box-shadow:0 1px 4px rgba(0,0,0,.45)">',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    })
  }

  // Hinweis-Banner oben auf der Karte, falls die Kacheln (noch) nicht verfügbar
  // sind – z.B. weil der Tileserver nach einem Update neu importiert. Blendet
  // sich aus, sobald die erste Kachel erfolgreich lädt.
  function attachTileStatus(el, tileLayer) {
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    const banner = document.createElement('div')
    banner.className = 'alert alert-warning small shadow-sm'
    banner.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;z-index:1000;margin:0'
    banner.textContent =
      'Wir haben ein Update durchgeführt und die Karte wird serverseitig neu ' +
      'verarbeitet. Bitte komm in ein paar Minuten wieder.'
    banner.style.display = 'none'
    el.appendChild(banner)
    let ok = false
    tileLayer.on('tileload', () => {
      ok = true
      banner.style.display = 'none'
    })
    tileLayer.on('tileerror', () => {
      if (!ok) banner.style.display = 'block'
    })
  }

  // Grenzen der freigeschalteten Städte als Umriss einzeichnen (GeoJSON aus
  // OSM-Verwaltungsgrenzen, /api/geo/boundaries) – zeigt, in welchen Gebieten
  // Anzeigen möglich sind. Nicht interaktiv, damit Marker-Klicks ungestört
  // bleiben; ohne erreichbaren Endpoint einfach keine Umrisse.
  async function drawCityBoundaries(map) {
    try {
      const res = await fetch('/api/geo/boundaries', { headers: { Accept: 'application/json' } })
      if (!res.ok) return
      L.geoJSON(await res.json(), {
        interactive: false,
        style: { color: '#6f42c1', weight: 2.5, dashArray: '6 4', fillColor: '#6f42c1', fillOpacity: 0.05 },
      }).addTo(map)
    } catch (_) {
      /* Grenzen nicht ladbar – Karte funktioniert auch ohne */
    }
  }

  // Eigener Entwurf ohne Foto: oranger Punkt (als Marker, damit er clustert).
  function ownDotIcon() {
    return L.divIcon({ className: 'overview-own-dot', iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8] })
  }

  // Höchste Zoomstufe der Karte. Kacheln gibt es bis 19, darüber werden sie
  // hochskaliert – so lassen sich auch Anzeigen wenige Meter auseinander trennen.
  const MAX_ZOOM = 21

  // Gruppier-Radius in Pixeln je Zoomstufe: herausgezoomt großzügig (Übersicht),
  // hineingezoomt nur noch dort, wo sich die 44-px-Vorschaubilder fast ganz
  // verdecken würden. So bleiben beim Heranzoomen möglichst viele Anzeigen
  // einzeln sichtbar.
  function clusterRadius(zoom) {
    if (zoom <= 13) return 50
    if (zoom <= 15) return 40
    if (zoom === 16) return 32
    if (zoom === 17) return 24
    if (zoom === 18) return 18
    return 12
  }

  // Marker-Clustering (Leaflet.markercluster): herausgezoomt fasst ein Kachel-
  // Stapel nahe Anzeigen zusammen – erstes Foto + Anzahl. Klick zoomt hinein;
  // lassen sich die Anzeigen nicht weiter trennen (gleicher Tatort), fächern
  // sie direkt auf.
  function createCluster() {
    if (!L.markerClusterGroup) return L.layerGroup()
    return L.markerClusterGroup({
      maxClusterRadius: clusterRadius,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: true,
      spiderfyDistanceMultiplier: 1.8,
      iconCreateFunction(c) {
        const children = c.getAllChildMarkers()
        const n = children.length
        const foto = children.find((m) => m.options.fotoUrl)
        const eigen = children.some((m) => m.options.eigen)
        const size = n >= 100 ? 60 : n >= 10 ? 54 : 48
        const bild = foto
          ? '<img src="' + encodeURI(foto.options.fotoUrl) + '" alt="">'
          : ''
        return L.divIcon({
          className: 'overview-cluster' + (eigen ? ' is-own' : '') + (bild ? '' : ' no-foto'),
          html: bild + '<span class="overview-cluster-n">' + n + '</span>',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        })
      },
    })
  }

  const escapeHtml = window.OWIA.escapeHtml

  function formatDate(d) {
    if (!d) return ''
    const dt = new Date(d)
    return isNaN(dt) ? '' : dt.toLocaleDateString('de-DE')
  }

  function popupHtml(r) {
    const parts = []
    if (r.verstossArt) {
      parts.push('<div class="fw-semibold">' + escapeHtml(r.verstossArt) + '</div>')
    }
    const date = formatDate(r.tattag)
    if (date) parts.push('<div class="text-muted small">' + date + '</div>')
    const fotos = fotosHtml(r)
    if (fotos) parts.push(fotos)
    return parts.join('') || 'Anzeige'
  }

  function photoUrls(r) {
    return r.imageUrls && r.imageUrls.length ? r.imageUrls : r.imageUrl ? [r.imageUrl] : []
  }

  // Alle Fotos der Anzeige. Serverseitig anonymisiert: Kennzeichen/Gesichter
  // geschwärzt (160 px) oder, ohne Bildanalyse, winzig verpixelt (32 px) und
  // hier blockig hochskaliert.
  function fotosHtml(r) {
    const urls = photoUrls(r)
    if (!urls.length) return ''
    return (
      '<div class="overview-fotos' + (urls.length > 1 ? ' is-multi' : '') + '">' +
      urls
        .map((u, i) => '<img src="' + encodeURI(u) + '" alt="Anonymisiertes Beweisfoto ' + (i + 1) + '" loading="lazy">')
        .join('') +
      '</div>'
    )
  }

  // Hover (nur mit Maus): alle Fotos als Tooltip, Klick öffnet weiter das Popup.
  function hoverHtml(r) {
    const date = formatDate(r.tattag)
    return (
      (r.verstossArt ? '<div class="fw-semibold text-wrap">' + escapeHtml(r.verstossArt) + '</div>' : '') +
      (date ? '<div class="text-muted small">' + date + '</div>' : '') +
      fotosHtml(r)
    )
  }

  // Popup für eigene Entwürfe (nicht anonym – mit Adresse und Bearbeiten-Link).
  function ownPopupHtml(r) {
    const parts = ['<div class="fw-semibold">Eigener Entwurf</div>']
    if (r.tatort) parts.push('<div class="small">' + escapeHtml(r.tatort) + '</div>')
    if (r.verstossArt) parts.push('<div class="small text-muted">' + escapeHtml(r.verstossArt) + '</div>')
    const date = formatDate(r.tattag)
    if (date) parts.push('<div class="small text-muted">' + date + '</div>')
    if (r.url) parts.push('<a class="small" href="' + encodeURI(r.url) + '">Bearbeiten</a>')
    return parts.join('')
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const el = document.getElementById('overview-map')
    if (!el || !window.L) return

    const centerLat = num(el.dataset.centerLat) || 50.1109
    const centerLon = num(el.dataset.centerLon) || 8.6821

    const map = L.map(el, { maxZoom: MAX_ZOOM }).setView([centerLat, centerLon], 12)
    const tiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      maxZoom: MAX_ZOOM,
      maxNativeZoom: 19,
      attribution: '© OpenStreetMap-Mitwirkende',
    }).addTo(map)
    attachTileStatus(el, tiles)
    drawCityBoundaries(map)
    setTimeout(() => map.invalidateSize(), 200)

    const cluster = createCluster()
    map.addLayer(cluster)

    let reports = []
    try {
      const res = await fetch('/api/public/reports', { headers: { Accept: 'application/json' } })
      if (res.ok) reports = (await res.json()).reports || []
    } catch (_) {
      /* Daten nicht erreichbar – leere Karte */
    }

    const bounds = []
    reports.forEach((r) => {
      const lat = num(r.lat)
      const lon = num(r.lon)
      if (lat === null || lon === null) return
      const m = L.marker([lat, lon], r.imageUrl ? { icon: imageIcon(r.imageUrl, '#495057'), fotoUrl: r.imageUrl } : {})
        .bindPopup(popupHtml(r), { maxWidth: 360 })
      cluster.addLayer(m)
      if (photoUrls(r).length && window.matchMedia('(hover: hover)').matches) {
        m.bindTooltip(() => hoverHtml(r), { direction: 'top', offset: [0, -24], className: 'overview-hover', opacity: 1 })
        // Popup offen → Tooltip wäre doppelt.
        m.on('popupopen', () => m.closeTooltip())
      }
      bounds.push([lat, lon])
    })

    // Eigene Entwürfe (nur Dashboard, data-include-own) zusätzlich einzeichnen –
    // andersfarbig (orange) und mit Bearbeiten-Link, klar von den anonymen
    // versendeten Anzeigen unterscheidbar.
    if (el.dataset.includeOwn) {
      let own = []
      try {
        const res = await fetch('/api/my/reports', { headers: { Accept: 'application/json' } })
        if (res.ok) own = (await res.json()).reports || []
      } catch (_) {
        /* eigene Daten nicht erreichbar */
      }
      own.forEach((r) => {
        const lat = num(r.lat)
        const lon = num(r.lon)
        if (lat === null || lon === null) return
        const ownMarker = L.marker([lat, lon], {
          icon: r.imageUrl ? imageIcon(r.imageUrl, '#fd7e14') : ownDotIcon(),
          fotoUrl: r.imageUrl || null,
          eigen: true,
        })
        cluster.addLayer(ownMarker.bindPopup(ownPopupHtml(r)))
        bounds.push([lat, lon])
      })
    }

    // Auf die vorhandenen Marker zoomen, sonst beim Stadt-Zentrum bleiben.
    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 })
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 15)
    }
  })
})()
