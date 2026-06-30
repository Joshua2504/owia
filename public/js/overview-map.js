// Anonyme Übersichtskarte aller versendeter Anzeigen (Startseite + Dashboard).
//
// Lädt die Marker-Daten von /api/public/reports und die Kacheln same-origin von
// /tiles/.... Pro Marker ein Popup mit Verstoßart, Tattag und – falls vorhanden –
// einem stark verpixelten Foto (/api/public/reports/:id/pixel.jpg, serverseitig
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

  function num(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

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
    if (r.imageUrl) {
      // Blockig hochskaliert – das Bild ist serverseitig bereits winzig/verpixelt.
      parts.push(
        '<img src="' +
          encodeURI(r.imageUrl) +
          '" alt="Verpixeltes Beweisfoto" ' +
          'style="width:160px;height:auto;margin-top:6px;border-radius:4px;image-rendering:pixelated">'
      )
    }
    return parts.join('') || 'Anzeige'
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const el = document.getElementById('overview-map')
    if (!el || !window.L) return

    const centerLat = num(el.dataset.centerLat) || 50.1109
    const centerLon = num(el.dataset.centerLon) || 8.6821

    const map = L.map(el).setView([centerLat, centerLon], 12)
    const tiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap-Mitwirkende',
    }).addTo(map)
    attachTileStatus(el, tiles)
    setTimeout(() => map.invalidateSize(), 200)

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
      L.marker([lat, lon]).addTo(map).bindPopup(popupHtml(r))
      bounds.push([lat, lon])
    })

    // Auf die vorhandenen Marker zoomen, sonst beim Stadt-Zentrum bleiben.
    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 })
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 15)
    }
  })
})()
