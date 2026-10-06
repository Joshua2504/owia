// Prüf-Modus (/pruefen, routes/review.ts): offene Entwürfe einzeln nacheinander
// durchgehen – Fotos prüfen/schwärzen (photo-edit.js, mit Kennzeichen-Abgleich
// im Dialog), fehlende Angaben ergänzen, einreichen, überspringen oder in den
// Papierkorb. Für Handy/Bahn: eine Karte, große Knöpfe unten, der nächste
// Entwurf wird im Hintergrund vorgeladen.
//
// Daten: GET /pruefen/:az/daten (JSON). Schreiben über die bestehenden
// Endpunkte: PATCH /anzeige/:az/felder (je Feld), POST /anzeige/:az/submit,
// POST /anzeige/:az/discard, POST /anzeige/:az/tatort-aus-fotos (alle mit
// Accept: JSON). Die serverseitigen Prüfungen bleiben maßgeblich.
//
// Schnittstellen zu den geteilten Skripten:
//   - Karte trägt [data-review-card][data-az] und Fotos mit data-photo-edit /
//     data-full-src / data-geprueft / data-detected-plate – genau das, was
//     photo-edit.js in der Listenzeile erwartet (rowOf() kennt beide).
//   - window.reportTableRefresh(az): von photo-edit.js (nach Bestätigen) und
//     report-modal.js (Editor geschlossen) aufgerufen → Karte neu laden.
//   - Übersprungene merkt sich sessionStorage, damit ein Reload (Funkloch)
//     nicht wieder bei ihnen anfängt; am Ende lassen sie sich erneut ansehen.
;(function () {
  var root = document.getElementById('review-root')
  var dataEl = document.getElementById('review-data')
  if (!root || !dataEl) return
  var init = JSON.parse(dataEl.textContent)
  if (!init.queue.length) return

  var SKIP_KEY = 'owia-review-skip:' + location.search
  var AUTO_KEY = 'owia-review-autophoto'
  function store(kind, key, val) {
    try {
      if (val === undefined) return window[kind].getItem(key)
      window[kind].setItem(key, val)
    } catch (_) {
      return null
    }
  }

  var skipped = []
  try { skipped = JSON.parse(store('sessionStorage', SKIP_KEY) || '[]') } catch (_) {}
  skipped = skipped.filter(function (az) { return init.queue.indexOf(az) !== -1 })
  var remaining = init.queue.filter(function (az) { return skipped.indexOf(az) === -1 })
  var stats = { submitted: 0, trashed: 0 }
  var cache = {} // az → Promise<Daten>
  var cur = null // { az, data }
  var pending = Promise.resolve() // laufende Feld-Speicherungen
  var busy = false

  var autoBox = document.getElementById('review-autophoto')
  autoBox.checked = store('localStorage', AUTO_KEY) !== '0'
  autoBox.addEventListener('change', function () { store('localStorage', AUTO_KEY, autoBox.checked ? '1' : '0') })

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function compact(v) {
    return String(v || '').toLocaleUpperCase('de-DE').replace(/[^A-Z0-9ÄÖÜ]/g, '')
  }
  function saveSkipped() {
    store('sessionStorage', SKIP_KEY, JSON.stringify(skipped))
  }

  function json(url, opts) {
    opts = opts || {}
    opts.headers = Object.assign({ Accept: 'application/json' }, opts.headers || {})
    return fetch(url, opts).then(function (r) {
      // Abgelaufene Sitzung: requireAuth leitet auf die Login-Seite um.
      if (r.redirected) throw new Error('Bitte neu anmelden.')
      return r.json().catch(function () { return {} }).then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Fehler ' + r.status)
        return d
      })
    }, function () {
      throw new Error('Keine Verbindung – bitte erneut versuchen.')
    })
  }

  function load(az, fresh) {
    if (fresh || !cache[az]) {
      cache[az] = json('/pruefen/' + encodeURIComponent(az) + '/daten')
      cache[az].catch(function () { delete cache[az] })
    }
    return cache[az]
  }

  // Nächsten Entwurf samt erstem Foto vorladen – im Funkloch ist er dann schon da.
  function prefetch() {
    var az = remaining[1]
    if (!az) return
    load(az).then(function (d) {
      if (!d.images) return
      var first = d.images.filter(function (i) { return !i.ok })[0] || d.images[0]
      d.images.forEach(function (i) { new Image().src = i.thumb })
      if (first) new Image().src = first.full
    }, function () {})
  }

  function updateHead() {
    var done = stats.submitted + stats.trashed + skipped.length
    var total = done + remaining.length
    document.getElementById('review-pos').textContent = remaining.length
      ? 'Entwurf ' + (done + 1) + ' von ' + total
      : 'Fertig'
    var parts = []
    if (stats.submitted) parts.push('✓ ' + stats.submitted + ' eingereicht')
    if (skipped.length) parts.push('⏭ ' + skipped.length + ' übersprungen')
    if (stats.trashed) parts.push('🗑 ' + stats.trashed + ' im Papierkorb')
    document.getElementById('review-stats').textContent = parts.join(' · ')
    document.querySelector('.review-progress-bar').style.width = (total ? (100 * done) / total : 100) + '%'
  }

  function show() {
    updateHead()
    if (!remaining.length) return renderDone()
    var az = remaining[0]
    cur = null
    destroyMap()
    root.innerHTML = '<div class="card shadow-sm"><div class="card-body text-muted">' + esc(az) + ' wird geladen …</div></div>'
    return load(az).then(function (d) {
      if (remaining[0] !== az) return
      // In einem anderen Tab schon eingereicht/gelöscht: einfach weiter.
      if (d.gone) {
        remaining.shift()
        return show()
      }
      cur = { az: az, data: d }
      render()
      prefetch()
      maybeOpenPhotos()
    }, function (err) {
      if (remaining[0] !== az) return
      root.innerHTML = '<div class="alert alert-danger">' + esc(err.message) +
        ' <button type="button" class="btn btn-sm btn-outline-danger ms-2" data-act="retry">Erneut laden</button></div>'
    })
  }

  function maybeOpenPhotos() {
    if (!autoBox.checked || !window.photoEditor) return
    var t = root.querySelector('[data-photo-edit][data-geprueft="0"]')
    if (t) window.photoEditor.openThumb(t)
  }

  function photosHtml(d) {
    if (!d.images.length) return '<div class="small text-muted mb-2">Keine Fotos.</div>'
    var open = d.images.filter(function (i) { return !i.ok }).length
    var html = '<div class="review-photos">'
    d.images.forEach(function (im) {
      html += '<span class="review-photo ' + (im.ok ? 'is-geprueft' : 'is-ungeprueft') + '">' +
        '<img src="' + esc(im.thumb) + '" alt="Beweisfoto" decoding="async"' +
        ' data-photo-edit="' + esc(im.put) + '" data-full-src="' + esc(im.full) + '"' +
        ' data-geprueft="' + (im.ok ? 1 : 0) + '"' +
        (im.detected ? ' data-detected-plate="' + esc(im.detected) + '"' : '') +
        ' title="' + (im.ok ? 'Geprüft' : 'Noch nicht geprüft') + ' – antippen zum Prüfen/Schwärzen">' +
        '<span class="thumb-check" aria-hidden="true">' + (im.ok ? '✓' : '?') + '</span></span>'
    })
    html += '</div>'
    if (open) {
      html += '<button type="button" class="btn btn-warning w-100 mb-3" data-review-photos>📷 ' +
        (open === 1 ? 'Foto' : open + ' Fotos') + ' prüfen &amp; schwärzen</button>'
    } else {
      html += '<div class="small text-success mb-3">✓ Alle Fotos geprüft – antippen, um nochmal zu schwärzen.</div>'
    }
    return html
  }

  function problemsHtml(d) {
    if (!d.problems.length) {
      return '<div class="alert alert-success py-2 small mb-0">Bereit zum Einreichen' +
        (d.verjaehrung ? ' – verjährt in ' + d.verjaehrung.restTage + ' Tag(en)' : '') + '.</div>'
    }
    return '<div class="alert alert-warning py-2 small mb-0"><strong>Noch nicht einreichbar:</strong><ul class="mb-0 ps-3">' +
      d.problems.map(function (p) {
        return '<li>' + esc(p.kind === 'photos' ? 'Fotos noch nicht geprüft – oben antippen, bei Bedarf schwärzen und bestätigen.' : p.message) +
          (p.link ? ' <a href="' + esc(p.link) + '" target="_blank">Öffnen →</a>' : '') + '</li>'
      }).join('') + '</ul></div>'
  }

  // Schnellauswahl wie im Editor (reports/edit.ejs).
  var BEHINDERUNG_VORSCHLAEGE = [
    'Ich musste auf die Straße ausweichen.',
    'Ich musste auf den Gehweg ausweichen.',
    'Ich musste mit dem Rad auf die Fahrbahn ausweichen.',
    'Fußgänger mussten auf die Straße ausweichen.',
    'Rollstuhlfahrer bzw. Kinderwagen kamen nicht vorbei.',
  ]

  function fmtDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
    return m ? m[3] + '.' + m[2] + '.' + m[1] : iso
  }
  function photoSpan(t) {
    if (t.vonTag !== t.bisTag) return fmtDay(t.vonTag) + ' ' + t.von + ' – ' + fmtDay(t.bisTag) + ' ' + t.bis
    return fmtDay(t.vonTag) + ', ' + t.von + (t.bis !== t.von ? ' – ' + t.bis : '') + ' Uhr'
  }

  // ---- Tatort-Karte (Leaflet, wie report-map.js im Editor) ------------------
  // report-map.js hängt fest an #tatort-map beim Seitenladen; hier wird pro
  // Karte neu gebaut. Marker ziehen → Reverse-Geocoding → Tatort + Koordinaten
  // speichern; Adressvorschlag/Standort/Fotos → Marker versetzen.
  var map = null
  var marker = null
  var boundaries = null // GeoJSON der freigeschalteten Städte, einmal geladen
  if (window.L && L.Icon && L.Icon.Default) {
    var lbase = '/public/vendor/leaflet/images/'
    L.Icon.Default.mergeOptions({ iconRetinaUrl: lbase + 'marker-icon-2x.png', iconUrl: lbase + 'marker-icon.png', shadowUrl: lbase + 'marker-shadow.png' })
  }
  function validCoord(v) {
    return typeof v === 'number' && isFinite(v) && v !== 0
  }
  function photoIcon(url) {
    return L.divIcon({
      className: 'photo-marker',
      html: '<img src="' + encodeURI(url) + '" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;border:2px solid #0d6efd;box-shadow:0 1px 4px rgba(0,0,0,.45)">',
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    })
  }
  function destroyMap() {
    if (map) map.remove()
    map = null
    marker = null
  }
  function initMap(d) {
    destroyMap()
    var el = root.querySelector('[data-map]')
    if (!el || !window.L) {
      if (el) el.hidden = true
      return
    }
    var f = d.fields
    var has = validCoord(f.tatort_lat) && validCoord(f.tatort_lon)
    var city = init.cities.filter(function (c) { return c.id === f.city })[0] || init.cities[0] || { lat: 50.1109, lon: 8.6821 }
    map = L.map(el).setView(has ? [f.tatort_lat, f.tatort_lon] : [city.lat, city.lon], has ? 17 : 13)
    L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }).addTo(map)
    if (!boundaries) {
      boundaries = fetch('/api/geo/boundaries', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null })
        .catch(function () { return null })
    }
    var m = map
    boundaries.then(function (g) {
      if (g && map === m) {
        L.geoJSON(g, { interactive: false, style: { color: '#6f42c1', weight: 2.5, dashArray: '6 4', fillColor: '#6f42c1', fillOpacity: 0.05 } }).addTo(m)
      }
    })
    setTimeout(function () { if (map === m) m.invalidateSize() }, 200)
    if (has) placeMarker(f.tatort_lat, f.tatort_lon, false)
    // Ohne Tatort: Klick in die Karte setzt den Marker.
    map.on('click', function (e) {
      if (marker) return
      placeMarker(e.latlng.lat, e.latlng.lng, false)
      markerMoved()
    })
  }
  function placeMarker(lat, lon, recenter) {
    if (!map) return
    var thumb = cur && cur.data.images[0] ? cur.data.images[0].thumb : null
    if (marker) marker.setLatLng([lat, lon])
    else {
      marker = L.marker([lat, lon], thumb ? { draggable: true, icon: photoIcon(thumb) } : { draggable: true }).addTo(map)
      marker.on('dragend', markerMoved)
    }
    if (recenter) map.setView([lat, lon], Math.max(map.getZoom(), 17))
  }
  // Marker gezogen: Adresse der Stelle holen und mit genau diesen Koordinaten
  // speichern (wie im Editor bleibt der Marker, wo er abgelegt wurde).
  function markerMoved() {
    var p = marker.getLatLng()
    var ort = root.querySelector('#rv-ort')
    fetch('/api/geo/reverse?lat=' + p.lat + '&lon=' + p.lng, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
      .then(function (data) {
        var label = data && data.result && data.result.label
        if (!ort || !ort.isConnected) return
        if (label) ort.value = label
        else msg('Zu dieser Stelle wurde keine Adresse gefunden – Position trotzdem gespeichert.', 'text-warning')
        saveField(ort, { tatort_lat: Number(p.lat.toFixed(6)), tatort_lon: Number(p.lng.toFixed(6)) })
      })
  }

  function render() {
    var d = cur.data
    var f = d.fields
    var az = cur.az
    var plates = []
    d.images.forEach(function (i) {
      if (i.detected && plates.indexOf(i.detected) === -1) plates.push(i.detected)
    })
    root.innerHTML =
      '<div class="card shadow-sm review-card" data-review-card data-az="' + esc(az) + '"><div class="card-body">' +
      '<div class="d-flex align-items-center gap-2 mb-2 flex-wrap">' +
      '<code class="fs-6">' + esc(az) + '</code>' +
      (d.bereit ? '<span class="badge text-bg-info">Bereit</span>' : '') +
      (d.verjaehrung ? '<span class="badge text-bg-warning">verjährt in ' + d.verjaehrung.restTage + ' T.</span>' : '') +
      '<a class="btn btn-sm btn-outline-secondary ms-auto" data-edit-modal href="/anzeige/' + encodeURIComponent(az) + '/bearbeiten">✏️ Editor</a>' +
      '</div>' +
      '<div data-photos>' + photosHtml(d) + '</div>' +
      '<div class="review-fields">' +
      '<div class="review-plate">' +
      '<label class="form-label small mb-1" for="rv-plate">Kennzeichen</label>' +
      '<input id="rv-plate" type="text" class="form-control plate-field' + (f.kennzeichen ? '' : ' is-invalid') + '" data-f="kennzeichen" data-inline-field="kennzeichen"' +
      ' value="' + esc(f.kennzeichen) + '" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
      plates.map(function (p) {
        return '<button type="button" class="btn btn-sm btn-outline-warning mt-1 me-1" data-plate-suggest="' + esc(p) + '">Erkannt: ' + esc(p) + ' übernehmen</button>'
      }).join('') +
      '</div>' +
      '<div><label class="form-label small mb-1" for="rv-marke">Marke</label>' +
      '<input id="rv-marke" type="text" class="form-control" data-f="fahrzeug_marke" data-inline-field="fahrzeug_marke" value="' + esc(f.fahrzeug_marke) + '" maxlength="100"></div>' +
      '<div class="review-time">' +
      '<div><label class="form-label small mb-1" for="rv-tag">Tattag</label>' +
      '<input id="rv-tag" type="date" class="form-control' + (f.tattag ? '' : ' is-invalid') + '" data-f="tattag" value="' + esc(f.tattag) + '"></div>' +
      '<div><label class="form-label small mb-1" for="rv-von">von</label>' +
      '<input id="rv-von" type="time" class="form-control' + (f.tatzeit_von ? '' : ' is-invalid') + '" data-f="tatzeit_von" value="' + esc(f.tatzeit_von) + '"></div>' +
      '<div><label class="form-label small mb-1" for="rv-tagbis" title="Nur wenn der Verstoß über Mitternacht andauerte">Tag bis</label>' +
      '<input id="rv-tagbis" type="date" class="form-control" data-f="tattag_bis" value="' + esc(f.tattag_bis) + '"></div>' +
      '<div><label class="form-label small mb-1" for="rv-bis">bis</label>' +
      '<input id="rv-bis" type="time" class="form-control" data-f="tatzeit_bis" value="' + esc(f.tatzeit_bis) + '"></div>' +
      '</div>' +
      (d.photoTimes ? '<div class="review-wide small text-muted">Fotos: ' + esc(photoSpan(d.photoTimes)) +
        ' <button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-act="photo-times">🕒 Uhrzeit aus Fotos übernehmen</button></div>' : '') +
      '<div class="review-wide"><label class="form-label small mb-1" for="rv-ort">Tatort</label>' +
      '<textarea id="rv-ort" rows="2" class="form-control' + (f.tatort ? '' : ' is-invalid') + '" data-f="tatort" data-geo-scope="unlocked" data-fill="full" data-ac-local' +
      ' placeholder="Adresse eingeben" autocomplete="off" spellcheck="false">' + esc(f.tatort) + '</textarea>' +
      '<div class="d-flex flex-wrap gap-3 mt-1 small">' +
      '<button type="button" class="btn btn-link btn-sm p-0" data-act="here">📍 Aktueller Standort</button>' +
      (d.hasGps ? '<button type="button" class="btn btn-link btn-sm p-0" data-act="tatort-fotos">🖼️ Tatort aus Fotos</button>' : '') +
      '</div>' +
      '<div class="review-map rounded border mt-2" data-map></div>' +
      '<div class="small text-muted mt-1">Marker zur genauen Stelle ziehen – die Adresse wird übernommen.</div>' +
      '</div>' +
      '<div class="review-wide"><label class="form-label small mb-1" for="rv-city">Zuständiges Ordnungsamt</label>' +
      '<select id="rv-city" class="form-select" data-f="city">' +
      init.cities.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === f.city ? ' selected' : '') + '>' + esc(c.name) + '</option>'
      }).join('') +
      '</select>' +
      '<div class="small text-muted mt-1" data-recipient>An: ' + esc(d.recipient.ordnungsamt) + (d.recipient.email ? ' (' + esc(d.recipient.email) + ')' : '') + '</div>' +
      '</div>' +
      '<div class="review-wide position-relative" data-verstoss-root><label class="form-label small mb-1" for="rv-verstoss">Verstoß</label>' +
      '<input type="hidden" data-f="verstoss_art" data-inline-field="verstoss_art" value="' + esc(f.verstoss_art) + '">' +
      '<textarea id="rv-verstoss" rows="2" class="form-control' + (f.verstoss_art ? '' : ' is-invalid') + '" data-verstoss-input placeholder="Verstoß suchen …">' + esc(f.verstoss_art) + '</textarea>' +
      '</div>' +
      '<div class="review-wide"><label class="form-label small mb-1" for="rv-beschreibung">Beschreibung <span class="text-muted">(optional)</span></label>' +
      '<textarea id="rv-beschreibung" rows="2" class="form-control" data-f="beschreibung" placeholder="Optionale Schilderung des Vorfalls">' + esc(f.beschreibung) + '</textarea></div>' +
      '<div class="review-wide d-flex flex-wrap align-items-center gap-3">' +
      '<label class="form-check mb-0"><input type="checkbox" class="form-check-input" data-f="fahrzeug_verlassen"' + (f.fahrzeug_verlassen ? ' checked' : '') + '> <span class="form-check-label">Fahrzeug war verlassen</span></label>' +
      '<span class="d-flex align-items-center gap-2"><span class="small">Wurde jemand behindert?</span>' +
      '<input type="hidden" data-f="behinderung" value="' + (f.behinderung ? '1' : '0') + '">' +
      '<span class="btn-group btn-group-sm" role="group" aria-label="Wurde jemand behindert?">' +
      '<input type="radio" class="btn-check" name="rv-behinderung" id="rv-beh-ja" value="1" data-behinderung' + (f.behinderung ? ' checked' : '') + '>' +
      '<label class="btn btn-outline-secondary" for="rv-beh-ja">Ja</label>' +
      '<input type="radio" class="btn-check" name="rv-behinderung" id="rv-beh-nein" value="0" data-behinderung' + (f.behinderung ? '' : ' checked') + '>' +
      '<label class="btn btn-outline-secondary" for="rv-beh-nein">Nein</label>' +
      '</span></span></div>' +
      '<div class="review-wide" data-behinderung-detail' + (f.behinderung ? '' : ' hidden') + '>' +
      '<label class="form-label small mb-1" for="rv-beh-text">Wer wurde wie behindert?</label>' +
      '<textarea id="rv-beh-text" rows="2" class="form-control' + (f.behinderung && !f.behinderung_text ? ' is-invalid' : '') + '" data-f="behinderung_text"' +
      ' placeholder="z. B. Rollstuhlfahrer musste auf die Straße ausweichen">' + esc(f.behinderung_text) + '</textarea>' +
      '<div class="d-flex flex-wrap gap-1 mt-1">' +
      BEHINDERUNG_VORSCHLAEGE.map(function (t) {
        return '<button type="button" class="btn btn-sm btn-outline-secondary" data-beh-vorschlag="' + esc(t) + '">' + esc(t) + '</button>'
      }).join('') +
      '</div></div>' +
      '</div>' +
      '<div data-problems>' + problemsHtml(d) + '</div>' +
      '</div></div>' +
      '<div class="review-actions">' +
      '<button type="button" class="btn btn-outline-danger" data-act="trash" title="In den Papierkorb (30 Tage wiederherstellbar)">🗑<span class="d-none d-sm-inline"> Papierkorb</span></button>' +
      '<button type="button" class="btn btn-outline-secondary" data-act="skip">⏭ Überspringen</button>' +
      '<button type="button" class="btn btn-success flex-grow-1" data-act="submit"' + (d.canSubmit ? '' : ' disabled') + '>✓ Einreichen</button>' +
      (document.body.hasAttribute('data-admin') ? '<button type="button" class="btn btn-primary" data-act="send"' + (d.canSubmit ? '' : ' disabled') + ' title="Prüfung direkt bestätigen und ans Ordnungsamt senden">📨<span class="d-none d-sm-inline"> Versenden</span></button>' : '') +
      '</div>' +
      '<div class="small mt-2 text-center" data-msg role="status"></div>'

    var vroot = root.querySelector('[data-verstoss-root]')
    if (window.verstossSelect) window.verstossSelect.init(vroot, init.verstoss)
    var ort = root.querySelector('#rv-ort')
    if (window.addressAutocomplete) window.addressAutocomplete.init(ort)
    initMap(d)
    root.querySelectorAll('[data-f]').forEach(function (el) {
      el.dataset.saved = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value
    })
    syncSuggest()
  }

  function msg(text, cls) {
    var m = root.querySelector('[data-msg]')
    if (!m) return
    m.textContent = text || ''
    m.className = 'small mt-2 text-center ' + (cls || 'text-muted')
  }

  // Nach Änderungen: Prüfliste, Fotos und Einreichen-Knopf auffrischen, ohne
  // die Eingabefelder neu zu bauen (Fokus/halb getippter Text bleiben).
  function refreshStatus() {
    if (!cur) return Promise.resolve()
    var az = cur.az
    return load(az, true).then(function (d) {
      if (!cur || cur.az !== az || d.gone) return
      cur.data = d
      root.querySelector('[data-photos]').innerHTML = photosHtml(d)
      root.querySelector('[data-problems]').innerHTML = problemsHtml(d)
      root.querySelectorAll('[data-act=submit],[data-act=send]').forEach(function (b) { b.disabled = !d.canSubmit })
      // Stadt kann der Server aus der Tatort-PLZ ändern.
      var sel = root.querySelector('[data-f=city]')
      if (sel && document.activeElement !== sel && d.fields.city) {
        sel.value = d.fields.city
        sel.dataset.saved = d.fields.city
      }
      var rec = root.querySelector('[data-recipient]')
      if (rec) rec.textContent = 'An: ' + d.recipient.ordnungsamt + (d.recipient.email ? ' (' + d.recipient.email + ')' : '')
    })
  }

  // Ein Feld speichern (nur wenn geändert). extra: zusätzliche Werte (Koordinaten).
  function saveField(el, extra) {
    if (!cur) return
    var az = cur.az
    var field = el.getAttribute('data-f')
    var value = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim()
    if (!extra && value === el.dataset.saved) return
    var body = extra || {}
    body[field] = value
    // Verstoß: Wert im versteckten Feld, sichtbar ist das Suchfeld.
    var shown = (el.type === 'hidden' && field === 'verstoss_art' && root.querySelector('[data-verstoss-input]')) || el
    shown.classList.remove('is-invalid')
    shown.classList.add('is-saving')
    var p = pending.then(function () {
      return json('/anzeige/' + encodeURIComponent(az) + '/felder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }).then(function (res) {
      var saved = res.values ? res.values[field] : value
      if (el.type === 'checkbox') el.dataset.saved = saved === '1' ? '1' : '0'
      else {
        el.dataset.saved = saved || ''
        if (document.activeElement !== el) el.value = saved || ''
      }
      if (field === 'verstoss_art') {
        var vis = root.querySelector('[data-verstoss-input]')
        if (vis) vis.value = el.value
      }
      shown.classList.remove('is-saving')
      return refreshStatus()
    }).catch(function (err) {
      shown.classList.remove('is-saving')
      shown.classList.add('is-invalid')
      msg(err.message, 'text-danger')
    })
    pending = p
    return p
  }

  function submit(sofort) {
    if (!cur || busy) return
    if (sofort && !confirm('Anzeige ohne weitere Prüfung direkt ans Ordnungsamt versenden?')) return
    var az = cur.az
    busy = true
    var btn = root.querySelector('[data-act=submit]')
    btn.disabled = true
    var send = root.querySelector('[data-act=send]')
    if (send) send.disabled = true
    btn.textContent = sofort ? 'Wird versendet …' : 'Wird eingereicht …'
    pending
      .then(function () { return json('/anzeige/' + encodeURIComponent(az) + '/submit' + (sofort ? '?sofort=1' : ''), { method: 'POST' }) })
      .then(function () {
        stats.submitted++
        remaining.shift()
        delete cache[az]
        show()
      }, function (err) {
        btn.textContent = '✓ Einreichen'
        msg(err.message, 'text-danger')
        return refreshStatus()
      })
      .finally(function () { busy = false })
  }

  function skip() {
    if (!cur || busy) return
    var az = remaining.shift()
    skipped.push(az)
    saveSkipped()
    show()
  }

  function trash() {
    if (!cur || busy) return
    var az = cur.az
    busy = true
    pending
      .then(function () { return json('/anzeige/' + encodeURIComponent(az) + '/discard', { method: 'POST' }) })
      .then(function () {
        stats.trashed++
        remaining.shift()
        delete cache[az]
        show()
      }, function (err) { msg(err.message, 'text-danger') })
      .finally(function () { busy = false })
  }

  function tatortFromPhotos(btn) {
    var az = cur.az
    btn.disabled = true
    btn.textContent = 'Adresse wird gesucht …'
    json('/anzeige/' + encodeURIComponent(az) + '/tatort-aus-fotos', { method: 'POST' })
      .then(function (d) {
        if (!cur || cur.az !== az) return
        var ort = root.querySelector('#rv-ort')
        ort.value = d.tatort
        ort.dataset.saved = d.tatort
        ort.classList.remove('is-invalid')
        btn.disabled = false
        btn.textContent = '🖼️ Tatort aus Fotos'
        return refreshStatus().then(function () {
          var f = cur && cur.data.fields
          if (f && validCoord(f.tatort_lat) && validCoord(f.tatort_lon)) placeMarker(f.tatort_lat, f.tatort_lon, true)
        })
      })
      .catch(function (err) {
        btn.disabled = false
        btn.textContent = '🖼️ Tatort aus Fotos'
        msg(err.message, 'text-danger')
      })
  }

  // „Uhrzeit aus Fotos": von = frühestes, bis = spätestes Foto (wie report-form.js).
  function applyPhotoTimes() {
    var t = cur && cur.data.photoTimes
    if (!t) return
    var set = function (sel, v) {
      var el = root.querySelector(sel)
      el.value = v
      el.classList.remove('is-invalid')
      saveField(el)
    }
    set('[data-f=tattag]', t.vonTag)
    set('[data-f=tatzeit_von]', t.von)
    set('[data-f=tattag_bis]', t.bisTag !== t.vonTag ? t.bisTag : '')
    set('[data-f=tatzeit_bis]', t.bis !== t.von || t.bisTag !== t.vonTag ? t.bis : '')
  }

  function currentLocation(btn) {
    if (!navigator.geolocation) return msg('Standort wird von diesem Browser nicht unterstützt.', 'text-danger')
    var az = cur.az
    btn.disabled = true
    msg('Standort wird ermittelt …')
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude
      var lon = pos.coords.longitude
      fetch('/api/geo/reverse?lat=' + lat + '&lon=' + lon, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null })
        .catch(function () { return null })
        .then(function (data) {
          btn.disabled = false
          if (!cur || cur.az !== az) return
          var label = data && data.result && data.result.label
          if (!label) return msg('Zu diesem Standort wurde keine Adresse gefunden.', 'text-warning')
          var ort = root.querySelector('#rv-ort')
          ort.value = label
          placeMarker(lat, lon, true)
          saveField(ort, { tatort_lat: Number(lat.toFixed(6)), tatort_lon: Number(lon.toFixed(6)) })
          msg('Adresse übernommen – bitte prüfen.')
        })
    }, function () {
      btn.disabled = false
      msg('Standort nicht verfügbar (Berechtigung?).', 'text-danger')
    }, { enableHighAccuracy: true, timeout: 15000 })
  }

  function renderDone() {
    cur = null
    destroyMap()
    var html = '<div class="card shadow-sm"><div class="card-body text-center py-5">' +
      '<p class="fs-5 mb-1">Durch! 🎉</p><p class="text-muted">' +
      stats.submitted + ' eingereicht' +
      (stats.trashed ? ', ' + stats.trashed + ' in den Papierkorb' : '') +
      (skipped.length ? ', ' + skipped.length + ' übersprungen' : '') + '.</p>' +
      '<div class="d-flex flex-wrap justify-content-center gap-2">'
    if (skipped.length) html += '<button type="button" class="btn btn-primary" data-act="again">Übersprungene nochmal ansehen</button>'
    html += '<a class="btn btn-outline-secondary" href="/anzeigen">Zu meinen Anzeigen</a></div></div></div>'
    root.innerHTML = html
  }

  // photo-edit.js (nach Bestätigen/Löschen) und report-modal.js (Editor zu).
  // Nach dem Editor können sich alle Felder geändert haben → ganze Karte neu.
  window.reportTableRefresh = function (az) {
    if (!cur || cur.az !== az) return Promise.resolve()
    var editorOpen = document.querySelector('dialog.editor-dialog[open]')
    return pending.then(function () { return load(az, true) }).then(function (d) {
      if (!cur || cur.az !== az) return
      if (d.gone) {
        remaining.shift()
        return show()
      }
      cur.data = d
      // Aus dem Foto-Dialog: nur Fotos/Prüfliste – sonst gingen halb getippte
      // Feldwerte verloren. Kennzeichen setzt photo-edit.js selbst.
      if (document.querySelector('dialog.photo-edit-dialog[open]') && !editorOpen) {
        root.querySelector('[data-photos]').innerHTML = photosHtml(d)
        root.querySelector('[data-problems]').innerHTML = problemsHtml(d)
        root.querySelectorAll('[data-act=submit],[data-act=send]').forEach(function (b) { b.disabled = !d.canSubmit })
      } else render()
    })
  }

  root.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('[data-behinderung]')) {
      var on = e.target.value === '1'
      var hid = root.querySelector('[data-f=behinderung]')
      hid.value = on ? '1' : '0'
      root.querySelector('[data-behinderung-detail]').hidden = !on
      saveField(hid)
      if (on) root.querySelector('[data-f=behinderung_text]').focus()
      return
    }
    var el = e.target.closest('[data-f]')
    if (!el || el.getAttribute('data-f') === 'tatort') return
    saveField(el)
  })
  // Verstoß: verstoss-select.js meldet die Auswahl per change am versteckten
  // Feld – bubblet ebenfalls bis root (oben abgedeckt).
  root.addEventListener('focusout', function (e) {
    // Tatort beim Verlassen speichern; kurz warten, falls gerade ein
    // Adressvorschlag angetippt wird (der speichert dann mit Koordinaten).
    var el = e.target
    if (!el.matches || !el.matches('[data-f=tatort]')) return
    setTimeout(function () {
      if (!el.isConnected || el.dataset.chosen) return
      saveField(el)
    }, 250)
  })
  root.addEventListener('address:chosen', function (e) {
    var el = e.target
    if (!el.matches || !el.matches('[data-f=tatort]')) return
    el.dataset.chosen = '1'
    var s = e.detail || {}
    var extra = Number.isFinite(s.lat) && Number.isFinite(s.lon) ? { tatort_lat: s.lat, tatort_lon: s.lon } : {}
    if (extra.tatort_lat) placeMarker(s.lat, s.lon, true)
    var p = saveField(el, extra)
    Promise.resolve(p).then(function () { delete el.dataset.chosen })
  })
  root.addEventListener('keydown', function (e) {
    // Enter im Kennzeichen/Marke-Feld = speichern (Feld verlassen).
    if (e.key === 'Enter' && e.target.matches && e.target.matches('input[data-f]')) {
      e.preventDefault()
      e.target.blur()
    }
    // Kein Zeilenumbruch im Verstoß-Suchfeld (Auswahl übernimmt verstoss-select.js).
    if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-verstoss-input]')) e.preventDefault()
  })
  root.addEventListener('click', function (e) {
    var t = e.target.closest('[data-photo-edit]')
    if (t && window.photoEditor) {
      window.photoEditor.openThumb(t)
      return
    }
    var vb = e.target.closest('[data-beh-vorschlag]')
    if (vb) {
      var ta = root.querySelector('[data-f=behinderung_text]')
      var satz = vb.getAttribute('data-beh-vorschlag')
      var now = ta.value.trim()
      if (now.indexOf(satz) === -1) ta.value = now ? now + ' ' + satz : satz
      saveField(ta)
      return
    }
    var sug = e.target.closest('[data-plate-suggest]')
    if (sug) {
      var plate = root.querySelector('[data-f=kennzeichen]')
      plate.value = sug.getAttribute('data-plate-suggest')
      syncSuggest()
      saveField(plate)
      return
    }
    var b = e.target.closest('[data-act]')
    if (!b) return
    var act = b.getAttribute('data-act')
    if (act === 'submit') submit()
    if (act === 'send') submit(true)
    else if (act === 'skip') skip()
    else if (act === 'trash') trash()
    else if (act === 'retry') show()
    else if (act === 'tatort-fotos') tatortFromPhotos(b)
    else if (act === 'here') currentLocation(b)
    else if (act === 'photo-times') applyPhotoTimes()
    else if (act === 'again') {
      remaining = skipped
      skipped = []
      saveSkipped()
      show()
    }
  })
  // „Erkannt: …"-Vorschläge ausblenden, die dem aktuellen Kennzeichen entsprechen.
  function syncSuggest() {
    var el = root.querySelector('[data-f=kennzeichen]')
    if (!el) return
    root.querySelectorAll('[data-plate-suggest]').forEach(function (b) {
      b.hidden = compact(b.getAttribute('data-plate-suggest')) === compact(el.value)
    })
  }
  root.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('[data-f=kennzeichen]')) syncSuggest()
  })
  // Kennzeichen im Foto-Dialog geändert: Prüfliste auffrischen.
  document.addEventListener('owia:plate-changed', function (e) {
    if (cur && e.detail && e.detail.az === cur.az) {
      syncSuggest()
      var el = root.querySelector('[data-f=kennzeichen]')
      if (el) el.classList.toggle('is-invalid', !e.detail.kennzeichen)
      if (!document.querySelector('dialog.photo-edit-dialog[open]')) refreshStatus()
    }
  })

  show()
})()
