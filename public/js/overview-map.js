// Anonyme Übersichtskarte aller versendeter Anzeigen (Startseite + Dashboard).
//
// Lädt die Marker-Daten von /api/public/reports und die Kacheln same-origin von
// /tiles/.... Pro Marker ein Popup mit Verstoßart, Tattag und – falls vorhanden –
// einem anonymisierten Foto (/api/public/bild/:id/pixel.jpg, serverseitig
// anonymisiert). Es werden keine personenbezogenen Daten angezeigt.
(function () {
  // Helfer (Icons, Koordinaten-Prüfung, Kacheln, Stadtgrenzen): map-common.js.
  const M = window.OWIA.map
  M.fixDefaultIcon()
  const num = M.coord
  // Für öffentliche Anzeigen ist die Foto-URL bereits die verpixelte Fassung;
  // eigene Entwürfe zeigen das Original (orange umrandet).
  const imageIcon = (url, border) => M.photoIcon(url, { size: 44, border: border })

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
    // /api/public/reports liefert „YYYY-MM-DD" – ohne Date, damit keine
    // Zeitzone den Tag verschiebt.
    const de = window.OWIA.dateDe(d)
    if (de) return de
    const dt = new Date(d)
    return isNaN(dt) ? '' : dt.toLocaleDateString('de-DE')
  }

  const euro = (n) => n.toLocaleString('de-DE') + ' €'

  // Datum + möglicher Betrag (Regelsatz laut Bußgeldkatalog) als eine Zeile.
  function metaHtml(r) {
    const date = formatDate(r.tattag)
    const teile = []
    if (date) teile.push('<span>📅 ' + date + '</span>')
    if (typeof r.betrag === 'number') {
      teile.push('<span class="badge text-bg-danger" title="Regelsatz laut Bußgeldkatalog">' + euro(r.betrag) + '</span>')
    }
    return teile.length ? '<div class="overview-meta d-flex flex-wrap align-items-center gap-2 small my-1">' + teile.join('') + '</div>' : ''
  }

  function popupHtml(r) {
    const parts = []
    if (r.verstossArt) {
      parts.push('<div class="fw-semibold">' + escapeHtml(r.verstossArt) + '</div>')
    }
    parts.push(metaHtml(r))
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

  // Hover (nur mit Maus): Tatbestand, Datum, Betrag und alle Fotos als Tooltip, Klick öffnet weiter das Popup.
  function hoverHtml(r) {
    return (
      (r.verstossArt ? '<div class="fw-semibold text-wrap">' + escapeHtml(r.verstossArt) + '</div>' : '') +
      metaHtml(r) +
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
    M.setupBaseMap(map, el, { maxZoom: MAX_ZOOM, maxNativeZoom: 19 })

    const cluster = createCluster()
    map.addLayer(cluster)

    // Daten nicht erreichbar → leere Karte.
    const reports = ((await window.OWIA.tryJson('/api/public/reports')) || {}).reports || []

    const bounds = []
    reports.forEach((r) => {
      const lat = num(r.lat)
      const lon = num(r.lon)
      if (lat === null || lon === null) return
      const m = L.marker([lat, lon], r.imageUrl ? { icon: imageIcon(r.imageUrl, '#495057'), fotoUrl: r.imageUrl } : {})
        .bindPopup(popupHtml(r), { maxWidth: 360 })
      cluster.addLayer(m)
      if (window.matchMedia('(hover: hover)').matches) {
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
      const own = ((await window.OWIA.tryJson('/api/my/reports')) || {}).reports || []
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
