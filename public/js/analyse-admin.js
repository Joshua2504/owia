// Admin-Analyse (/admin/analyse): Hover über ein Vergehen im Ranking zeigt eine
// Detailkarte mit Tatort-Karte, Fotos und Anzeigendaten. Klick (oder Tipp auf
// dem Handy, Enter per Tastatur) hält die Karte fest, Escape/Klick daneben
// schließt sie. Daten kommen als JSON aus data-detail der Tabellenzeile
// (services/analyse.ts → VergehenDetail), Fotos über /admin/analyse/bild/:id.
;(function () {
  var HIDE_DELAY_MS = 250
  var esc = window.OWIA.escapeHtml
  var canHover = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches

  var card = null
  var body = null
  var mapEl = null
  var map = null
  var marker = null
  var activeRow = null
  var pinned = false
  var hideTimer = null

  function build() {
    card = document.createElement('div')
    card.className = 'an-card shadow-lg'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', 'Anzeigendetails')
    card.innerHTML =
      '<button type="button" class="btn-close an-card-close" aria-label="Schließen"></button>' +
      '<div class="an-card-body"></div><div class="an-card-map"></div><div class="an-card-fotos"></div>'
    body = card.querySelector('.an-card-body')
    mapEl = card.querySelector('.an-card-map')
    document.body.appendChild(card)
    card.querySelector('.an-card-close').addEventListener('click', hide)
    card.addEventListener('mouseenter', function () { clearTimeout(hideTimer) })
    card.addEventListener('mouseleave', function () { if (!pinned) scheduleHide() })
  }

  function ensureMap() {
    if (map || !window.L) return
    map = L.map(mapEl, { zoomControl: true, attributionControl: false, maxZoom: 21 })
    L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19 }).addTo(map)
    marker = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 2, fillColor: '#dc3545', fillOpacity: 1 }).addTo(map)
  }

  function datumDe(iso) {
    if (!iso) return ''
    var p = iso.split('-')
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso
  }

  function zeile(label, wert) {
    if (!wert) return ''
    return '<div class="an-card-row"><span class="text-muted">' + esc(label) + '</span><span>' + wert + '</span></div>'
  }

  function render(d) {
    var zeit = d.von ? d.von + (d.bis && d.bis !== d.von ? '–' + d.bis : '') + ' Uhr' : ''
    var tag = esc((d.wochentag ? d.wochentag + ' ' : '') + d.datum) +
      (d.tattagBis ? ' – ' + esc(datumDe(d.tattagBis)) : '') + (zeit ? ', ' + esc(zeit) : '')
    var links = []
    if (d.pdf) links.push('<a href="/admin/anzeigen/' + encodeURIComponent(d.id) + '/pdf" target="_blank" rel="noopener">PDF</a>')
    if (d.lat !== null && d.lon !== null) {
      links.push('<a href="https://www.openstreetmap.org/?mlat=' + d.lat + '&mlon=' + d.lon + '#map=19/' + d.lat + '/' + d.lon +
        '" target="_blank" rel="noopener noreferrer">OSM</a>')
    }
    body.innerHTML =
      '<div class="d-flex gap-2 align-items-baseline pe-4">' +
        (d.kennzeichen ? '<span class="an-kz">' + esc(d.kennzeichen) + '</span>' : '') +
        (d.az ? '<span class="small text-muted">' + esc(d.az) + '</span>' : '') +
        (links.length ? '<span class="small ms-auto">' + links.join(' · ') + '</span>' : '') +
      '</div>' +
      '<div class="fw-semibold mt-1">' + esc(d.tatbestand || '') +
        (d.euro ? ' <span class="badge text-bg-primary">' + esc(d.euro) + '</span>' : '') + '</div>' +
      '<div class="an-card-grid mt-2">' +
        zeile('Wann', tag) +
        zeile('Wo', esc(d.tatort || d.stadt || '')) +
        zeile('Fahrzeug', esc(d.fahrzeug || '')) +
        zeile('Verlassen', d.verlassen ? 'ja' : '') +
        zeile('Behinderung', d.behinderung ? esc(d.behinderungText || 'ja') : '') +
        zeile('Beschreibung', esc(d.beschreibung || '')) +
      '</div>'

    var fotos = card.querySelector('.an-card-fotos')
    fotos.innerHTML = (d.bilder || []).map(function (id, i) {
      return '<a href="/admin/analyse/bild/' + encodeURIComponent(id) + '" target="_blank" rel="noopener">' +
        '<img src="/admin/analyse/bild/' + encodeURIComponent(id) + '/thumb.jpg" alt="Foto ' + (i + 1) + '" loading="lazy"></a>'
    }).join('')
    fotos.style.display = d.bilder && d.bilder.length ? '' : 'none'

    var hatOrt = d.lat !== null && d.lon !== null && window.L
    mapEl.style.display = hatOrt ? '' : 'none'
    if (hatOrt) {
      ensureMap()
      map.invalidateSize()
      map.setView([d.lat, d.lon], 17, { animate: false })
      marker.setLatLng([d.lat, d.lon])
    }
  }

  function place(row) {
    var r = row.getBoundingClientRect()
    var w = card.offsetWidth
    var h = card.offsetHeight
    var vw = document.documentElement.clientWidth
    var vh = window.innerHeight
    var left = Math.min(Math.max(8, r.left + 24), vw - w - 8)
    // Bevorzugt unter der Zeile, sonst darüber; passt beides nicht, an den
    // rechten Rand neben die Datumsspalte (die Zeile bleibt links lesbar).
    var top = r.bottom + 6
    if (top + h > vh - 8) top = r.top - h - 6
    if (top < 8) {
      left = vw - w - 8
      top = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), Math.max(8, vh - h - 8))
    }
    card.style.left = left + 'px'
    card.style.top = top + 'px'
  }

  function show(row) {
    var d
    try { d = JSON.parse(row.getAttribute('data-detail')) } catch (_) { return }
    if (!card) build()
    clearTimeout(hideTimer)
    if (activeRow) activeRow.classList.remove('is-active')
    activeRow = row
    row.classList.add('is-active')
    card.classList.add('is-open')
    render(d)
    place(row)
  }

  function hide() {
    clearTimeout(hideTimer)
    pinned = false
    if (card) card.classList.remove('is-open', 'is-pinned')
    if (activeRow) activeRow.classList.remove('is-active')
    activeRow = null
  }

  function scheduleHide() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hide, HIDE_DELAY_MS)
  }

  function rowOf(t) {
    return t && t.closest ? t.closest('tr.an-vg') : null
  }

  if (canHover) {
    document.addEventListener('mouseover', function (e) {
      var row = rowOf(e.target)
      if (!row || pinned || row === activeRow) return
      show(row)
    })
    document.addEventListener('mouseout', function (e) {
      var row = rowOf(e.target)
      if (!row || pinned) return
      if (e.relatedTarget && (row.contains(e.relatedTarget) || (card && card.contains(e.relatedTarget)))) return
      scheduleHide()
    })
  }

  function pin(row) {
    if (pinned && row === activeRow) return hide()
    show(row)
    pinned = true
    card.classList.add('is-pinned')
  }

  document.addEventListener('click', function (e) {
    var row = rowOf(e.target)
    if (row) return pin(row)
    if (card && pinned && !card.contains(e.target)) hide()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') return hide()
    var row = rowOf(e.target)
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      pin(row)
    }
  })
  window.addEventListener('scroll', function () {
    if (activeRow && card && card.classList.contains('is-open')) place(activeRow)
  }, { passive: true })
})()
