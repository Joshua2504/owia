// Foto-Prüfung in der Anzeigen-Liste: Jedes Entwurfs-Foto startet ungeprüft.
// Klick aufs Foto (data-photo-edit, s. image-preview.js) öffnet es hier als
// Vollbild-Dialog; man schwärzt/verpixelt/schneidet bei Bedarf und bestätigt –
// danach öffnet sich automatisch das nächste ungeprüfte Foto derselben Anzeige.
// Einreichen ist erst möglich, wenn alle Fotos bestätigt sind (Server prüft).
// Gespeichert wird wie im
// Editor (report-form.js): Leinwand → JPEG → PUT /anzeige/:az/images/:id
// (neue Fassung, das Original bleibt auf dem Server erhalten). Danach lädt
// report-table.js die Zeile neu (neue Vorschaubilder).
//
// Bewusst eigenständig statt report-form.js wiederzuverwenden: dessen
// Leinwand-Code hängt an den Editor-Karten (Autosave, Upload-Status, Karte).
//
// Kennzeichen-Abgleich: Bei Entwürfen stehen Kennzeichen, Marke und Verstoß der
// Anzeige im Dialog-Kopf (Wert aus dem Feld [data-inline-field=kennzeichen] der Zeile bzw.
// Prüf-Karte) – man sieht das Foto und korrigiert es direkt. Gespeichert wird
// über PATCH /anzeige/:az/felder, beim Bestätigen/Schließen bzw. mit Enter im
// Feld; danach feuert document das Event 'owia:plate-changed' {az, kennzeichen}.
// data-detected-plate am Foto (ALPR-Ergebnis dieses Fotos) wird als
// Übernehmen-Vorschlag angeboten, wenn es abweicht.
//
// Ein Prüf-Lauf für beide Modi: Kopfzeile mit Kennzeichen, Marke, Verstoß,
// Tatort; Statuszeile mit der Prüfliste der Anzeige und „Einreichen". In der
// Liste schließt der Dialog nach dem Einreichen. Im Prüf-Modus (/pruefen)
// setzt review.js window.photoEditorRun = { label(), done(az, action) } –
// dann gibt es zusätzlich Überspringen/Verwerfen und es geht mit der nächsten
// Anzeige weiter (action: 'submitted' | 'skipped' | 'trashed').
;(function () {
  var MAX_DIM = 2560 // wie report-form.js
  var MIN_BOX = 6

  var dlg = null
  var canvas = null
  var ctx = null
  var state = null // { put, az, base, redactions, history, tool, dirty, ok }

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text) e.textContent = text
    return e
  }

  function build() {
    dlg = el('dialog', 'photo-edit-dialog')
    dlg.setAttribute('aria-label', 'Foto bearbeiten')
    dlg.innerHTML =
      '<div class="photo-edit-head">' +
      '<div class="ms-auto d-flex align-items-center gap-2">' +
      '<span class="photo-edit-status small"></span>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="move-menu" title="Foto(s) in eine neue oder andere Anzeige verschieben – mehrere über die Häkchen an den Kacheln">↗ Verschieben</button>' +
      '<button type="button" class="btn btn-sm btn-outline-danger" data-act="delete" title="Foto aus dem Entwurf löschen">🗑</button>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="cancel">Schließen</button>' +
      '<button type="button" class="btn btn-sm btn-success" data-act="save" title="Enter">✓ Bestätigen</button>' +
      '</div>' +
      '</div>' +
      // Zielauswahl für „Verschieben" (fest positioniert unter dem Knopf).
      '<div class="photo-edit-move-menu shadow" data-bs-theme="light" hidden>' +
      '<div class="small fw-semibold mb-2" data-move-title></div>' +
      '<button type="button" class="btn btn-sm btn-primary w-100 mb-2" data-move-new>➕ In eine neue Anzeige</button>' +
      '<input type="search" class="form-control form-control-sm mb-2" data-move-search placeholder="Entwurf suchen (Kennzeichen, Ort, Aktenzeichen) …">' +
      '<div class="list-group list-group-flush" data-move-list></div>' +
      '</div>' +
      '<div class="photo-edit-body">' +
      '<div class="photo-edit-strip" aria-label="Alle Fotos der Anzeige"></div>' +
      '<div class="photo-edit-stage">' +
      '<div class="photo-edit-canvas"><canvas></canvas><div class="photo-edit-msg"></div></div>' +
      // Bildwerkzeuge unten mittig unter dem Foto (nicht darüber – sonst
      // ließe sich am unteren Bildrand nicht schwärzen).
      '<div class="photo-edit-tools">' +
      '<span class="photo-edit-hint small"></span>' +
      '<div class="d-flex flex-wrap justify-content-center gap-2">' +
      '<div class="btn-group btn-group-sm" role="group" aria-label="Werkzeug">' +
      '<button type="button" class="btn btn-outline-light" data-tool="black">⬛ Schwärzen</button>' +
      '<button type="button" class="btn btn-outline-light" data-tool="pixel">▩ Verpixeln</button>' +
      '<button type="button" class="btn btn-outline-light" data-tool="crop">✂️ Zuschneiden</button>' +
      '</div>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="rotate" title="Um 90° drehen">⟳ Drehen</button>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="undo" disabled>↩︎ Rückgängig</button>' +
      '</div></div>' +
      '</div>' +
      // Seitenleiste mit den Angaben der Anzeige (nur bei Entwürfen). Helles
      // Theme fest, damit Felder/Dropdowns auch im Dark Mode lesbar sind.
      '<aside class="photo-edit-side photo-edit-plate" data-bs-theme="light" hidden>' +
      // Anzeige als Ganzes: was fehlt noch. Im Prüf-Modus (/pruefen,
      // window.photoEditorRun) zusätzlich Position.
      '<div class="photo-edit-run">' +
      '<div class="photo-edit-run-label fw-semibold"></div>' +
      '<div class="photo-edit-problems small"></div>' +
      '</div>' +
      '<div class="photo-edit-fields">' +
      // Kennzeichen + Marke nebeneinander – die Leiste soll ohne Scrollen passen.
      '<div class="pe-row">' +
      '<div class="pe-field"><label class="form-label" for="photo-edit-plate-input">Kennzeichen</label>' +
      '<input type="text" id="photo-edit-plate-input" class="form-control plate-field" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
      '<button type="button" class="btn btn-sm btn-outline-warning mt-1" data-act="plate-suggest" hidden></button></div>' +
      '<div class="pe-field"><label class="form-label" for="photo-edit-marke-input">Marke</label>' +
      '<input type="text" id="photo-edit-marke-input" class="form-control photo-edit-marke" maxlength="100" autocomplete="off" placeholder="z. B. VW Golf, grau"></div>' +
      '</div>' +
      '<div class="pe-field"><label class="form-label">Verstoß</label>' +
      '<div class="photo-edit-verstoss position-relative">' +
      '<input type="hidden">' +
      '<input type="text" class="form-control" data-verstoss-input autocomplete="off" spellcheck="false" placeholder="Verstoß suchen …" aria-label="Verstoß">' +
      '</div></div>' +
      '<div class="pe-field photo-edit-tatort"><label class="form-label" for="photo-edit-tatort-input">Tatort</label>' +
      '<div class="d-flex gap-1">' +
      '<input type="text" id="photo-edit-tatort-input" class="form-control" data-geo-scope="unlocked" data-fill="full" data-ac-local' +
      ' autocomplete="off" spellcheck="false" placeholder="Adresse eingeben …">' +
      '<button type="button" class="btn btn-outline-secondary" data-act="tatort-photo" title="Tatort aus den GPS-Daten der Fotos">📍</button>' +
      '</div>' +
      '<div class="photo-edit-map rounded border mt-1" title="Marker zur genauen Stelle ziehen – die Adresse wird übernommen."></div>' +
      '</div>' +
      // Restliche Angaben (Werte aus GET /pruefen/:az/daten, gespeichert je
      // Feld über PATCH /anzeige/:az/felder).
      '<div class="photo-edit-details" hidden>' +
      '<div class="pe-field"><label class="form-label" for="pe-tattag">Tatzeit</label>' +
      '<div class="pe-time">' +
      '<input type="date" id="pe-tattag" class="form-control" data-detail="tattag">' +
      '<input type="time" class="form-control" data-detail="tatzeit_von" aria-label="Uhrzeit von" title="Uhrzeit von">' +
      '<span>–</span>' +
      '<input type="time" class="form-control" data-detail="tatzeit_bis" aria-label="Uhrzeit bis" title="Uhrzeit bis (optional)">' +
      '</div>' +
      '<div class="small text-muted mt-1" data-photo-times hidden>' +
      '<button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-act="photo-times" title="Tattag und Uhrzeit aus den Aufnahmezeiten der Fotos übernehmen">🕒 Zeit aus Fotos übernehmen</button>' +
      ' <span data-photo-span></span></div>' +
      '</div>' +
      '<label class="form-check"><input type="checkbox" class="form-check-input" data-detail="fahrzeug_verlassen"> <span class="form-check-label">Fahrzeug war verlassen</span></label>' +
      '<div class="pe-field"><div class="d-flex align-items-center gap-2"><span class="form-label mb-0">Wurde jemand behindert?</span>' +
      '<span class="btn-group btn-group-sm" role="group" aria-label="Wurde jemand behindert?">' +
      '<input type="radio" class="btn-check" name="pe-beh" id="pe-beh-ja" value="1" data-detail="behinderung">' +
      '<label class="btn btn-outline-secondary" for="pe-beh-ja">Ja</label>' +
      '<input type="radio" class="btn-check" name="pe-beh" id="pe-beh-nein" value="0" data-detail="behinderung">' +
      '<label class="btn btn-outline-secondary" for="pe-beh-nein">Nein</label>' +
      '</span></div>' +
      '<input type="text" class="form-control mt-1 photo-edit-beh-text" data-detail="behinderung_text" list="pe-beh-vorschlaege"' +
      ' placeholder="Wer wurde wie behindert? (Vorschläge beim Antippen)" hidden>' +
      '<datalist id="pe-beh-vorschlaege">' +
      // Wie die Schnellauswahl in reports/edit.ejs.
      ['Ich musste auf die Straße ausweichen.', 'Ich musste auf den Gehweg ausweichen.', 'Ich musste mit dem Rad auf die Fahrbahn ausweichen.',
        'Fußgänger mussten auf die Straße ausweichen.', 'Rollstuhlfahrer bzw. Kinderwagen kamen nicht vorbei.']
        .map(function (t) { return '<option value="' + t + '">' }).join('') +
      '</datalist></div>' +
      '</div>' +
      '</div>' +
      '<div class="photo-edit-actions">' +
      '<button type="button" class="btn btn-outline-success" data-act="submit" disabled title="Vorschau mit PDF öffnen und einreichen">✓ Anzeige einreichen …</button>' +
      (document.body.hasAttribute('data-admin')
        ? '<button type="button" class="btn btn-primary" data-act="send" disabled title="Ohne Prüfung direkt ans Ordnungsamt senden (nur Admins)">📨 Sofort versenden</button>'
        : '') +
      '<div class="d-flex gap-2">' +
      '<button type="button" class="btn btn-sm btn-outline-secondary flex-fill" data-act="skip">⏭ Überspringen</button>' +
      '<button type="button" class="btn btn-sm btn-outline-danger flex-fill" data-act="trash-report" title="Anzeige in den Papierkorb (30 Tage wiederherstellbar)">🗑 Verwerfen</button>' +
      '</div>' +
      '</div>' +
      '</aside>' +
      '</div>'
    document.body.appendChild(dlg)
    canvas = dlg.querySelector('canvas')
    ctx = canvas.getContext('2d')
    dlg.querySelectorAll('[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () { setTool(state.tool === b.dataset.tool ? null : b.dataset.tool) })
    })
    dlg.querySelector('[data-act=rotate]').addEventListener('click', rotate)
    dlg.querySelector('[data-act=undo]').addEventListener('click', undo)
    dlg.querySelector('[data-act=cancel]').addEventListener('click', cancel)
    dlg.querySelector('[data-act=save]').addEventListener('click', save)
    dlg.querySelector('[data-act=delete]').addEventListener('click', remove)
    dlg.querySelector('[data-act=plate-suggest]').addEventListener('click', function () {
      plateInput().value = state.detected
      savePlate().then(updateUi, function () {})
    })
    plateInput().addEventListener('input', updateUi)
    // Kachel-Streifen: anderes Foto derselben Anzeige öffnen.
    var strip = dlg.querySelector('.photo-edit-strip')
    strip.addEventListener('click', function (e) {
      var pick = e.target.closest('.photo-edit-pick')
      if (pick) {
        if (!state) return
        var put = pick.getAttribute('data-pick-put')
        if (pick.checked) state.picked[put] = true
        else delete state.picked[put]
        updateMoveLabel()
        return
      }
      var mv = e.target.closest('[data-move]')
      if (mv) {
        var i = state && state.thumbs ? state.thumbs.indexOf(state.thumb) : -1
        if (i !== -1) reorder(i, i + Number(mv.getAttribute('data-move')))
        return
      }
      var b = e.target.closest('[data-strip-index]')
      if (!b || !state || state.busy || !state.thumbs) return
      var t = state.thumbs[Number(b.getAttribute('data-strip-index'))]
      if (!t || t === state.thumb) return
      if (state.dirty && !confirm('Änderungen am Foto verwerfen?')) return
      savePlate().then(function () { openThumb(t) }, function () {})
    })
    // Reihenfolge per Drag & Drop (Desktop); auf dem Handy die Pfeile.
    var dragFrom = null
    strip.addEventListener('dragstart', function (e) {
      var b = e.target.closest('[data-strip-index]')
      if (!b) return
      dragFrom = Number(b.getAttribute('data-strip-index'))
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(dragFrom))
      e.stopPropagation() // nicht report-table.js (Foto in andere Anzeige ziehen)
    })
    strip.addEventListener('dragover', function (e) {
      if (dragFrom === null) return
      e.preventDefault()
      strip.querySelectorAll('.is-drop').forEach(function (x) { x.classList.remove('is-drop') })
      var b = e.target.closest('[data-strip-index]')
      if (b) b.classList.add('is-drop')
    })
    strip.addEventListener('drop', function (e) {
      if (dragFrom === null) return
      e.preventDefault()
      var b = e.target.closest('[data-strip-index]')
      var from = dragFrom
      dragFrom = null
      if (b) reorder(from, Number(b.getAttribute('data-strip-index')))
    })
    strip.addEventListener('dragend', function () {
      dragFrom = null
      strip.querySelectorAll('.is-drop').forEach(function (x) { x.classList.remove('is-drop') })
    })
    plateInput().addEventListener('change', function () { savePlate().catch(function () {}) })
    // Tatort: Vorschläge (address-autocomplete.js, im Layout geladen) beim
    // ersten Fokus; gewählter Vorschlag speichert mit Koordinaten, frei
    // getippter Text beim Verlassen ohne (wie report-inline.js).
    tatortInput().addEventListener('focus', function () {
      if (window.addressAutocomplete) window.addressAutocomplete.init(tatortInput())
    })
    tatortInput().addEventListener('address:chosen', function (e) {
      var d = e.detail || {}
      chosenCoords = Number.isFinite(d.lat) && Number.isFinite(d.lon) ? { tatort_lat: d.lat, tatort_lon: d.lon } : null
      if (chosenCoords) placeMarker(d.lat, d.lon, true)
      savePlate().catch(function () {})
    })
    tatortInput().addEventListener('change', function () {
      // Kurz warten: Antippen eines Vorschlags löst erst blur/change, dann die Auswahl aus.
      setTimeout(function () { savePlate().catch(function () {}) }, 250)
    })
    dlg.querySelector('[data-act=tatort-photo]').addEventListener('click', tatortFromPhotos)
    dlg.querySelector('[data-act=move-menu]').addEventListener('click', toggleMoveMenu)
    var menuEl = dlg.querySelector('.photo-edit-move-menu')
    menuEl.querySelector('[data-move-new]').addEventListener('click', function () { moveTo({ newDraft: true }) })
    menuEl.querySelector('[data-move-search]').addEventListener('input', renderMoveList)
    menuEl.querySelector('[data-move-list]').addEventListener('click', function (e) {
      var b = e.target.closest('[data-move-az]')
      if (b) moveTo({ targetAz: b.getAttribute('data-move-az') })
    })
    // Klick außerhalb schließt das Menü.
    dlg.addEventListener('pointerdown', function (e) {
      if (!menuEl.hidden && !e.target.closest('.photo-edit-move-menu, [data-act=move-menu]')) menuEl.hidden = true
    })
    dlg.querySelector('[data-act=photo-times]').addEventListener('click', applyPhotoTimes)
    dlg.querySelector('[data-act=submit]').addEventListener('click', function () { submitReport(false) })
    var sendBtn = dlg.querySelector('[data-act=send]')
    if (sendBtn) sendBtn.addEventListener('click', function () { submitReport(true) })
    dlg.querySelector('.photo-edit-details').addEventListener('change', function (e) {
      var f = e.target.getAttribute && e.target.getAttribute('data-detail')
      if (!f) return
      var v = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value.trim()
      if (f === 'behinderung') {
        dlg.querySelector('[data-detail=behinderung_text]').hidden = v !== '1'
        if (v === '1') setTimeout(function () { dlg.querySelector('[data-detail=behinderung_text]').focus() }, 0)
      }
      var body = {}
      body[f] = v
      saveDetail(body)
    })
    dlg.querySelector('[data-act=skip]').addEventListener('click', function () { runDone('skipped') })
    dlg.querySelector('[data-act=trash-report]').addEventListener('click', trashReport)
    markeInput().addEventListener('change', function () { savePlate().catch(function () {}) })
    // Verstoß: Katalog erst beim ersten Fokus laden (wie report-inline.js);
    // die Auswahl meldet verstoss-select.js per change am versteckten Feld.
    verstossHidden().addEventListener('change', function () { savePlate().then(updateUi, function () {}) })
    window.addEventListener('resize', function () { if (dlg.open) fitVerstossMenu() })
    verstossInput().addEventListener('input', fitVerstossMenu)
    // Beim Scrollen der Seitenleiste mitwandern (capture: scroll bubbelt nicht).
    dlg.addEventListener('scroll', function () { fitVerstossMenu() }, true)
    verstossInput().addEventListener('focus', function () {
      fitVerstossMenu()
      var root = verstossHidden().parentNode
      if (root.dataset.verstossReady || !window.verstossSelect) return
      loadCatalog().then(function (data) {
        // Ein früherer Fehlschlag (z. B. während eines App-Neustarts) darf
        // nicht als roter Rahmen stehen bleiben.
        verstossInput().classList.remove('is-invalid')
        verstossInput().title = ''
        if (root.dataset.verstossReady) return
        window.verstossSelect.init(root, data)
        fitVerstossMenu()
        if (document.activeElement === verstossInput()) verstossInput().dispatchEvent(new Event('focus'))
      }, function () {
        verstossInput().classList.add('is-invalid')
        verstossInput().title = 'Verstoß-Katalog nicht ladbar – Feld erneut antippen.'
      })
    })
    dlg.addEventListener('cancel', function (e) {
      e.preventDefault()
      cancel()
    })
    // Enter bestätigt – zügiges Durchklicken ohne Maus.
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.target.closest('button') || !state) return
      // Enter im Verstoß-Suchfeld wählt einen Eintrag (verstoss-select.js) –
      // darf das Foto nicht nebenbei bestätigen.
      if (e.target === verstossInput()) {
        e.preventDefault()
        return
      }
      // Enter im Kennzeichen-Feld speichert nur das Kennzeichen – das Foto
      // bestätigt erst ein zweites Enter (Fokus springt auf „Bestätigen").
      if (e.target === tatortInput()) return // Auswahl übernimmt address-autocomplete.js
      if (e.target.closest('.photo-edit-details')) {
        e.preventDefault()
        e.target.blur() // löst change → speichern aus
        return
      }
      if (e.target === plateInput() || e.target === markeInput()) {
        e.preventDefault()
        savePlate().then(function () { dlg.querySelector('[data-act=save]').focus() }, function () {})
        return
      }
      if (!state.base || state.busy) return
      e.preventDefault()
      // Alles geprüft und vollständig: Enter reicht die Anzeige ein.
      if (readyToSubmit()) submitReport()
      else save()
    })
    attachDrawing()
  }

  function plateInput() {
    return dlg.querySelector('#photo-edit-plate-input')
  }
  function markeInput() {
    return dlg.querySelector('#photo-edit-marke-input')
  }
  function tatortInput() {
    return dlg.querySelector('#photo-edit-tatort-input')
  }
  var chosenCoords = null // Koordinaten des zuletzt gewählten Adressvorschlags
  function verstossHidden() {
    return dlg.querySelector('.photo-edit-verstoss input[type=hidden]')
  }
  function verstossInput() {
    return dlg.querySelector('.photo-edit-verstoss [data-verstoss-input]')
  }
  // Verstoß-Liste breiter als das Feld (lange Tatbestände) und fest am
  // Bildschirm positioniert – die scrollende Seitenleiste würde sie sonst
  // abschneiden. Rechtsbündig zum Feld, ragt nach links über das Foto.
  function fitVerstossMenu() {
    var menu = verstossHidden().parentNode.querySelector('.list-group')
    if (!menu) return
    var r = verstossInput().getBoundingClientRect()
    var w = Math.max(r.width, Math.min(736, window.innerWidth - 32))
    var left = Math.min(r.left, window.innerWidth - 16 - w)
    menu.style.position = 'fixed'
    menu.style.width = w + 'px'
    menu.style.right = 'auto'
    menu.style.left = Math.max(16, left) + 'px'
    // Unter das Feld, wenn genug Platz ist, sonst darüber.
    var below = window.innerHeight - r.bottom - 16
    var above = r.top - 16
    if (below >= 240 || below >= above) {
      menu.style.top = r.bottom + 'px'
      menu.style.bottom = 'auto'
      menu.style.maxHeight = Math.max(160, below) + 'px'
    } else {
      menu.style.top = 'auto'
      menu.style.bottom = window.innerHeight - r.top + 'px'
      menu.style.maxHeight = above + 'px'
    }
  }

  var catalog = null
  function loadCatalog() {
    if (!catalog) {
      catalog = fetch('/anzeigen/bearbeitungsoptionen', { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok || r.redirected) throw new Error()
          return r.json()
        })
        .then(function (d) { return { alle: d.offenses || [], haeufig: d.frequent || [] } })
      catalog.catch(function () { catalog = null })
    }
    return catalog
  }
  // Gleiche Normalisierung wie normalizePlate() in routes/reports.ts.
  function normPlate(v) {
    return String(v || '').toLocaleUpperCase('de-DE').replace(/\s+/g, ' ').trim().slice(0, 20)
  }
  function compact(v) {
    return normPlate(v).replace(/[^A-Z0-9ÄÖÜ]/g, '')
  }

  // Geändertes Kennzeichen/geänderte Marke sichern (no-op, wenn unverändert
  // oder kein Feld). Name historisch: die Marke kam später dazu.
  function savePlate() {
    var s = state
    if (!s || s.plate == null) return Promise.resolve()
    var body = {}
    var v = normPlate(plateInput().value)
    if (v !== s.plate) body.kennzeichen = v
    var mk = markeInput().value.replace(/\s+/g, ' ').trim()
    if (s.marke != null && mk !== s.marke) body.fahrzeug_marke = mk
    var vs = verstossHidden().value
    if (s.verstoss != null && vs !== s.verstoss) body.verstoss_art = vs
    var to = tatortInput().value.replace(/\s+/g, ' ').trim()
    if (s.tatort != null && (to !== s.tatort || chosenCoords)) {
      body.tatort = to
      if (chosenCoords) {
        body.tatort_lat = chosenCoords.tatort_lat
        body.tatort_lon = chosenCoords.tatort_lon
      }
    }
    chosenCoords = null
    if (!Object.keys(body).length) return Promise.resolve()
    return fetch('/anzeige/' + encodeURIComponent(s.az) + '/felder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Kennzeichen konnte nicht gespeichert werden.')
        var vals = res.d.values || {}
        if ('kennzeichen' in vals) s.plate = vals.kennzeichen || ''
        if ('fahrzeug_marke' in vals) s.marke = vals.fahrzeug_marke || ''
        if ('verstoss_art' in vals) s.verstoss = vals.verstoss_art || ''
        if ('tatort' in vals) s.tatort = vals.tatort || ''
        if (state === s) {
          plateInput().value = s.plate
          markeInput().value = s.marke || ''
        }
        // Felder der Zeile/Karte nachziehen (report-inline.js vergleicht mit dataset.saved).
        var host = rowOf(s.az)
        ;[['kennzeichen', s.plate], ['fahrzeug_marke', s.marke], ['verstoss_art', s.verstoss], ['tatort', s.tatort]].forEach(function (p) {
          if (!(p[0] in vals)) return
          var field = host && host.querySelector('[data-inline-field="' + p[0] + '"]')
          if (field) {
            field.value = p[1] || ''
            field.dataset.saved = p[1] || ''
            // Verstoß: sichtbares Suchfeld neben dem versteckten Wert mitziehen.
            var vis = field.type === 'hidden' && field.parentNode.querySelector('[data-verstoss-input]')
            if (vis) vis.value = p[1] || ''
          }
        })
        document.dispatchEvent(new CustomEvent('owia:plate-changed', { detail: { az: s.az, kennzeichen: s.plate } }))
        if (state === s) updateUi()
        loadStatus(s)
      })
      .catch(function (err) {
        alert(err.message || 'Kennzeichen konnte nicht gespeichert werden.')
        throw err
      })
  }

  // Alle Fotos der Anzeige als Kacheln (links bzw. auf dem Handy unten) –
  // Überblick, was schon geprüft ist, und Sprung zu einem beliebigen Foto.
  function renderStrip() {
    var strip = dlg.querySelector('.photo-edit-strip')
    strip.replaceChildren()
    var thumbs = state.thumbs || []
    strip.hidden = thumbs.length < 2
    dlg.classList.toggle('has-strip', thumbs.length >= 2)
    thumbs.forEach(function (t, i) {
      // div statt button: die aktuelle Kachel enthält die Verschiebe-Knöpfe.
      var b = el('div', 'photo-edit-tile' + (t === state.thumb ? ' is-current' : '') +
        (t.getAttribute('data-geprueft') === '1' ? ' is-geprueft' : ' is-ungeprueft'))
      b.setAttribute('role', 'button')
      b.tabIndex = 0
      b.draggable = true
      b.setAttribute('data-strip-index', String(i))
      b.title = 'Foto ' + (i + 1) + (t.getAttribute('data-geprueft') === '1' ? ' – geprüft' : ' – ungeprüft')
      var img = el('img')
      img.src = t.getAttribute('src')
      img.alt = ''
      b.appendChild(img)
      b.appendChild(el('span', 'thumb-check', t.getAttribute('data-geprueft') === '1' ? '✓' : '?'))
      b.appendChild(el('span', 'photo-edit-tile-no', String(i + 1)))
      if (state.plate != null) {
        var pk = el('input', 'form-check-input photo-edit-pick')
        pk.type = 'checkbox'
        pk.title = 'Zum Verschieben auswählen'
        pk.setAttribute('data-pick-put', t.getAttribute('data-photo-edit'))
        pk.checked = !!state.picked[t.getAttribute('data-photo-edit')]
        b.appendChild(pk)
      }
      if (t === state.thumb) {
        var mv = el('span', 'photo-edit-move')
        var back = el('button', 'btn btn-sm btn-light', '‹')
        back.type = 'button'
        back.setAttribute('data-move', '-1')
        back.title = 'Foto nach vorne'
        back.disabled = i === 0
        var fwd = el('button', 'btn btn-sm btn-light', '›')
        fwd.type = 'button'
        fwd.setAttribute('data-move', '1')
        fwd.title = 'Foto nach hinten'
        fwd.disabled = i === thumbs.length - 1
        mv.appendChild(back)
        mv.appendChild(fwd)
        b.appendChild(mv)
      }
      strip.appendChild(b)
      // Nur den Streifen scrollen – scrollIntoView zog auf dem Handy den ganzen
      // Dialog mit nach unten.
      if (t === state.thumb) {
        setTimeout(function () {
          var sr = strip.getBoundingClientRect()
          var br = b.getBoundingClientRect()
          if (br.top < sr.top || br.bottom > sr.bottom) strip.scrollTop += br.top - sr.top - 8
          if (br.left < sr.left || br.right > sr.right) strip.scrollLeft += br.left - sr.left - 8
        }, 0)
      }
    })
  }

  // Foto von Position from nach to verschieben: POST …/images/reorder, dann
  // Zeile/Karte neu laden und den Streifen aus den neuen Miniaturen bauen –
  // das Foto in Bearbeitung (samt ungespeicherter Schwärzungen) bleibt offen.
  function reorder(from, to) {
    var s = state
    if (!s || !s.thumbs || s.busy || to < 0 || to >= s.thumbs.length || from === to) return
    var list = s.thumbs.slice()
    list.splice(to, 0, list.splice(from, 1)[0])
    var idOf = function (t) { return Number(String(t.getAttribute('data-photo-edit')).split('/').pop()) }
    s.thumbs = list
    renderStrip()
    fetch('/anzeige/' + encodeURIComponent(s.az) + '/images/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ order: list.map(idOf) }),
    })
      .then(function (r) {
        if (!r.ok || r.redirected) throw new Error()
        return window.reportTableRefresh ? window.reportTableRefresh(s.az) : null
      })
      .then(function () {
        if (state !== s) return
        var host = rowOf(s.az)
        if (!host) return
        var fresh = Array.prototype.slice.call(host.querySelectorAll('[data-photo-edit]'))
        var mine = fresh.filter(function (t) { return t.getAttribute('data-photo-edit') === s.put })[0]
        if (!mine) return
        s.thumbs = fresh
        s.thumb = mine
        s.pos = fresh.indexOf(mine) + 1
        renderStrip()
        updateUi()
      })
      .catch(function () { alert('Reihenfolge konnte nicht gespeichert werden.') })
  }

  function msg(text) {
    var m = dlg.querySelector('.photo-edit-msg')
    m.textContent = text || ''
    m.hidden = !text
  }

  function updateUi() {
    dlg.querySelectorAll('[data-tool]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tool === state.tool)
    })
    dlg.querySelector('[data-act=undo]').disabled = !state.history.length
    var saveBtn = dlg.querySelector('[data-act=save]')
    saveBtn.disabled = !state.base || !!state.busy
    if (!state.busy) saveBtn.textContent = state.dirty ? '✓ Speichern & bestätigen' : '✓ Bestätigen'
    dlg.querySelector('[data-act=delete]').disabled = !!state.busy
    var mvb = dlg.querySelector('[data-act=move-menu]')
    mvb.hidden = state.plate == null
    mvb.disabled = !!state.busy
    var st = dlg.querySelector('.photo-edit-status')
    st.textContent = 'Foto ' + state.pos + '/' + state.total + ' · ' + (state.ok ? '✓ geprüft' : 'ungeprüft') +
      (state.open ? ' · noch ' + state.open + ' offen' : '')
    st.classList.toggle('is-ok', state.ok)
    st.classList.toggle('is-open', !state.ok)
    var tips = {
      black: 'Rechtecke über Gesichter oder fremde Kennzeichen ziehen.',
      pixel: 'Rechtecke über die zu verpixelnden Bereiche ziehen.',
      crop: 'Den Ausschnitt aufziehen, der übrig bleiben soll.',
    }
    dlg.querySelector('.photo-edit-hint').textContent = state.tool ? tips[state.tool] : 'Werkzeug wählen.'
    canvas.classList.toggle('editing', !!state.tool)
    var pbox = dlg.querySelector('.photo-edit-plate')
    pbox.hidden = state.plate == null
    if (state.plate != null) {
      var cur = plateInput().value
      var sug = dlg.querySelector('[data-act=plate-suggest]')
      sug.hidden = !state.detected || compact(state.detected) === compact(cur)
      sug.textContent = '↵ Erkannt: ' + (state.detected || '')
      sug.title = 'Erkanntes Kennzeichen übernehmen'
      // Leeres oder vom erkannten abweichendes Kennzeichen hervorheben.
      plateInput().classList.toggle('is-invalid', !normPlate(cur))
      verstossInput().classList.toggle('is-missing', state.verstoss != null && !verstossHidden().value)
      plateInput().classList.toggle('is-mismatch', !!state.detected && !!normPlate(cur) && compact(state.detected) !== compact(cur))
      tatortInput().classList.toggle('is-missing', !tatortInput().value.trim())
    }
    updateRun()
  }

  // ---- Anzeige als Ganzes: Prüfliste + Einreichen (beide Prüf-Modi) --------
  // Status kommt von GET /pruefen/:az/daten (dieselben Prüfungen wie der Submit).
  // Details-Felder aus den Daten der Anzeige befüllen – einmal je Anzeige
  // (nicht bei jedem Foto/Status-Update, sonst überschriebe das Eingaben).
  var detailsAz = null
  var detailsChanged = {}
  function fillDetails(s) {
    var box = dlg.querySelector('.photo-edit-details')
    box.hidden = !s.report
    if (!s.report || detailsAz === s.az) return
    detailsAz = s.az
    var f = s.report.fields
    box.querySelector('[data-detail=tattag]').value = f.tattag || ''
    box.querySelector('[data-detail=tatzeit_von]').value = f.tatzeit_von || ''
    box.querySelector('[data-detail=tatzeit_bis]').value = f.tatzeit_bis || ''
    box.querySelector('[data-detail=fahrzeug_verlassen]').checked = !!f.fahrzeug_verlassen
    box.querySelector('#pe-beh-ja').checked = !!f.behinderung
    box.querySelector('#pe-beh-nein').checked = !f.behinderung
    var bt = box.querySelector('[data-detail=behinderung_text]')
    bt.value = f.behinderung_text || ''
    bt.hidden = !f.behinderung
    // Zeitspanne der Fotos (EXIF, serverseitig als Strings) für „Uhrzeit aus Fotos".
    var t = s.report.photoTimes
    box.querySelector('[data-photo-times]').hidden = !t
    // Kurz (eine Zeile): Datum nur, wenn es vom eingetragenen Tattag abweicht.
    if (t) {
      box.querySelector('[data-photo-span]').textContent = '(' +
        (t.vonTag === t.bisTag && t.vonTag === f.tattag ? t.von + (t.bis !== t.von ? ' – ' + t.bis : '') + ' Uhr' : photoSpan(t)) + ')'
    }
  }
  function fmtDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
    return m ? m[3] + '.' + m[2] + '.' + m[1] : iso
  }
  function photoSpan(t) {
    if (t.vonTag !== t.bisTag) return fmtDay(t.vonTag) + ' ' + t.von + ' – ' + fmtDay(t.bisTag) + ' ' + t.bis
    return fmtDay(t.vonTag) + ', ' + t.von + (t.bis !== t.von ? ' – ' + t.bis : '') + ' Uhr'
  }
  // Wie report-form.js: von = frühestes, bis = spätestes Foto; bis leer, wenn
  // alles in derselben Minute; „Tag bis" nur bei Tageswechsel.
  function applyPhotoTimes() {
    var s = state
    var t = s && s.report && s.report.photoTimes
    if (!t) return
    var body = {
      tattag: t.vonTag,
      tatzeit_von: t.von,
      tattag_bis: t.bisTag !== t.vonTag ? t.bisTag : '',
      tatzeit_bis: t.bis !== t.von || t.bisTag !== t.vonTag ? t.bis : '',
    }
    var box = dlg.querySelector('.photo-edit-details')
    box.querySelector('[data-detail=tattag]').value = body.tattag
    box.querySelector('[data-detail=tatzeit_von]').value = body.tatzeit_von
    box.querySelector('[data-detail=tatzeit_bis]').value = body.tatzeit_bis
    saveDetail(body)
  }
  function saveDetail(body) {
    var s = state
    if (!s) return
    detailsChanged[s.az] = true
    fetch('/anzeige/' + encodeURIComponent(s.az) + '/felder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Speichern fehlgeschlagen.') }) })
      .then(function () { loadStatus(s) })
      .catch(function (err) { alert(err.message) })
  }
  // Zeile/Karte nach Detail-Änderungen auffrischen (beim Schließen/Weitergehen).
  function flushHost(az) {
    if (!detailsChanged[az]) return
    delete detailsChanged[az]
    if (window.reportTableRefresh) Promise.resolve(window.reportTableRefresh(az)).catch(function () {})
  }

  // ---- Tatort-Karte (wie report-map.js im Editor) ---------------------------
  // Eine Leaflet-Karte für den ganzen Dialog; je Anzeige neu zentriert.
  // Marker ziehen → Adresse per Reverse-Geocoding → Tatort + genau diese
  // Koordinaten speichern. Leaflet wird bei Bedarf nachgeladen (nicht jede
  // Listenseite bindet es ein).
  var MAP_ZOOM = 19 // höchste Stufe des Tileservers (maxZoom unten)
  var map = null
  var marker = null
  var mapAz = null
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
        js.onerror = function () { leafletLoading = null; reject() }
        document.head.appendChild(js)
      })
    }
    return leafletLoading
  }
  // 0/0 und Unsinn sind keine Position (gleiche Regel wie report-map.js).
  function validCoord(v) {
    return typeof v === 'number' && isFinite(v) && v !== 0
  }
  function photoIcon(url) {
    return L.divIcon({
      className: 'photo-marker',
      html: '<img src="' + encodeURI(url) + '" alt="" style="width:30px;height:30px;object-fit:cover;border-radius:6px;border:2px solid #0d6efd;box-shadow:0 1px 4px rgba(0,0,0,.45)">',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    })
  }
  function syncMap(s) {
    var el = dlg.querySelector('.photo-edit-map')
    if (!s.report || s.tatort == null) return
    loadLeaflet().then(function () {
      if (state !== s) return
      if (!map) {
        var base = '/public/vendor/leaflet/images/'
        L.Icon.Default.mergeOptions({ iconRetinaUrl: base + 'marker-icon-2x.png', iconUrl: base + 'marker-icon.png', shadowUrl: base + 'marker-shadow.png' })
        map = L.map(el, { zoomControl: true })
        L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }).addTo(map)
        // Ohne Tatort setzt ein Klick in die Karte den Marker.
        map.on('click', function (e) {
          if (marker || !state) return
          placeMarker(e.latlng.lat, e.latlng.lng, true)
          markerMoved()
        })
      }
      var f = s.report.fields
      var has = validCoord(f.tatort_lat) && validCoord(f.tatort_lon)
      if (mapAz !== s.az) {
        mapAz = s.az
        if (marker) { marker.remove(); marker = null }
        var c = s.report.mapCenter || { lat: 50.1109, lon: 8.6821 }
        // Mit Tatort ganz heran (Marker exakt setzen), sonst Stadtübersicht.
        map.setView(has ? [f.tatort_lat, f.tatort_lon] : [c.lat, c.lon], has ? MAP_ZOOM : 13)
      }
      if (has) placeMarker(f.tatort_lat, f.tatort_lon, false)
      // Die Seitenleiste hat ihre Größe evtl. erst jetzt – neu vermessen und
      // auf den Marker zentrieren, sonst liegt er außerhalb des Ausschnitts.
      setTimeout(function () {
        if (!map || state !== s) return
        map.invalidateSize()
        if (has && marker) map.setView(marker.getLatLng(), map.getZoom(), { animate: false })
      }, 120)
    }, function () { el.hidden = true })
  }
  function placeMarker(lat, lon, recenter) {
    if (!map || !state) return
    var first = state.report && state.report.images && state.report.images[0]
    if (marker) marker.setLatLng([lat, lon])
    else {
      marker = L.marker([lat, lon], first ? { draggable: true, icon: photoIcon(first.thumb) } : { draggable: true }).addTo(map)
      marker.on('dragend', markerMoved)
    }
    if (recenter) map.setView([lat, lon], MAP_ZOOM)
  }
  function markerMoved() {
    var s = state
    var p = marker.getLatLng()
    fetch('/api/geo/reverse?lat=' + p.lat + '&lon=' + p.lng, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
      .then(function (data) {
        if (state !== s) return
        var label = data && data.result && data.result.label
        if (label) tatortInput().value = label
        chosenCoords = { tatort_lat: Number(p.lat.toFixed(6)), tatort_lon: Number(p.lng.toFixed(6)) }
        savePlate().catch(function () {})
      })
  }

  function loadStatus(s) {
    if (!s || s.plate == null) return
    var seq = (s.statusSeq = (s.statusSeq || 0) + 1)
    fetch('/pruefen/' + encodeURIComponent(s.az) + '/daten', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok && !r.redirected ? r.json() : null })
      .catch(function () { return null })
      .then(function (d) {
        if (state !== s || seq !== s.statusSeq || !d || d.gone) return
        s.report = d
        fillDetails(s)
        syncMap(s)
        updateRun()
      })
  }
  function readyToSubmit() {
    var s = state
    return !!(s && s.report && s.report.canSubmit && s.ok && !s.open && !s.dirty)
  }
  function updateRun() {
    var box = dlg.querySelector('.photo-edit-side')
    var s = state
    if (!s || s.plate == null) return
    var run = window.photoEditorRun
    dlg.querySelector('.photo-edit-run-label').textContent = (run && run.label ? run.label() + ' · ' : '') + s.az
    box.querySelector('[data-act=skip]').parentNode.hidden = !run
    var probs = dlg.querySelector('.photo-edit-problems')
    var btn = box.querySelector('[data-act=submit]')
    var ready = readyToSubmit()
    if (!s.report) {
      probs.textContent = ''
      btn.disabled = true
    } else {
      var list = s.report.problems.map(function (p) {
        if (p.kind === 'photos') {
          var n = (s.thumbs || []).filter(function (t) { return t.getAttribute('data-geprueft') !== '1' }).length
          return n === 1 ? '1 Foto ungeprüft' : n + ' Fotos ungeprüft'
        }
        return p.message.replace(/\.$/, '')
      })
      probs.textContent = list.length ? '⚠ ' + list.join(' · ') : (ready ? '✓ Bereit – Enter reicht ein' : '✓ Vollständig')
      probs.classList.toggle('is-open', list.length > 0)
      probs.classList.toggle('is-ok', !list.length)
      btn.disabled = !s.report.canSubmit || !!s.busy
    }
    var send = box.querySelector('[data-act=send]')
    if (send) send.disabled = btn.disabled
    btn.classList.toggle('btn-success', ready)
    btn.classList.toggle('btn-outline-success', !ready)
    // Ist alles erledigt, tritt „Bestätigen" zurück.
    var saveBtn = dlg.querySelector('[data-act=save]')
    saveBtn.classList.toggle('btn-success', !ready)
    saveBtn.classList.toggle('btn-outline-light', ready)
  }

  function runDone(action) {
    var s = state
    if (!s) return
    var run = window.photoEditorRun
    delete detailsChanged[s.az]
    if (run) return run.done(s.az, action)
    close()
    if (window.reportTableRefresh) window.reportTableRefresh(s.az).catch(function () {})
  }

  // Einreichen: Vorschau mit PDF (report-submit.js) über dem Foto-Dialog; erst
  // dort wird abgeschickt (Admins dort auch „Einreichen & versenden").
  // sofort = Admin-Knopf „📨 Sofort versenden" direkt im Dialog.
  function submitReport(sofort) {
    var s = state
    if (!s || s.busy || !s.report || !s.report.canSubmit) return
    if (s.dirty && !confirm('Ungespeicherte Änderungen am Foto verwerfen und einreichen?')) return
    if (sofort && !confirm('Anzeige ohne weitere Prüfung direkt ans Ordnungsamt versenden?')) return
    var done = function () { if (state === s) runDone('submitted') }
    if (!sofort && window.submitPreview) {
      return savePlate().then(function () {
        window.submitPreview.open(s.az, { onSubmitted: done })
      }, function () {})
    }
    s.busy = true
    updateUi()
    savePlate()
      .then(function () {
        return fetch('/anzeige/' + encodeURIComponent(s.az) + '/submit' + (sofort ? '?sofort=1' : ''), { method: 'POST', headers: { Accept: 'application/json' } })
      })
      .then(function (r) {
        return r.json().catch(function () { return {} }).then(function (d) {
          if (!r.ok || r.redirected) throw new Error(d.error || 'Einreichen fehlgeschlagen.')
        })
      })
      .then(function () {
        s.busy = false
        done()
      })
      .catch(function (err) {
        if (err && err.message) alert(err.message)
        s.busy = false
        loadStatus(s)
      })
      .finally(function () { if (state === s) updateUi() })
  }

  function trashReport() {
    var s = state
    if (!s || s.busy) return
    s.busy = true
    fetch('/anzeige/' + encodeURIComponent(s.az) + '/discard', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok || r.redirected) throw new Error()
        s.busy = false
        if (state === s) runDone('trashed')
      })
      .catch(function () {
        s.busy = false
        alert('Anzeige konnte nicht verworfen werden.')
      })
  }

  function tatortFromPhotos() {
    var s = state
    var b = dlg.querySelector('[data-act=tatort-photo]')
    b.disabled = true
    fetch('/anzeige/' + encodeURIComponent(s.az) + '/tatort-aus-fotos', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.json().catch(function () { return {} }).then(function (d) {
          if (!r.ok) throw new Error(d.error || 'Kein Tatort aus den Fotos ermittelbar.')
          return d
        })
      })
      .then(function (d) {
        if (state !== s) return
        s.tatort = d.tatort
        tatortInput().value = d.tatort
        var host = rowOf(s.az)
        var field = host && host.querySelector('[data-inline-field="tatort"]')
        if (field) {
          field.value = d.tatort
          field.dataset.saved = d.tatort
        }
        updateUi()
        loadStatus(s)
        // Neue Position zeigen, sobald der Status (mit Koordinaten) da ist.
        setTimeout(function () {
          var f = state === s && s.report && s.report.fields
          if (f && validCoord(f.tatort_lat) && validCoord(f.tatort_lon)) placeMarker(f.tatort_lat, f.tatort_lon, true)
        }, 700)
      })
      .catch(function (err) { alert(err.message) })
      .finally(function () { b.disabled = false })
  }

  function setTool(tool) {
    state.tool = tool
    updateUi()
  }

  function pixelate(r) {
    var block = 14
    var tw = Math.max(1, Math.round(r.w / block))
    var th = Math.max(1, Math.round(r.h / block))
    var tmp = document.createElement('canvas')
    tmp.width = tw
    tmp.height = th
    tmp.getContext('2d').drawImage(state.base, r.x, r.y, r.w, r.h, 0, 0, tw, th)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(tmp, 0, 0, tw, th, r.x, r.y, r.w, r.h)
    ctx.restore()
  }

  function redraw() {
    canvas.width = state.base.width
    canvas.height = state.base.height
    ctx.drawImage(state.base, 0, 0)
    state.redactions.forEach(function (r) {
      if (r.type === 'pixel') pixelate(r)
      else {
        ctx.fillStyle = '#000'
        ctx.fillRect(r.x, r.y, r.w, r.h)
      }
    })
  }

  // Schnappschuss vor jeder Änderung (Rotieren/Zuschneiden erzeugen neue
  // Canvas-Objekte, die Referenz genügt) – Rückgängig ohne Rückfragen.
  function snapshot() {
    state.history.push({ base: state.base, redactions: state.redactions.slice() })
    state.dirty = true
  }
  function undo() {
    var s = state.history.pop()
    if (!s) return
    state.base = s.base
    state.redactions = s.redactions
    state.dirty = state.history.length > 0
    redraw()
    updateUi()
  }

  // Markierungen ins Bild einbacken, damit Rotieren/Zuschneiden sie mitnehmen.
  function flatten() {
    var c = document.createElement('canvas')
    c.width = canvas.width
    c.height = canvas.height
    c.getContext('2d').drawImage(canvas, 0, 0)
    return c
  }

  function rotate() {
    snapshot()
    var old = flatten()
    var c = document.createElement('canvas')
    c.width = old.height
    c.height = old.width
    var cx = c.getContext('2d')
    cx.translate(c.width, 0)
    cx.rotate(Math.PI / 2)
    cx.drawImage(old, 0, 0)
    state.base = c
    state.redactions = []
    redraw()
    updateUi()
  }

  function crop(r) {
    var old = flatten()
    var x = Math.max(0, Math.round(r.x))
    var y = Math.max(0, Math.round(r.y))
    var w = Math.min(old.width - x, Math.round(r.w))
    var h = Math.min(old.height - y, Math.round(r.h))
    if (w < 1 || h < 1) return
    snapshot()
    var c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d').drawImage(old, x, y, w, h, 0, 0, w, h)
    state.base = c
    state.redactions = []
    state.tool = null
    redraw()
    updateUi()
  }

  function attachDrawing() {
    var drawing = false
    var start = null
    var pid = null
    function pos(e) {
      var r = canvas.getBoundingClientRect()
      return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height }
    }
    canvas.addEventListener('pointerdown', function (e) {
      if (!state || !state.tool || !e.isPrimary) return
      drawing = true
      start = pos(e)
      pid = e.pointerId
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing || e.pointerId !== pid) return
      var p = pos(e)
      redraw()
      ctx.save()
      if (state.tool === 'crop') {
        ctx.strokeStyle = '#0d6efd'
        ctx.lineWidth = Math.max(2, canvas.width / 300)
        ctx.setLineDash([8, 6])
        ctx.strokeRect(start.x, start.y, p.x - start.x, p.y - start.y)
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fillRect(start.x, start.y, p.x - start.x, p.y - start.y)
      }
      ctx.restore()
    })
    function finish(e) {
      if (!drawing || e.pointerId !== pid) return
      drawing = false
      var p = pos(e)
      var r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }
      if (state.tool === 'crop') {
        if (r.w >= 40 && r.h >= 40) return crop(r)
      } else if (r.w >= MIN_BOX && r.h >= MIN_BOX) {
        snapshot()
        state.redactions.push({ x: r.x, y: r.y, w: r.w, h: r.h, type: state.tool === 'pixel' ? 'pixel' : 'black' })
        updateUi()
      }
      redraw()
    }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', function () {
      drawing = false
      redraw()
    })
  }

  // ---- Foto(s) verschieben: neue Anzeige oder anderer Entwurf --------------
  // POST /anzeige/:az/images/move (wie Drag & Drop in der Liste). Ausgewählt
  // sind die angehakten Kacheln, ohne Häkchen das aktuelle Foto.
  var moveTargets = null
  var reloadOnClose = false
  function pickedIds() {
    var s = state
    var puts = Object.keys(s.picked)
    if (!puts.length) puts = [s.put]
    return puts.map(function (u) { return Number(String(u).split('/').pop()) })
  }
  function updateMoveLabel() {
    var n = state ? Object.keys(state.picked).length : 0
    dlg.querySelector('[data-act=move-menu]').textContent = n ? '↗ ' + n + ' verschieben' : '↗ Verschieben'
  }
  function toggleMoveMenu() {
    var s = state
    var menu = dlg.querySelector('.photo-edit-move-menu')
    if (!menu.hidden || !s) { menu.hidden = true; return }
    var n = pickedIds().length
    menu.querySelector('[data-move-title]').textContent = (n === 1 ? (Object.keys(s.picked).length ? '1 Foto' : 'Dieses Foto') : n + ' Fotos') + ' verschieben nach …'
    menu.querySelector('[data-move-search]').value = ''
    var btn = dlg.querySelector('[data-act=move-menu]').getBoundingClientRect()
    menu.hidden = false
    // Rechtsbündig unter dem Knopf, aber immer ganz im Bild (Handy).
    var w = menu.offsetWidth
    menu.style.top = btn.bottom + 6 + 'px'
    menu.style.left = Math.max(8, Math.min(btn.right - w, window.innerWidth - w - 8)) + 'px'
    moveTargets = null
    renderMoveList()
    var az = s.az
    fetch('/pruefen/' + encodeURIComponent(az) + '/ziele', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok && !r.redirected ? r.json() : { drafts: [] } })
      .catch(function () { return { drafts: [] } })
      .then(function (d) {
        if (!state || state.az !== az) return
        moveTargets = d.drafts || []
        renderMoveList()
      })
  }
  function renderMoveList() {
    var list = dlg.querySelector('[data-move-list]')
    list.replaceChildren()
    if (!moveTargets) return list.appendChild(el('div', 'small text-muted', 'Entwürfe werden geladen …'))
    var q = dlg.querySelector('[data-move-search]').value.toLowerCase().trim()
    var shown = moveTargets.filter(function (d) {
      return !q || (d.az + ' ' + d.kennzeichen + ' ' + d.tatort + ' ' + d.wann).toLowerCase().indexOf(q) !== -1
    }).slice(0, 30)
    if (!shown.length) list.appendChild(el('div', 'small text-muted', 'Keine passenden Entwürfe.'))
    shown.forEach(function (d) {
      var b = el('button', 'list-group-item list-group-item-action d-flex gap-2 align-items-center px-1')
      b.type = 'button'
      b.setAttribute('data-move-az', d.az)
      if (d.thumb) {
        var im = el('img', 'rounded')
        im.src = d.thumb
        im.alt = ''
        b.appendChild(im)
      }
      var tx = el('span', 'small text-start')
      tx.appendChild(el('strong', '', d.kennzeichen || '(ohne Kennzeichen)'))
      tx.appendChild(el('span', 'text-muted', ' · ' + [d.wann, d.az].filter(Boolean).join(' · ')))
      if (d.tatort) {
        tx.appendChild(document.createElement('br'))
        tx.appendChild(el('span', 'text-muted', d.tatort))
      }
      b.appendChild(tx)
      list.appendChild(b)
    })
  }
  function moveTo(dest) {
    var s = state
    if (!s || s.busy) return
    if (s.dirty && !confirm('Ungespeicherte Änderungen am Foto verwerfen?')) return
    var ids = pickedIds()
    dlg.querySelector('.photo-edit-move-menu').hidden = true
    s.busy = true
    updateUi()
    fetch('/anzeige/' + encodeURIComponent(s.az) + '/images/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ imageIds: ids, targetAz: dest.targetAz, newDraft: !!dest.newDraft }),
    })
      .then(function (r) {
        return r.json().catch(function () { return {} }).then(function (d) {
          if (!r.ok || r.redirected) throw new Error(d.error || 'Verschieben fehlgeschlagen.')
          return d
        })
      })
      .then(function (d) {
        var to = d.targetAz
        document.dispatchEvent(new CustomEvent('owia:photos-moved', { detail: { from: s.az, to: to, newDraft: !!dest.newDraft } }))
        // Liste: Zielzeile auffrischen; neue Anzeige hat noch keine Zeile.
        if (rowOf(to) && window.reportTableRefresh) Promise.resolve(window.reportTableRefresh(to)).catch(function () {})
        else if (!window.photoEditorRun) reloadOnClose = true
        s.busy = false
        s.picked = {}
        var movedCurrent = ids.indexOf(Number(String(s.put).split('/').pop())) !== -1
        return Promise.resolve(window.reportTableRefresh ? window.reportTableRefresh(s.az) : null).then(function () {
          if (state !== s) return
          var host = rowOf(s.az)
          var all = host ? Array.prototype.slice.call(host.querySelectorAll('[data-photo-edit]')) : []
          if (!all.length) {
            // Keine Fotos mehr übrig: leere Anzeige gleich verwerfen?
            if (confirm('Diese Anzeige hat keine Fotos mehr. In den Papierkorb verschieben?')) return trashReport()
            return runDone('skipped')
          }
          if (!movedCurrent) {
            var mine = all.filter(function (x) { return x.getAttribute('data-photo-edit') === s.put })[0]
            if (mine) {
              s.thumbs = all
              s.thumb = mine
              s.pos = all.indexOf(mine) + 1
              s.total = all.length
              renderStrip()
              updateMoveLabel()
              updateUi()
              loadStatus(s)
              return
            }
          }
          openThumb(all.filter(function (x) { return x.getAttribute('data-geprueft') === '0' })[0] || all[0])
        })
      })
      .catch(function (err) {
        s.busy = false
        if (state === s) updateUi()
        alert(err.message)
      })
  }

  function close() {
    var az = state && state.az
    dlg.querySelector('.photo-edit-move-menu').hidden = true
    dlg.close()
    document.documentElement.classList.remove('has-editor-dialog')
    state = null
    detailsAz = null
    mapAz = null
    // Erst nach dem Schließen: review.js baut die Karte dann komplett neu.
    if (az) flushHost(az)
    // Liste: nach Verschieben in eine neue Anzeige gibt es eine neue Zeile.
    if (reloadOnClose) {
      reloadOnClose = false
      location.reload()
    }
  }

  function cancel() {
    if (state && state.dirty && !confirm('Änderungen am Foto verwerfen?')) return
    // Ein getipptes Kennzeichen nicht verlieren, nur weil das Foto nicht
    // bestätigt wurde.
    savePlate().catch(function () {})
    close()
  }

  // Zeile der Anzeigen-Liste bzw. Karte des Prüf-Modus (review.js).
  function rowOf(az) {
    var q = '="' + (window.CSS && CSS.escape ? CSS.escape(az) : az) + '"'
    return document.querySelector('tr[data-az' + q + '], [data-review-card][data-az' + q + ']')
  }

  // Nach Bestätigen/Löschen: Zeile neu laden (neue Vorschaubilder, Status) und
  // das nächste ungeprüfte Foto derselben Anzeige öffnen – sonst schließen.
  // Sind alle geprüft, bleibt der Dialog auf dem aktuellen Foto stehen – die
  // Statuszeile zeigt dann, ob die Anzeige eingereicht werden kann.
  function next(az) {
    var s = state
    var done = function () {
      var row = rowOf(az)
      var t = row && row.querySelector('[data-photo-edit][data-geprueft="0"]')
      if (t) return openThumb(t)
      var all = row ? Array.prototype.slice.call(row.querySelectorAll('[data-photo-edit]')) : []
      var mine = all.filter(function (x) { return x.getAttribute('data-photo-edit') === s.put })[0]
      if (!mine) return all.length ? openThumb(all[0]) : close()
      if (state !== s) return
      s.thumbs = all
      s.thumb = mine
      s.ok = true
      s.open = 0
      s.pos = all.indexOf(mine) + 1
      s.total = all.length
      renderStrip()
      updateUi()
      loadStatus(s)
      var sub = dlg.querySelector('[data-act=submit]')
      setTimeout(function () { if (readyToSubmit()) sub.focus() }, 400)
    }
    if (!window.reportTableRefresh) return close()
    return Promise.resolve(window.reportTableRefresh(az)).then(done, close)
  }

  function save() {
    if (!state || !state.base || state.busy) return
    var s = state
    var btn = dlg.querySelector('[data-act=save]')
    s.busy = true
    btn.textContent = s.dirty ? 'Speichert …' : 'Bestätigt …'
    updateUi()
    redraw() // keine Zeichen-Vorschau im Export
    var upload = !s.dirty
      ? Promise.resolve()
      : new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.9) }).then(function (blob) {
          var fd = new FormData()
          fd.append('bilder', blob, 'bearbeitet.jpg')
          return fetch(s.put, { method: 'PUT', body: fd })
        }).then(function (r) {
          if (!r.ok || r.redirected) throw new Error()
          s.dirty = false
        })
    upload.catch(function () {}) // Fehler meldet die Kette unten
    savePlate()
      .then(function () { return upload })
      .then(function () { return fetch(s.put + '/geprueft', { method: 'POST' }) })
      .then(function (r) {
        if (!r.ok || r.redirected) throw new Error()
        return next(s.az)
      })
      .catch(function (err) {
        // savePlate() hat seinen Fehler schon gemeldet.
        if (!err || !err.message) alert('Speichern fehlgeschlagen – bitte erneut versuchen.')
      })
      .finally(function () {
        s.busy = false
        if (state === s) updateUi()
      })
  }

  function remove() {
    if (!state || state.busy || !confirm('Dieses Foto endgültig aus dem Entwurf löschen?')) return
    var s = state
    s.busy = true
    updateUi()
    fetch(s.put, { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok || r.redirected) throw new Error()
        return next(s.az)
      })
      .catch(function () { alert('Foto konnte nicht gelöscht werden.') })
      .finally(function () {
        s.busy = false
        if (state === s) updateUi()
      })
  }

  // Foto aus einer Listen-Miniatur (data-photo-edit, data-full-src) öffnen.
  function openThumb(t) {
    var row = t.closest('[data-az]')
    var all = row ? Array.prototype.slice.call(row.querySelectorAll('[data-photo-edit]')) : [t]
    var plateEl = row && row.querySelector('[data-inline-field="kennzeichen"]')
    var markeEl = row && row.querySelector('[data-inline-field="fahrzeug_marke"]')
    var verstossEl = row && row.querySelector('[data-inline-field="verstoss_art"]')
    var tatortEl = row && row.querySelector('[data-inline-field="tatort"]')
    open({
      tatort: tatortEl ? tatortEl.value : null,
      verstoss: verstossEl ? verstossEl.value : null,
      marke: markeEl ? markeEl.value : null,
      thumb: t,
      thumbs: all,
      plate: plateEl ? plateEl.value : null,
      detected: t.getAttribute('data-detected-plate') || null,
      src: t.getAttribute('data-full-src'),
      put: t.getAttribute('data-photo-edit'),
      az: row && row.getAttribute('data-az'),
      ok: t.getAttribute('data-geprueft') === '1',
      pos: all.indexOf(t) + 1,
      total: all.length,
      open: all.filter(function (x) { return x !== t && x.getAttribute('data-geprueft') === '0' }).length,
    })
  }

  // opts: { src: Bild-URL, put: PUT-URL der Fassung, az, ok, pos, total, open, tool,
  //         plate (Kennzeichen der Anzeige; null = kein Abgleich), marke, verstoss, detected }
  function open(opts) {
    if (!dlg) build()
    var plate = opts.plate != null && opts.az ? normPlate(opts.plate) : null
    var marke = plate != null && opts.marke != null ? String(opts.marke).trim() : null
    var verstoss = plate != null && opts.verstoss != null && window.verstossSelect ? String(opts.verstoss) : null
    verstossHidden().value = verstoss || ''
    verstossInput().value = verstoss || ''
    verstossHidden().closest('.pe-field').hidden = verstoss == null
    var tatort = plate != null && opts.tatort != null ? String(opts.tatort).replace(/\s+/g, ' ').trim() : null
    tatortInput().value = tatort || ''
    tatortInput().closest('.photo-edit-tatort').hidden = tatort == null
    chosenCoords = null
    // Bericht-Status nur behalten, wenn es dieselbe Anzeige bleibt (kein Flackern).
    var keepReport = state && state.az === opts.az ? state.report : null
    // Neue Anzeige: Seitenleiste (und auf dem Handy der ganze Dialog) oben
    // beginnen – sonst blieb die Scroll-Position der vorherigen stehen.
    if (!state || state.az !== opts.az) {
      dlg.querySelector('.photo-edit-fields').scrollTop = 0
      dlg.querySelector('.photo-edit-body').scrollTop = 0
    }
    plateInput().value = plate || ''
    markeInput().value = marke || ''
    markeInput().closest('.pe-field').hidden = marke == null
    state = {
      plate: plate, marke: marke, verstoss: verstoss, tatort: tatort, report: keepReport, detected: opts.detected ? normPlate(opts.detected) : null,
      thumb: opts.thumb || null, thumbs: opts.thumbs || null,
      // Häkchen für „Verschieben" bleiben beim Fotowechsel derselben Anzeige.
      picked: state && state.az === opts.az && state.picked ? state.picked : {},
      put: opts.put, az: opts.az, base: null, redactions: [], history: [], tool: opts.tool || null, dirty: false,
      ok: !!opts.ok, pos: opts.pos || 1, total: opts.total || 1, open: opts.open || 0, busy: false,
    }
    renderStrip()
    updateMoveLabel()
    canvas.width = 1
    canvas.height = 1
    msg('Foto wird geladen …')
    if (!dlg.open) dlg.showModal()
    document.documentElement.classList.add('has-editor-dialog')
    updateUi()
    var s = state
    loadStatus(s)
    var img = new Image()
    img.onload = function () {
      if (state !== s) return
      var scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
      var c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * scale))
      c.height = Math.max(1, Math.round(img.naturalHeight * scale))
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      state.base = c
      msg('')
      redraw()
      updateUi()
      dlg.querySelector('[data-act=save]').focus()
    }
    img.onerror = function () { if (state === s) msg('Foto konnte nicht geladen werden.') }
    img.src = opts.src
  }

  // „🔍 N Fotos prüfen" unter den Miniaturen: erstes ungeprüftes Foto öffnen.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-review-photos]')
    if (!b) return
    var row = b.closest('[data-az]')
    var t = row && row.querySelector('[data-photo-edit][data-geprueft="0"]')
    if (t) openThumb(t)
  })

  window.photoEditor = {
    open: open,
    openThumb: openThumb,
    close: function () { if (dlg && dlg.open) close() },
    isOpen: function () { return !!(dlg && dlg.open) },
  }
})()
