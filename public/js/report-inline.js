// Inline-Bearbeitung in der Anzeigen-Liste (report-row.ejs): Kennzeichen,
// Fahrzeugmarke und Verstoß eines Entwurfs direkt in der Zeile ändern.
// Gespeichert wird beim Verlassen des Feldes bzw. bei Enter/Auswahl über
// PATCH /anzeige/:az/felder (nur das geänderte Feld – nicht das Autosave des
// Editors, das immer alle Felder schreibt).
//
// Event-Delegation am Dokument: Zeilen, die report-table.js/report-modal.js
// ohne Reload ersetzen, funktionieren ohne Nachrüsten.
;(function () {
  if (!document.querySelector('.report-table')) return

  // Verstoß-Katalog erst beim ersten Fokus laden (~55 KB) und dann teilen.
  var catalog = null
  function loadCatalog() {
    if (!catalog) {
      catalog = fetch('/anzeigen/bearbeitungsoptionen', { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok || r.redirected) throw new Error()
          return r.json()
        })
        .then(function (d) { return { alle: d.offenses || [], haeufig: d.frequent || [] } })
        .catch(function () { catalog = null; throw new Error('Verstoß-Katalog nicht ladbar.') })
    }
    return catalog
  }

  function rowOf(el) { return el.closest('tr[data-az]') }

  function setState(el, state, message) {
    var target = el.type === 'hidden' ? el.parentNode.querySelector('[data-verstoss-input]') : el
    target.classList.remove('is-saving', 'is-saved', 'is-invalid')
    if (state) target.classList.add(state)
    target.title = message || (el.type === 'hidden' ? el.value : '')
    if (state === 'is-saved') setTimeout(function () { target.classList.remove('is-saved') }, 1400)
  }

  // extra: zusätzliche Felder (Koordinaten eines gewählten Adressvorschlags).
  function save(el, extra) {
    var row = rowOf(el)
    if (!row) return
    var field = el.getAttribute('data-inline-field')
    var value = el.value
    if (field === 'kennzeichen') value = value.toLocaleUpperCase('de-DE').replace(/\s+/g, ' ').trim()
    else value = value.replace(/\s+/g, ' ').trim()
    // Unverändert (z.B. nur durch das Feld getabbt) → kein Request.
    if (!extra && value === (el.dataset.saved !== undefined ? el.dataset.saved : el.defaultValue)) {
      el.value = value
      return
    }
    var body = extra || {}
    body[field] = value
    setState(el, 'is-saving')
    fetch('/anzeige/' + encodeURIComponent(row.dataset.az) + '/felder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (r.redirected) throw new Error('Bitte neu anmelden.')
        return r.json().then(function (d) { return { ok: r.ok, d: d } })
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Speichern fehlgeschlagen.')
        var saved = res.d.values && res.d.values[field]
        el.value = saved || ''
        el.dataset.saved = el.value
        if (field === 'verstoss_art') {
          var vis = el.parentNode.querySelector('[data-verstoss-input]')
          if (vis) vis.value = el.value
        }
        setState(el, 'is-saved')
        document.dispatchEvent(new Event('reports:updated'))
        // Tatort mit neuen Koordinaten: Zeile neu laden (Karten-Icon, „aus Fotos").
        if (field === 'tatort') {
          el.classList.toggle('is-missing', !el.value)
          if (extra && window.reportTableRefresh) setTimeout(function () { window.reportTableRefresh(row.dataset.az).catch(function () {}) }, 900)
        }
      })
      .catch(function (err) {
        setState(el, 'is-invalid', err.message + ' – erneut versuchen.')
      })
  }

  // Kennzeichen/Marke: speichern beim Verlassen; Enter = speichern + nächstes
  // Feld derselben Spalte (schnelles Abarbeiten einer Liste), Escape = zurück.
  document.addEventListener('change', function (e) {
    var el = e.target
    if (el.matches && el.matches('input[data-inline-field], textarea[data-inline-field]')) save(el)
  })
  document.addEventListener('input', function (e) {
    var el = e.target
    if (el.matches && el.matches('input[data-inline-field="kennzeichen"]')) {
      // Nur Großschreibung – kein Länderformat erzwingen (Roller, Ausland …).
      var pos = el.selectionStart
      var up = el.value.toLocaleUpperCase('de-DE')
      if (up !== el.value) {
        el.value = up
        try { el.setSelectionRange(pos, pos) } catch (_) {}
      }
    }
  })
  document.addEventListener('keydown', function (e) {
    var el = e.target
    if (!el.matches) return
    if (el.matches('textarea[data-verstoss-input]') && e.key === 'Enter') {
      e.preventDefault() // kein Zeilenumbruch im Suchfeld; Auswahl übernimmt verstoss-select.js
      return
    }
    if (!el.matches('input[data-inline-field], textarea[data-inline-field]')) return
    if (e.key === 'Escape') {
      el.value = el.dataset.saved !== undefined ? el.dataset.saved : el.defaultValue
      el.blur()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      var field = el.getAttribute('data-inline-field')
      var row = rowOf(el)
      var next = row && row.nextElementSibling
      while (next && next.hidden) next = next.nextElementSibling
      var target = next && next.querySelector('[data-inline-field="' + field + '"]')
      if (target) target.focus()
      else el.blur()
    }
  })

  // Tatort: Adressvorschläge beim ersten Fokus aktivieren; Auswahl eines
  // Vorschlags speichert Adresse + Koordinaten (+ Stadt, serverseitig aus der PLZ).
  // Frei getippter Text wird beim Verlassen ohne Koordinaten gespeichert.
  document.addEventListener('focusin', function (e) {
    var el = e.target
    if (el.matches && el.matches('textarea[data-inline-field="tatort"]') && window.addressAutocomplete) {
      window.addressAutocomplete.init(el)
    }
  })
  document.addEventListener('address:chosen', function (e) {
    var el = e.target
    if (!el.matches || !el.matches('[data-inline-field="tatort"]')) return
    var s = e.detail || {}
    var extra = Number.isFinite(s.lat) && Number.isFinite(s.lon) ? { tatort_lat: s.lat, tatort_lon: s.lon } : {}
    save(el, extra)
  })

  // ---------------------------------------------------------------------------
  // Karten-Vorschau: Hover über 🗺️ zeigt eine kleine Karte mit dem Tatort.
  // Leaflet wird erst beim ersten Hover geladen (Seiten ohne Übersichtskarte).
  // ---------------------------------------------------------------------------
  var peek = null
  var peekMap = null
  var peekMarker = null
  var peekTimer = null
  var peekHide = null
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
        js.onload = resolve
        js.onerror = reject
        document.head.appendChild(js)
      })
    }
    return leafletLoading
  }

  function showPeek(btn) {
    var lat = Number(btn.dataset.lat)
    var lon = Number(btn.dataset.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    loadLeaflet().then(function () {
      if (!peek) {
        peek = document.createElement('div')
        peek.className = 'map-peek-pop'
        peek.innerHTML = '<div class="map-peek-map"></div>'
        document.body.appendChild(peek)
        peek.addEventListener('mouseenter', function () { clearTimeout(peekHide) })
        peek.addEventListener('mouseleave', hidePeekSoon)
      }
      var r = btn.getBoundingClientRect()
      var w = 340
      var h = 240
      var left = Math.min(r.right + 8, window.innerWidth - w - 8)
      if (left < r.right && r.left - w - 8 > 8) left = r.left - w - 8
      var top = Math.min(Math.max(8, r.top - h / 2), window.innerHeight - h - 8)
      peek.style.left = left + 'px'
      peek.style.top = top + 'px'
      peek.classList.add('is-visible')
      if (!peekMap) {
        peekMap = L.map(peek.querySelector('.map-peek-map'), { zoomControl: false, attributionControl: false })
        L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(peekMap)
        // circleMarker statt L.marker: das Standard-Icon findet beim Nachladen
        // von Leaflet seinen Bildpfad nicht (kaputtes Bild).
        peekMarker = L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#dc3545', fillOpacity: 1 }).addTo(peekMap)
      }
      peekMap.invalidateSize()
      peekMap.setView([lat, lon], 17)
      peekMarker.setLatLng([lat, lon])
    }).catch(function () {})
  }
  function hidePeekSoon() {
    clearTimeout(peekHide)
    peekHide = setTimeout(function () { if (peek) peek.classList.remove('is-visible') }, 200)
  }
  document.addEventListener('mouseover', function (e) {
    var btn = e.target.closest && e.target.closest('[data-map-peek]')
    if (!btn) return
    clearTimeout(peekHide)
    clearTimeout(peekTimer)
    peekTimer = setTimeout(function () { showPeek(btn) }, 150)
  })
  document.addEventListener('mouseout', function (e) {
    var btn = e.target.closest && e.target.closest('[data-map-peek]')
    if (!btn) return
    clearTimeout(peekTimer)
    hidePeekSoon()
  })
  // Touch: Tippen zeigt/verbirgt die Karte.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-map-peek]')
    if (!btn) return
    if (peek && peek.classList.contains('is-visible')) peek.classList.remove('is-visible')
    else showPeek(btn)
  })

  // „Tatort fehlt" → Tatort aus den GPS-Daten der Fotos übernehmen (Server
  // ermittelt Adresse + zuständige Stadt), danach Zeile neu laden.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-tatort-from-photos]')
    if (!btn) return
    var row = rowOf(btn)
    btn.disabled = true
    btn.textContent = 'Wird ermittelt …'
    fetch('/anzeige/' + encodeURIComponent(row.dataset.az) + '/tatort-aus-fotos', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Übernahme fehlgeschlagen.')
        return window.reportTableRefresh(row.dataset.az)
      })
      .catch(function (err) {
        btn.disabled = false
        btn.textContent = '📍 aus Fotos übernehmen'
        btn.title = err.message
        alert(err.message)
      })
  })

  // Verstoß: Auswahlfeld lazy initialisieren und gewählte Einträge speichern.
  document.addEventListener('focusin', function (e) {
    var input = e.target
    if (!input.matches || !input.matches('[data-inline-verstoss] [data-verstoss-input]')) return
    var root = input.closest('[data-inline-verstoss]')
    // Ausgangswert merken: Bei <input type="hidden"> ändert das Setzen von
    // .value auch defaultValue – ohne diesen Merker hielt save() jede Auswahl
    // für „unverändert" und speicherte den Verstoß nie.
    var hidden = root.querySelector('input[type="hidden"]')
    if (hidden.dataset.saved === undefined) hidden.dataset.saved = hidden.value
    if (root.dataset.verstossReady) return
    loadCatalog().then(function (data) {
      if (!window.verstossSelect || root.dataset.verstossReady) return
      // Auswahl löst change am versteckten Feld aus → Speichern über den
      // change-Handler oben (input[data-inline-field]).
      window.verstossSelect.init(root, data)
      // Fokus ist schon da – Liste jetzt öffnen.
      if (document.activeElement === input) input.dispatchEvent(new Event('focus'))
    }).catch(function (err) {
      input.classList.add('is-invalid')
      input.title = err.message
    })
  })
})()
