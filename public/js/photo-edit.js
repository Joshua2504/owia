// Foto-Prüfung in der Anzeigen-Liste: Jedes Entwurfs-Foto startet ungeprüft.
// Klick aufs Foto (data-photo-edit, s. image-preview.js) öffnet es hier als
// Vollbild-Dialog; man schwärzt/verpixelt/schneidet bei Bedarf und bestätigt –
// ohne Werkzeugwahl: Ziehen auf dem Foto schwärzt (bzw. verpixelt, wenn
// umgeschaltet), Ränder/Ecken des Rahmens ziehen schneidet zu. Jede Schwärzung
// und jeder Datenschutz-Vorschlag hat seine Knöpfe direkt am Bereich.
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
      '<div class="photo-edit-canvas"><canvas></canvas><div class="photo-edit-marks"></div><div class="photo-edit-msg"></div></div>' +
      // Bildwerkzeuge unten mittig unter dem Foto (nicht darüber – sonst
      // ließe sich am unteren Bildrand nicht schwärzen).
      '<div class="photo-edit-tools">' +
      '<span class="photo-edit-hint small"></span>' +
      '<div class="d-flex flex-wrap justify-content-center gap-2">' +
      '<div class="btn-group btn-group-sm" role="group" aria-label="Ziehen auf dem Foto …">' +
      '<button type="button" class="btn btn-outline-light" data-tool="black" title="Ziehen auf dem Foto schwärzt">⬛ Schwärzen</button>' +
      '<button type="button" class="btn btn-outline-light" data-tool="pixel" title="Ziehen auf dem Foto verpixelt">▩ Verpixeln</button>' +
      '<button type="button" class="btn btn-outline-info" data-tool="plate" title="Rechteck über das Kennzeichen des angezeigten Fahrzeugs ziehen – die Übersichtskarte schwärzt es">🚗 Kennzeichen</button>' +
      '</div>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="kz-keins" title="Auf diesem Foto ist das Kennzeichen des Fahrzeugs nicht zu sehen" hidden>Kein Kennzeichen sichtbar</button>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="crop-reset" title="Zuschnitt aufheben" hidden>⤢ Ganzes Foto</button>' +
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
      // Kennzeichen, Typ, Marke nebeneinander – die Leiste soll ohne Scrollen passen.
      '<div class="pe-row pe-row-kfz">' +
      '<div class="pe-field"><label class="form-label" for="photo-edit-plate-input">Kennzeichen</label>' +
      '<div class="input-group flex-nowrap"><select id="pe-land" data-native class="form-select photo-edit-details" style="flex:0 0 3.6rem;width:3.6rem;padding-left:.45rem;padding-right:1.3rem;background-position:right .3rem center" data-detail="kennzeichen_land" aria-label="Länderkennzeichen" title="Land des Kennzeichens" hidden><option value="D">D</option></select>' +
      '<input type="text" id="photo-edit-plate-input" class="form-control plate-field" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>' +
      '<button type="button" class="btn btn-sm btn-outline-warning mt-1" data-act="plate-suggest" hidden></button></div>' +
      '<div class="pe-field photo-edit-details" hidden><label class="form-label" for="pe-typ">Typ</label><select id="pe-typ" class="form-select" data-detail="fahrzeug_typ"></select></div>' +
      '<div class="pe-field"><label class="form-label" for="photo-edit-marke-input">Marke</label>' +
      '<input type="text" id="photo-edit-marke-input" class="form-control photo-edit-marke" maxlength="100" autocomplete="off" placeholder="z. B. Volkswagen" list="pe-marken"></div>' +
      '</div>' +
      // Fahrzeug direkt unter Kennzeichen/Marke (gleicher Speicherweg wie die
      // übrigen Details, daher ebenfalls .photo-edit-details).
      '<div class="photo-edit-details" hidden>' +
      '<div class="pe-row">' +
      '<div class="pe-field"><label class="form-label" for="pe-modell">Modell</label><input type="text" id="pe-modell" class="form-control" data-detail="fahrzeug_modell" maxlength="60" autocomplete="off"></div>' +
      '<div class="pe-field"><label class="form-label" for="pe-farbe">Farbe</label><input type="text" id="pe-farbe" class="form-control" data-detail="fahrzeug_farbe" maxlength="40" autocomplete="off" list="pe-farben"></div>' +
      '</div>' +
      '<datalist id="pe-marken"></datalist><datalist id="pe-farben"></datalist>' +
      '</div>' +
      // Datenschutz: erkannte fremde Kennzeichen/Gesichter (services/dritte.ts).
      '<div class="pe-field" data-dritte-row hidden>' +
      '<div class="alert alert-warning py-1 px-2 small mb-0" data-dritte-text></div>' +
      '</div>' +
      // Portal-Städte: die Reihenfolge entscheidet über die Rolle
      // (services/portalFfm.ts photoRoles) – Foto 1 Übersicht, Rest Fahrzeug.
      '<div class="pe-field small text-muted" data-rolle-row hidden><span data-rolle-info></span> ' +
      '<span data-rolle-hint>Foto 1 ist die Übersicht, die weiteren sind Fahrzeugfotos – Reihenfolge links per Ziehen oder ‹ › ändern.</span></div>' +
      '<div class="pe-field"><label class="form-label">Verstoß</label>' +
      '<div class="photo-edit-verstoss position-relative">' +
      '<input type="hidden">' +
      '<input type="text" class="form-control" data-verstoss-input autocomplete="off" spellcheck="false" placeholder="Verstoß suchen …" aria-label="Verstoß">' +
      '</div>' +
      // Konkretisierung („Kreuzung/Einmündung") und „länger als 1 Stunde" – das
      // Frankfurter Portal fragt beides ab (Werte aus GET /pruefen/:az/daten).
      '<select class="form-select form-select-sm mt-1" data-variante hidden aria-label="Verstoß genauer"></select>' +
      '<div class="small mt-1" data-langparker hidden>⏱ Länger als 1 Stunde: ' +
      '<button type="button" class="btn btn-link btn-sm p-0 align-baseline text-start" data-act="langparker"></button></div>' +
      '</div>' +
      '<div class="pe-field photo-edit-tatort"><label class="form-label" for="photo-edit-tatort-input">Tatort</label>' +
      '<div class="d-flex gap-1">' +
      '<input type="text" id="photo-edit-tatort-input" class="form-control" data-geo-scope="unlocked" data-fill="full" data-ac-local' +
      ' autocomplete="off" spellcheck="false" placeholder="Adresse eingeben …">' +
      '<button type="button" class="btn btn-outline-secondary" data-act="tatort-photo" title="Tatort aus den GPS-Daten der Fotos">📍</button>' +
      '</div>' +
      '<div class="photo-edit-map rounded border mt-1" title="Marker zur genauen Stelle ziehen – danach Adresse übernehmen oder behalten."></div>' +
      // Nach dem Verschieben des Markers: neue Adresse übernehmen oder nur die Position.
      '<div class="alert alert-info py-1 px-2 small mt-1 mb-0" data-adr-vorschlag hidden>' +
      '<div>Neue Adresse an dieser Stelle: <strong data-adr-text></strong></div>' +
      '<div class="d-flex gap-2 mt-1"><button type="button" class="btn btn-sm btn-primary" data-act="adr-ok">Übernehmen</button>' +
      '<button type="button" class="btn btn-sm btn-outline-secondary" data-act="adr-nein">Adresse behalten</button></div></div>' +
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
      b.addEventListener('click', function () { setTool(b.dataset.tool) })
    })
    dlg.querySelector('[data-act=crop-reset]').addEventListener('click', function () {
      if (!state || !state.crop) return
      snapshot()
      state.crop = null
      redraw()
      updateUi()
    })
    // Knöpfe an Schwärzungen und Vorschlägen (renderMarks).
    dlg.querySelector('.photo-edit-marks').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mark]')
      if (!b || !state || state.busy) return
      var i = Number(b.getAttribute('data-i'))
      var art = b.getAttribute('data-mark')
      if (art === 'kz-entfernen') {
        kzSetzen(null, false)
        setTool('plate')
      } else if (art === 'entfernen') {
        snapshot()
        state.redactions.splice(i, 1)
      } else if (art === 'schwaerzen') {
        var alle = vorschlagBoxen(state)
        var box = typeof alle === 'string' ? null : alle[i]
        if (!box) return
        snapshot()
        state.redactions.push({ x: box.x, y: box.y, w: box.w, h: box.h, type: 'black' })
      } else if (art === 'freigeben') {
        state.freigegeben[i] = true
      }
      redraw()
      updateUi()
      if (art !== 'entfernen' && art !== 'kz-entfernen') dritteErledigt()
    })
    dlg.querySelector('[data-act=kz-keins]').addEventListener('click', function () {
      if (!state || state.busy) return
      kzSetzen(null, !state.kzKeins)
      if (!state.kzKeins) setTool('plate')
    })
    window.addEventListener('resize', function () { if (dlg.open && state && state.base) renderMarks() })
    dlg.querySelector('[data-act=rotate]').addEventListener('click', rotate)
    dlg.querySelector('[data-act=undo]').addEventListener('click', undo)
    dlg.querySelector('[data-act=cancel]').addEventListener('click', cancel)
    dlg.querySelector('[data-act=save]').addEventListener('click', save)
    dlg.querySelector('[data-act=delete]').addEventListener('click', remove)
    dlg.querySelector('[data-act=plate-suggest]').addEventListener('click', function () {
      plateInput().value = state.detected
      savePlate().then(updateUi, function () {})
    })
    plateInput().addEventListener('input', function () {
      if (kzInEl) kzInEl.value = plateInput().value
      updateUi()
    })
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
      var s0 = state
      flushSave(s0).then(savePlate).then(function () { if (state === s0) openThumb(t) }, function (err) { alert((err && err.message) || 'Speichern fehlgeschlagen.') })
    })
    // Reihenfolge per Drag & Drop (Desktop); auf dem Handy die Pfeile. Die
    // Kacheln weichen schon beim Ziehen aus (DOM live umsortiert, mit kurzer
    // Gleit-Animation); gespeichert wird erst beim Loslassen.
    var dragFrom = null
    var dragEl = null
    var dropped = false
    strip.addEventListener('dragstart', function (e) {
      var b = e.target.closest('[data-strip-index]')
      if (!b) return
      dragFrom = Number(b.getAttribute('data-strip-index'))
      dragEl = b
      dropped = false
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(dragFrom))
      e.stopPropagation() // nicht report-table.js (Foto in andere Anzeige ziehen)
      // Erst nach dem Start abblenden – sonst wäre auch das Zieh-Bild blass.
      setTimeout(function () { if (dragEl === b) b.classList.add('is-dragging') }, 0)
    })
    strip.addEventListener('dragover', function (e) {
      if (dragFrom === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      var t = e.target.closest('[data-strip-index]')
      if (!t || t === dragEl || t.dataset.anim) return
      var r = t.getBoundingClientRect()
      var quer = getComputedStyle(strip).flexDirection === 'row'
      var nach = quer ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2
      var ref = nach ? t.nextSibling : t
      if (ref === dragEl || ref === dragEl.nextSibling) return
      flipMove(strip, function () { strip.insertBefore(dragEl, ref) })
    })
    strip.addEventListener('drop', function (e) {
      if (dragFrom === null) return
      e.preventDefault()
      dropped = true
      var from = dragFrom
      var to = Array.prototype.indexOf.call(strip.children, dragEl)
      dragFrom = null
      dragEl = null
      if (to !== -1 && to !== from) reorder(from, to)
      else renderStrip()
    })
    strip.addEventListener('dragend', function () {
      if (dragFrom === null && dropped) return
      dragFrom = null
      dragEl = null
      if (state) renderStrip() // abgebrochen: alte Reihenfolge zeigen
    })
    plateInput().addEventListener('change', function () { savePlate().catch(function () {}) })
    // Tatort: Vorschläge (address-autocomplete.js, im Layout geladen) beim
    // ersten Fokus; gewählter Vorschlag speichert mit Koordinaten, frei
    // getippter Text beim Verlassen ohne (wie report-inline.js).
    tatortInput().addEventListener('focus', function () {
      if (window.addressAutocomplete) window.addressAutocomplete.init(tatortInput())
    })
    tatortInput().addEventListener('address:chosen', function (e) {
      if (state) adrVorschlag(state, null)
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
    dlg.querySelectorAll('.photo-edit-details').forEach(function (el) { el.addEventListener('change', onDetailChange) })
    function onDetailChange(e) {
      var f = e.target.getAttribute && e.target.getAttribute('data-detail')
      if (!f) return
      var v = e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value.trim()
      if (f === 'kennzeichen_land' && kzLandEl && e.target !== kzLandEl) kzLandEl.value = v
      if (f === 'behinderung') {
        dlg.querySelector('[data-detail=behinderung_text]').hidden = v !== '1'
        if (v === '1') setTimeout(function () { dlg.querySelector('[data-detail=behinderung_text]').focus() }, 0)
      }
      var body = {}
      body[f] = v
      saveDetail(body)
    }
    dlg.querySelector('[data-act=skip]').addEventListener('click', function () { runDone('skipped') })
    dlg.querySelector('[data-act=trash-report]').addEventListener('click', trashReport)
    markeInput().addEventListener('change', function () { savePlate().catch(function () {}) })
    dlg.querySelector('[data-variante]').addEventListener('change', function (e) {
      saveDetail({ verstoss_variante: e.target.value })
    })
    dlg.querySelector('[data-act=adr-ok]').addEventListener('click', function () {
      var v = state && state.adrVorschlag
      if (!v) return
      tatortInput().value = v.label
      chosenCoords = v.coords
      adrVorschlag(state, null)
      savePlate().catch(function () {})
    })
    dlg.querySelector('[data-act=adr-nein]').addEventListener('click', function () {
      if (state) adrVorschlag(state, null)
    })
    dlg.querySelector('[data-act=langparker]').addEventListener('click', function (e) {
      var label = e.currentTarget.dataset.label
      if (!label) return
      verstossHidden().value = label
      verstossInput().value = label
      savePlate().catch(function () {})
    })
    // Auswahllisten aus dem Katalog-Endpunkt (einmal je Seite).
    loadCatalog().then(function (c) {
      var typ = dlg.querySelector('#pe-typ')
      typ.innerHTML = (c.fahrzeugTypen || ['PKW']).map(function (t) { return '<option>' + t + '</option>' }).join('')
      if (state && state.report) typ.value = state.report.fields.fahrzeug_typ || 'PKW'
      var land = dlg.querySelector('#pe-land')
      var laender = c.laender || { D: 'Deutschland' }
      // D zuerst, dann nach Ländername (wie geliefert); data-name für die
      // ausgeklappte Ansicht „PL – Polen" (landLang).
      land.innerHTML = Object.keys(laender).map(function (k) { return '<option value="' + k + '" title="' + laender[k] + '" data-name="' + laender[k] + '">' + k + '</option>' }).join('')
      landLang(land)
      if (state && state.report) land.value = state.report.fields.kennzeichen_land || 'D'
      dlg.querySelector('#pe-marken').innerHTML = (c.marken || []).map(function (m) { return '<option value="' + m + '">' }).join('')
      dlg.querySelector('#pe-farben').innerHTML = (c.farben || []).map(function (m) { return '<option value="' + m + '">' }).join('')
    }).catch(function () {})
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
    // Felder mit Vorschlagsliste (Marke, Farbe – <datalist>): Enter übernimmt
    // den ersten Vorschlag, wie ihn der Browser zeigt (enthält den Text).
    // capture: vor den Enter-Handlern, die den Wert dann speichern.
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !e.target.list || !e.target.value.trim()) return
      var v = e.target.value.trim().toLowerCase()
      var opts = [].map.call(e.target.list.options, function (o) { return o.value })
      if (opts.some(function (o) { return o.toLowerCase() === v })) return
      var hit = opts.filter(function (o) { return o.toLowerCase().indexOf(v) === 0 })[0] ||
        opts.filter(function (o) { return o.toLowerCase().indexOf(v) !== -1 })[0]
      if (hit) e.target.value = hit
    }, true)
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
      if (e.target === plateInput() || e.target === markeInput() || e.target === kzInEl) {
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
    attachZoom()
  }

  // ---- Zoom: Mausrad zoomt zum Mauszeiger, mittlere Maustaste (oder Alt +
  // Ziehen) verschiebt, Doppelklick setzt zurück. Nur CSS-Transform am Canvas –
  // bildRect() rechnet über getBoundingClientRect, Zeichnen bleibt exakt.
  var zoom = { z: 1, x: 0, y: 0 }
  function applyZoom() {
    canvas.style.transformOrigin = '0 0'
    canvas.style.transform = zoom.z === 1 ? '' : 'translate(' + zoom.x + 'px,' + zoom.y + 'px) scale(' + zoom.z + ')'
    if (state && state.base && !state.drawing) redraw()
  }
  function resetZoom() {
    zoom = { z: 1, x: 0, y: 0 }
    applyZoom()
  }
  function attachZoom() {
    var wrap = dlg.querySelector('.photo-edit-canvas')
    wrap.addEventListener('wheel', function (e) {
      if (!state || !state.base) return
      e.preventDefault()
      var z = Math.max(1, Math.min(10, zoom.z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))))
      if (z === 1) return resetZoom()
      var r = canvas.getBoundingClientRect()
      zoom.x += (e.clientX - r.left) * (1 - z / zoom.z)
      zoom.y += (e.clientY - r.top) * (1 - z / zoom.z)
      zoom.z = z
      applyZoom()
    }, { passive: false })
    var pan = null
    wrap.addEventListener('pointerdown', function (e) {
      if (zoom.z === 1 || !(e.button === 1 || (e.button === 0 && e.altKey))) return
      e.preventDefault()
      e.stopPropagation()
      pan = { id: e.pointerId, x: e.clientX - zoom.x, y: e.clientY - zoom.y }
      wrap.setPointerCapture(e.pointerId)
      wrap.style.cursor = 'grabbing'
    }, true)
    wrap.addEventListener('pointermove', function (e) {
      if (!pan || e.pointerId !== pan.id) return
      zoom.x = e.clientX - pan.x
      zoom.y = e.clientY - pan.y
      applyZoom()
    })
    var stop = function (e) {
      if (!pan || e.pointerId !== pan.id) return
      pan = null
      wrap.style.cursor = ''
    }
    wrap.addEventListener('pointerup', stop)
    wrap.addEventListener('pointercancel', stop)
    wrap.addEventListener('auxclick', function (e) { if (e.button === 1) e.preventDefault() })
    wrap.addEventListener('dblclick', function (e) {
      if (e.target.closest('input,button')) return
      resetZoom()
    })
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
    fitMenu(verstossHidden().parentNode, verstossInput())
    if (kzVerstossEl) fitMenu(kzVerstossEl, kzVerstossEl.querySelector('[data-verstoss-input]'))
  }
  function fitMenu(root, input) {
    var menu = root.querySelector('.list-group')
    if (!menu) return
    var r = input.getBoundingClientRect()
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

  // Katalog (alle/haeufig/fahrzeugTypen/marken/farben) und Kennzeichen-
  // Normalisierung (wie normalizePlate() in routes/reports.ts) aus common.js.
  var loadCatalog = window.OWIA.loadCatalog
  var normPlate = window.OWIA.normalizePlate
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
    return window.OWIA.fetchJson('/anzeige/' + encodeURIComponent(s.az) + '/felder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      fallback: 'Kennzeichen konnte nicht gespeichert werden.',
    })
      .then(function (d) {
        var vals = d.values || {}
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

  // Kacheln umsortieren und von der alten zur neuen Position gleiten lassen.
  function flipMove(box, change) {
    var tiles = Array.prototype.slice.call(box.children)
    var vorher = tiles.map(function (t) { return t.getBoundingClientRect() })
    change()
    tiles.forEach(function (t, i) {
      var b = t.getBoundingClientRect()
      var dx = vorher[i].left - b.left
      var dy = vorher[i].top - b.top
      if (!dx && !dy) return
      t.dataset.anim = '1' // während der Animation kein Drop-Ziel (sonst Flackern)
      t.style.transition = 'none'
      t.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
      requestAnimationFrame(function () {
        t.style.transition = 'transform 160ms ease'
        t.style.transform = ''
        setTimeout(function () { delete t.dataset.anim; t.style.transition = '' }, 170)
      })
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
      // Aufnahmezeit (EXIF), damit die Reihenfolge/Spanne auf einen Blick sichtbar ist.
      if (t.getAttribute('data-zeit')) b.appendChild(el('span', 'photo-edit-tile-zeit', t.getAttribute('data-zeit')))
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
    renderRolle(state)
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
    if (!state.busy) saveBtn.textContent = '✓ Bestätigen'
    dlg.querySelector('[data-act=delete]').disabled = !!state.busy
    var mvb = dlg.querySelector('[data-act=move-menu]')
    mvb.hidden = state.plate == null
    mvb.disabled = !!state.busy
    var st = dlg.querySelector('.photo-edit-status')
    st.textContent = 'Foto ' + state.pos + '/' + state.total + ' · ' + (state.ok ? '✓ geprüft' : 'ungeprüft') +
      (state.open ? ' · noch ' + state.open + ' offen' : '') +
      (state.saveErr ? ' · ⚠ nicht gespeichert' : state.saving ? ' · speichert …' : unsaved(state) ? ' · ● Änderungen offen' : state.gespeichert ? ' · gespeichert' : '')
    st.classList.toggle('is-ok', state.ok)
    st.classList.toggle('is-open', !state.ok)
    var hint = dlg.querySelector('.photo-edit-hint')
    var fehlt = state.base && kzFehlt(state)
    hint.textContent = fehlt
      ? 'Bitte das Kennzeichen des Fahrzeugs markieren: Rechteck darüber ziehen – oder „Kein Kennzeichen sichtbar".'
      : (state.tool === 'plate' ? 'Rechteck über das Kennzeichen ziehen' : state.tool === 'pixel' ? 'Ziehen auf dem Foto verpixelt' : 'Ziehen auf dem Foto schwärzt') +
        ' · Ränder und Ecken ziehen schneidet zu.'
    hint.classList.toggle('text-warning', !!fehlt)
    hint.classList.toggle('fw-semibold', !!fehlt)
    if (kzInEl && state.plate != null) {
      if (document.activeElement !== kzInEl) kzInEl.value = plateInput().value
      kzSyncKlassen()
      kzLandSync()
      kzMehrSync()
    }
    var keinsBtn = dlg.querySelector('[data-act=kz-keins]')
    keinsBtn.hidden = !kzPflicht(state) || !!state.kz
    keinsBtn.classList.toggle('active', !!state.kzKeins)
    keinsBtn.textContent = state.kzKeins ? '✓ Kein Kennzeichen sichtbar' : 'Kein Kennzeichen sichtbar'
    dlg.querySelector('[data-tool=plate]').hidden = !kzPflicht(state)
    canvas.classList.toggle('editing', !!state.base)
    dlg.querySelector('[data-act=crop-reset]').hidden = !state.crop
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
    var box = dlg
    dlg.querySelectorAll('.photo-edit-details').forEach(function (el) { el.hidden = !s.report })
    if (!s.report || detailsAz === s.az) return
    detailsAz = s.az
    var f = s.report.fields
    box.querySelector('[data-detail=tattag]').value = f.tattag || ''
    box.querySelector('[data-detail=tatzeit_von]').value = f.tatzeit_von || ''
    box.querySelector('[data-detail=tatzeit_bis]').value = f.tatzeit_bis || ''
    box.querySelector('[data-detail=fahrzeug_verlassen]').checked = !!f.fahrzeug_verlassen
    var landSel = box.querySelector('[data-detail=kennzeichen_land]')
    var landCode = f.kennzeichen_land || 'D'
    if (![].some.call(landSel.options, function (o) { return o.value === landCode })) landSel.add(new Option(landCode, landCode))
    landSel.value = landCode
    var typSel = box.querySelector('[data-detail=fahrzeug_typ]')
    if (!typSel.options.length) typSel.innerHTML = '<option>PKW</option>'
    typSel.value = f.fahrzeug_typ || 'PKW'
    box.querySelector('[data-detail=fahrzeug_modell]').value = f.fahrzeug_modell || ''
    box.querySelector('[data-detail=fahrzeug_farbe]').value = f.fahrzeug_farbe || ''
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
    var box = dlg
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
    var coords = { tatort_lat: Number(p.lat.toFixed(6)), tatort_lon: Number(p.lng.toFixed(6)) }
    fetch('/api/geo/reverse?lat=' + p.lat + '&lon=' + p.lng, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
      .then(function (data) {
        if (state !== s) return
        var label = data && data.result && data.result.label
        // Position immer speichern (mit unveränderter Adresse); eine andere
        // Adresse nur nach Bestätigung (adrVorschlag).
        chosenCoords = coords
        savePlate().catch(function () {})
        var cur = tatortInput().value.replace(/\s+/g, ' ').trim()
        if (label && label !== cur) adrVorschlag(s, label, coords)
        else adrVorschlag(s, null)
      })
  }
  function adrVorschlag(s, label, coords) {
    var box = dlg.querySelector('[data-adr-vorschlag]')
    s.adrVorschlag = label ? { label: label, coords: coords } : null
    box.hidden = !label
    if (label) box.querySelector('[data-adr-text]').textContent = label
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
        // Verstoß-Auswahl: Sperrliste der Stadt dieser Anzeige (Frankfurt-Portal).
        verstossHidden().parentNode.dataset.city = (d.fields && d.fields.city) || ''
        fillDetails(s)
        renderVerstossExtras(s)
        renderRolle(s)
        kzInit(s)
        syncMap(s)
        updateRun()
      })
  }
  // Variante + Langparker-Hinweis passend zum aktuellen Verstoß (bei jedem
  // Status-Laden, denn der Verstoß kann sich im Dialog ändern).
  // Rolle des aktuellen Fotos + Kennzeichnung Ü/F an allen Kacheln – aus der
  // Position im Streifen (wie photoRoles), damit Umsortieren sofort sichtbar ist.
  var ROLLEN = { uebersicht: 'Übersichtsfoto', fahrzeug: 'Fahrzeugfoto', beide: 'Übersichts- und Fahrzeugfoto (einziges Foto)', keine: 'nicht dabei (höchstens 5 Fahrzeugfotos)' }
  var KURZ = { uebersicht: 'Ü', fahrzeug: 'F', beide: 'Ü+F', keine: '–' }
  function rolleAn(i, n) {
    return n < 2 ? 'beide' : i === 0 ? 'uebersicht' : i <= 5 ? 'fahrzeug' : 'keine'
  }
  function currentImage(s) {
    var imgs = (s && s.report && s.report.images) || []
    return imgs.filter(function (i) { return i.put === s.put })[0] || null
  }
  function renderRolle(s) {
    var row = dlg.querySelector('[data-rolle-row]')
    var portal = !!(s && s.report && s.report.portal)
    var imgs = (s && s.report && s.report.images) || null
    var thumbs = (s && s.thumbs) || []
    var info = currentImage(s)
    row.hidden = !info || !portal
    dlg.querySelectorAll('.photo-edit-tile').forEach(function (tile) {
      var i = Number(tile.getAttribute('data-strip-index'))
      var t = thumbs[i]
      var im = imgs && t && imgs.filter(function (x) { return x.put === t.getAttribute('data-photo-edit') })[0]
      var badge = tile.querySelector('.photo-edit-tile-rolle')
      tile.classList.toggle('has-dritte', !!(im && im.dritte && im.dritte.length))
      if (!im || !portal) { if (badge) badge.remove(); return }
      var rolle = rolleAn(i, thumbs.length)
      if (!badge) { badge = document.createElement('span'); badge.className = 'photo-edit-tile-rolle'; tile.appendChild(badge) }
      badge.textContent = (im.dritte && im.dritte.length ? '⚠ ' : '') + KURZ[rolle]
      badge.title = ROLLEN[rolle] + (im.dritte && im.dritte.length ? ' – Daten Dritter erkannt' : '')
    })
    renderDritte(s, info)
    if (!info || !portal) return
    var pos = thumbs.indexOf(s.thumb)
    row.querySelector('[data-rolle-info]').textContent = 'Im Portal: ' + ROLLEN[rolleAn(pos < 0 ? 0 : pos, thumbs.length || 1)] + '.'
    row.querySelector('[data-rolle-hint]').hidden = thumbs.length < 2
  }
  // Datenschutz-Hinweis zum aktuellen Foto.
  function renderDritte(s, info) {
    var row = dlg.querySelector('[data-dritte-row]')
    var funde = (info && info.dritte) || []
    row.hidden = !funde.length
    if (!funde.length) return
    var k = funde.filter(function (f) { return f.art === 'kennzeichen' })
    var g = funde.length - k.length
    row.querySelector('[data-dritte-text]').textContent = '⚠ Daten Dritter erkannt: ' + [
      k.length ? (k.length === 1 ? 'weiteres Kennzeichen ' : k.length + ' weitere Kennzeichen ') + k.map(function (f) { return f.text }).join(', ') : '',
      g ? (g === 1 ? 'ein Gesicht' : g + ' Gesichter') : '',
    ].filter(Boolean).join(' und ') + '. Gestrichelt markiert – am Foto ⬛ schwärzen oder ✓ freigeben; ohne das kein Versand.'
    if (s && s.base) redraw()
  }
  // Schwärzungs-Vorschlag: Boxen aus der Analyse (Bildpixel der gespeicherten
  // Fassung) aufs Canvas umrechnen, etwas Rand zugeben. Liefert einen Text
  // statt Boxen, wenn die Analyse nicht mehr zum Canvas passt.
  function vorschlagBoxen(s) {
    var info = currentImage(s)
    if (!s || !s.base || !info || !info.dritte || !info.dritte.length || !info.groesse) return []
    if (s.geometrie || (s.crop && s.gespeichert)) return 'Das Foto wurde gedreht oder zugeschnitten – bitte erst „Rückgängig" oder von Hand schwärzen.'
    var sx = canvas.width / info.groesse.w
    var sy = canvas.height / info.groesse.h
    if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.05) return 'Die Bildausrichtung passt nicht zur Analyse – bitte von Hand schwärzen.'
    return info.dritte.map(function (f) {
      var b = f.bbox
      var pw = (b[2] - b[0]) * 0.12
      var ph = (b[3] - b[1]) * 0.15
      var x = Math.max(0, (b[0] - pw) * sx)
      var y = Math.max(0, (b[1] - ph) * sy)
      return { x: x, y: y, w: Math.min(canvas.width - x, (b[2] - b[0] + 2 * pw) * sx), h: Math.min(canvas.height - y, (b[3] - b[1] + 2 * ph) * sy), art: f.art }
    })
  }
  // Schon von einer Schwärzung/Verpixelung abgedeckt (2 px Toleranz)?
  function abgedeckt(b) {
    return state.redactions.some(function (r) {
      return r.x <= b.x + 2 && r.y <= b.y + 2 && r.x + r.w >= b.x + b.w - 2 && r.y + r.h >= b.y + b.h - 2
    })
  }
  // Ist jeder Vorschlag geschwärzt oder freigegeben und mindestens einer
  // freigegeben, gilt das Foto als unbedenklich (PATCH …/dritte). Der Server
  // kennt nur „ganzes Foto ok"; geschwärzte Funde verschwinden ohnehin mit der
  // Neu-Analyse der gespeicherten Fassung. Ist das Foto geändert, erst nach dem
  // Speichern – der PUT setzt dritte_ok zurück.
  function dritteErledigt() {
    var s = state
    var boxen = vorschlagBoxen(s)
    if (typeof boxen === 'string' || !boxen.length) return
    var offen = boxen.some(function (b, i) { return !abgedeckt(b) && !s.freigegeben[i] })
    if (offen || !Object.keys(s.freigegeben).length) return
    if (s.dirty) s.dritteOkNachSpeichern = true
    else dritteOk(s).catch(function (err) { alert(err.message) })
  }
  function dritteOk(s) {
    return fetch(s.put + '/dritte', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ok: true }),
    })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Speichern fehlgeschlagen.') }) })
      .then(function () { if (state === s) loadStatus(s) })
  }
  function renderVerstossExtras(s) {
    var esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') }
    var sel = dlg.querySelector('[data-variante]')
    var opts = (s.report && s.report.varianten) || []
    var cur = (s.report && s.report.fields.verstoss_variante) || ''
    sel.hidden = !opts.length || verstossHidden().closest('.pe-field').hidden
    sel.innerHTML = '<option value="">Genauer: bitte wählen …</option>' + opts.map(function (o) {
      return '<option' + (o === cur ? ' selected' : '') + '>' + esc(o) + '</option>'
    }).join('')
    sel.classList.toggle('is-invalid', opts.length > 0 && !cur)
    var lp = dlg.querySelector('[data-langparker]')
    var lang = s.report && s.report.langparker
    lp.hidden = !lang
    var btn = lp.querySelector('[data-act=langparker]')
    btn.dataset.label = lang || ''
    btn.textContent = lang ? '„' + lang.replace(/^\d{6} – /, '') + '" übernehmen' : ''
  }
  function readyToSubmit() {
    var s = state
    return !!(s && s.report && s.report.canSubmit && s.ok && !s.open)
  }
  function updateRun() {
    var box = dlg.querySelector('.photo-edit-side')
    var s = state
    if (!s || s.plate == null) return
    var run = window.photoEditorRun
    dlg.querySelector('.photo-edit-run-label').textContent = (run && run.label ? run.label() + ' · ' : '') + s.az
    box.querySelector('[data-act=skip]').hidden = !run
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
    if (unsaved(s) || s.saving) {
      // Erst speichern, dann einreichen – nie ungespeichert verwerfen.
      return flushSave(s).then(function () { if (state === s) submitReport(sofort) }, function (err) {
        alert((err && err.message) || 'Foto konnte nicht gespeichert werden – bitte erneut versuchen.')
      })
    }
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
    if (!window.photoEditorRun && !confirm('Anzeige ' + s.az + ' in den Papierkorb verschieben? (30 Tage wiederherstellbar)')) return
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
    state.tool = tool === 'pixel' || tool === 'plate' ? tool : 'black'
    updateUi()
  }

  // ---- Kennzeichen des angezeigten Fahrzeugs markieren ---------------------
  // Pflicht für jedes Foto einer Anzeige: Box über dem Kennzeichen (vorbelegt
  // aus der Erkennung) oder „Kein Kennzeichen sichtbar". Die Übersichtskarte
  // schwärzt die Box (services/pixelate.ts) – auch wenn die Erkennung das
  // Schild übersehen hat. state.kz in Canvas-Pixeln, gespeichert als Anteile
  // 0..1 der gespeicherten Fassung (PATCH …/kennzeichen).
  var kzInEl = null
  var kzBoxEl = null
  var kzMirrors = []
  var kzVerstossEl = null
  // Fahrzeug-Felder am Foto aus der Seitenleiste nachziehen (nicht beim Tippen).
  function kzMehrSync() {
    kzMirrors.forEach(function (x) {
      if (x.el.tagName === 'SELECT' && (x.el.options.length !== x.src.options.length || (x.variante && x.el.innerHTML !== x.src.innerHTML))) x.el.innerHTML = x.src.innerHTML
      if (document.activeElement !== x.el) x.el.value = x.src.value
      x.el.hidden = !!x.src.closest('[hidden]')
    })
    if (kzVerstossEl) {
      var vIn = kzVerstossEl.querySelector('[data-verstoss-input]')
      kzVerstossEl.hidden = !!verstossHidden().closest('[hidden]')
      if (document.activeElement !== vIn) {
        kzVerstossEl.querySelector('input[type=hidden]').value = verstossHidden().value
        vIn.value = verstossHidden().value
        vIn.title = verstossHidden().value
        vIn.classList.toggle('is-missing', !verstossHidden().value)
      }
    }
  }
  var kzLandEl = null
  function landSel() {
    return dlg.querySelector('#pe-land')
  }
  // Land-Auswahl am Foto spiegelt #pe-land (Optionen + Wert).
  // Land-Auswahl: zugeklappt nur das Kürzel (schmales Feld), aufgeklappt
  // „PL – Polen" – sonst findet man das Land in der Liste nicht.
  function landLang(sel) {
    if (sel._landLang) return
    sel._landLang = true
    var lang = function () {
      ;[].forEach.call(sel.options, function (o) { if (o.dataset.name) o.textContent = o.value + ' – ' + o.dataset.name })
    }
    var kurz = function () {
      ;[].forEach.call(sel.options, function (o) { o.textContent = o.value })
    }
    sel.addEventListener('mousedown', lang)
    sel.addEventListener('focus', lang)
    sel.addEventListener('keydown', lang)
    sel.addEventListener('change', kurz)
    sel.addEventListener('blur', kurz)
  }
  function kzLandSync() {
    var src = landSel()
    if (kzLandEl.options.length !== src.options.length) {
      kzLandEl.innerHTML = src.innerHTML
      ;[].forEach.call(kzLandEl.options, function (o) { o.textContent = o.value })
      landLang(kzLandEl)
    }
    if (document.activeElement !== kzLandEl) kzLandEl.value = src.value
    kzLandEl.hidden = src.hidden
  }
  function kzInput() {
    if (kzInEl) return kzInEl
    kzBoxEl = document.createElement('div')
    kzBoxEl.className = 'pe-kz-box'
    kzBoxEl.hidden = true
    var grp = document.createElement('div')
    grp.className = 'input-group input-group-sm flex-nowrap'
    kzBoxEl.appendChild(grp)
    kzLandEl = document.createElement('select')
    kzLandEl.className = 'form-select pe-kz-land'
    kzLandEl.setAttribute('aria-label', 'Länderkennzeichen')
    kzLandEl.setAttribute('data-native', '') // kein Suchfeld (searchable-select.js)
    kzLandEl.addEventListener('change', function () {
      var src = landSel()
      src.value = kzLandEl.value
      src.dispatchEvent(new Event('change', { bubbles: true }))
    })
    grp.appendChild(kzLandEl)
    kzInEl = document.createElement('input')
    kzInEl.type = 'text'
    kzInEl.className = 'form-control form-control-sm plate-field pe-kz-input'
    kzInEl.maxLength = 20
    kzInEl.autocomplete = 'off'
    kzInEl.spellcheck = false
    kzInEl.setAttribute('autocapitalize', 'characters')
    kzInEl.setAttribute('aria-label', 'Kennzeichen')
    grp.appendChild(kzInEl)
    // Zweite Zeile: Fahrzeug (Typ, Marke, Modell, Farbe) – Spiegel der Felder
    // in der Seitenleiste, gespeichert wird über deren change-Handler.
    var mehr = document.createElement('div')
    mehr.className = 'pe-kz-mehr'
    kzMirrors = [
      ['#pe-typ', 'select', 'Typ'],
      ['#photo-edit-marke-input', 'input', 'Marke', 'pe-marken'],
      ['#pe-modell', 'input', 'Modell'],
      ['#pe-farbe', 'input', 'Farbe', 'pe-farben'],
    ].map(function (d) {
      var src = dlg.querySelector(d[0])
      var m = document.createElement(d[1])
      m.className = d[1] === 'select' ? 'form-select form-select-sm' : 'form-control form-control-sm'
      m.setAttribute('aria-label', d[2])
      m.title = d[2]
      if (d[1] === 'select') m.setAttribute('data-native', '')
      else {
        m.placeholder = d[2]
        m.autocomplete = 'off'
        if (src.maxLength > 0) m.maxLength = src.maxLength
        if (d[3]) m.setAttribute('list', d[3])
      }
      var push = function () {
        src.value = m.value
        src.dispatchEvent(new Event('change', { bubbles: true }))
      }
      m.addEventListener('change', push)
      // Enter übernimmt (Dialog-Enter bestätigt sonst das Foto).
      m.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); push() } })
      mehr.appendChild(m)
      return { src: src, el: m }
    })
    kzBoxEl.appendChild(mehr)
    // Dritte Zeile: Verstoß (eigenes verstoss-select, Katalog lazy beim
    // Fokus) + Konkretisierung – gespeichert über die Felder der Seitenleiste.
    kzVerstossEl = document.createElement('div')
    kzVerstossEl.className = 'position-relative pe-kz-verstoss'
    kzVerstossEl.innerHTML = '<input type="hidden"><input type="text" class="form-control form-control-sm" data-verstoss-input autocomplete="off" spellcheck="false" placeholder="Verstoß suchen …" aria-label="Verstoß">'
    var vHidden = kzVerstossEl.querySelector('input[type=hidden]')
    var vInput = kzVerstossEl.querySelector('[data-verstoss-input]')
    vInput.addEventListener('focus', function () {
      kzVerstossEl.dataset.city = verstossHidden().parentNode.dataset.city || ''
      if (kzVerstossEl.dataset.verstossReady || !window.verstossSelect) return fitVerstossMenu()
      loadCatalog().then(function (data) {
        if (kzVerstossEl.dataset.verstossReady) return
        window.verstossSelect.init(kzVerstossEl, data)
        fitVerstossMenu()
        if (document.activeElement === vInput) vInput.dispatchEvent(new Event('focus'))
      }, function () {})
    })
    vInput.addEventListener('input', fitVerstossMenu)
    vInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.stopPropagation() })
    vHidden.addEventListener('change', function () {
      if (!vHidden.value || vHidden.value === verstossHidden().value) return
      verstossHidden().value = vHidden.value
      verstossInput().value = vHidden.value
      if (window.verstossSelect) window.verstossSelect.check(verstossHidden().parentNode)
      verstossHidden().dispatchEvent(new Event('change', { bubbles: true }))
    })
    kzBoxEl.appendChild(kzVerstossEl)
    var varSrc = dlg.querySelector('[data-variante]')
    var varEl = document.createElement('select')
    varEl.className = 'form-select form-select-sm pe-kz-variante'
    varEl.setAttribute('data-native', '')
    varEl.setAttribute('aria-label', 'Verstoß genauer')
    varEl.addEventListener('change', function () {
      varSrc.value = varEl.value
      varSrc.dispatchEvent(new Event('change', { bubbles: true }))
    })
    kzBoxEl.appendChild(varEl)
    kzMirrors.push({ src: varSrc, el: varEl, variante: true })
    kzInEl.addEventListener('input', function () {
      plateInput().value = kzInEl.value
      updateUi()
    })
    kzInEl.addEventListener('change', function () { savePlate().catch(function () {}) })
    dlg.querySelector('.photo-edit-marks').appendChild(kzBoxEl)
    return kzInEl
  }
  function kzSyncKlassen() {
    var cur = plateInput().value
    kzInEl.placeholder = state.detected || 'Kennzeichen'
    kzInEl.classList.toggle('is-invalid', !normPlate(cur))
    kzInEl.classList.toggle('is-mismatch', !!state.detected && !!normPlate(cur) && compact(state.detected) !== compact(cur))
  }
  function kzPflicht(s) {
    return !!(s && s.plate != null && s.az)
  }
  function kzFehlt(s) {
    return kzPflicht(s) && !s.kz && !s.kzKeins
  }
  // Einmal je Foto, sobald Bild und Status da sind: gespeicherte Markierung,
  // sonst der Vorschlag der Erkennung.
  function kzInit(s) {
    if (!s || s.kzBereit || !s.base || !kzPflicht(s)) return
    var info = currentImage(s)
    if (!info || !info.kennzeichen) return
    s.kzBereit = true
    var k = info.kennzeichen
    var b = k.box || (!s.geometrie && k.vorschlag)
    if (b) {
      s.kz = { x: b[0] * canvas.width, y: b[1] * canvas.height, w: (b[2] - b[0]) * canvas.width, h: (b[3] - b[1]) * canvas.height }
      s.kzGeaendert = !k.box
      // Unveränderter Erkennungs-Vorschlag: erst beim Bestätigen speichern.
      s.kzVorschlag = !k.box
    } else if (k.keins) {
      s.kzKeins = true
    } else if (s.tool === 'black') {
      s.tool = 'plate'
    }
    redraw()
    updateUi()
  }
  function kzSetzen(box, keins) {
    snapshot(true)
    state.kz = box
    state.kzKeins = !!keins
    state.kzGeaendert = true
    state.kzVorschlag = false
    redraw()
    autoSave()
  }
  // Box relativ zum Zuschnitt (der beim Speichern angewandt wird), 0..1.
  function kzAnteile(s) {
    var c = cropRect()
    var k = s.kz
    var cl = function (v) { return Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4 }
    var b = [cl((k.x - c.x) / c.w), cl((k.y - c.y) / c.h), cl((k.x + k.w - c.x) / c.w), cl((k.y + k.h - c.y) / c.h)]
    return b[2] > b[0] && b[3] > b[1] ? b : null
  }
  function kzSpeichern(s, body) {
    return fetch(s.put + '/kennzeichen', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Kennzeichen-Markierung konnte nicht gespeichert werden.') })
    }).then(function () { s.kzGeaendert = false })
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

  // Canvas-Pixel je CSS-Pixel und die tatsächliche Bildfläche im Element
  // (object-fit: contain kann links/rechts bzw. oben/unten Rand lassen).
  function bildRect() {
    var r = canvas.getBoundingClientRect()
    var k = Math.min(r.width / canvas.width, r.height / canvas.height) || 1
    var w = canvas.width * k
    var h = canvas.height * k
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h, k: k }
  }
  function cropRect() {
    return state.crop || { x: 0, y: 0, w: canvas.width, h: canvas.height }
  }

  // Zuschnitt-Rahmen: außen abgedunkelt, Winkel an den Ecken. Der Zuschnitt
  // ist nur ein Rechteck über dem Foto und wird erst beim Speichern (bzw. vor
  // dem Drehen) angewandt – Schwärzungen und Vorschläge behalten so ihre
  // Koordinaten.
  function drawCrop() {
    var c = cropRect()
    var k = 1 / bildRect().k
    var W = canvas.width
    var H = canvas.height
    ctx.save()
    if (state.crop) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, 0, W, c.y)
      ctx.fillRect(0, c.y + c.h, W, H - c.y - c.h)
      ctx.fillRect(0, c.y, c.x, c.h)
      ctx.fillRect(c.x + c.w, c.y, W - c.x - c.w, c.h)
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.5 * k
      ctx.strokeRect(c.x, c.y, c.w, c.h)
    }
    var len = Math.min(26 * k, c.w / 3, c.h / 3)
    var t = 5 * k
    ctx.fillStyle = '#fff'
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 3 * k
    ;[[c.x, c.y, 1, 1], [c.x + c.w, c.y, -1, 1], [c.x, c.y + c.h, 1, -1], [c.x + c.w, c.y + c.h, -1, -1]].forEach(function (p) {
      var x = p[2] > 0 ? p[0] : p[0] - t
      var y = p[3] > 0 ? p[1] : p[1] - t
      ctx.fillRect(p[2] > 0 ? p[0] : p[0] - len, y, len, t)
      ctx.fillRect(x, p[3] > 0 ? p[1] : p[1] - len, t, len)
    })
    // Kurze Griffe in der Mitte der Seiten.
    ctx.fillRect(c.x + c.w / 2 - len / 2, c.y, len, t)
    ctx.fillRect(c.x + c.w / 2 - len / 2, c.y + c.h - t, len, t)
    ctx.fillRect(c.x, c.y + c.h / 2 - len / 2, t, len)
    ctx.fillRect(c.x + c.w - t, c.y + c.h / 2 - len / 2, t, len)
    ctx.restore()
  }

  // Knöpfe direkt an den Bereichen: ✕ an jeder Schwärzung, ⬛/✓ an jedem
  // offenen Datenschutz-Vorschlag. Liegen als HTML über dem Canvas.
  function renderMarks() {
    var box = dlg.querySelector('.photo-edit-marks')
    var kzIn = kzInput()
    ;[].slice.call(box.children).forEach(function (c) { if (c !== kzBoxEl) c.remove() })
    kzBoxEl.hidden = true
    if (!state || !state.base || state.drawing) return
    var br = bildRect()
    var cr = box.getBoundingClientRect()
    var add = function (r, buttons) {
      var g = el('div', 'photo-edit-mark')
      buttons.forEach(function (b) {
        var btn = el('button', 'pe-mark-btn ' + b[2], b[1])
        btn.type = 'button'
        btn.title = b[3]
        btn.setAttribute('aria-label', b[3])
        btn.setAttribute('data-mark', b[0])
        btn.setAttribute('data-i', String(r.i))
        g.appendChild(btn)
      })
      box.appendChild(g)
      // Rechts oben an den Bereich, aber immer ganz sichtbar.
      var w = g.offsetWidth
      var h = g.offsetHeight
      var left = br.left - cr.left + (r.x + r.w) * br.k - w
      var top = br.top - cr.top + r.y * br.k - h - 2
      if (top < 0) top = br.top - cr.top + r.y * br.k + 2
      g.style.left = Math.max(0, Math.min(cr.width - w, left)) + 'px'
      g.style.top = Math.max(0, Math.min(cr.height - h, top)) + 'px'
    }
    var boxen = vorschlagBoxen(state)
    if (typeof boxen !== 'string') {
      boxen.forEach(function (b, i) {
        if (abgedeckt(b) || state.freigegeben[i]) return
        var was = b.art === 'gesicht' ? 'Gesicht' : 'Kennzeichen'
        add({ x: b.x, y: b.y, w: b.w, h: b.h, i: i }, [
          ['schwaerzen', '⬛', 'is-black', was + ' schwärzen'],
          ['freigeben', '✓', 'is-ok', 'Freigeben – Fehlalarm oder nicht erkennbar'],
        ])
      })
    }
    if (state.kz) {
      add({ x: state.kz.x, y: state.kz.y, w: state.kz.w, h: state.kz.h, i: 0 }, [['kz-entfernen', '✕', 'is-del', 'Kennzeichen-Markierung entfernen']])
      // Kennzeichen der Anzeige direkt unter dem Rahmen bearbeiten (gleicher
      // Wert wie das Feld in der Seitenleiste).
      if (state.plate != null) {
        if (document.activeElement !== kzIn) kzIn.value = plateInput().value
        kzSyncKlassen()
        kzLandSync()
        kzMehrSync()
        kzBoxEl.hidden = false
        var w = kzBoxEl.offsetWidth
        var h = kzBoxEl.offsetHeight
        var left = br.left - cr.left + (state.kz.x + state.kz.w / 2) * br.k - w / 2
        var top = br.top - cr.top + (state.kz.y + state.kz.h) * br.k + 4
        if (top + h > cr.height) top = br.top - cr.top + state.kz.y * br.k - h - 4
        kzBoxEl.style.left = Math.max(0, Math.min(cr.width - w, left)) + 'px'
        kzBoxEl.style.top = Math.max(0, Math.min(cr.height - h, top)) + 'px'
      }
    }
    state.redactions.forEach(function (r, i) {
      add({ x: r.x, y: r.y, w: r.w, h: r.h, i: i }, [['entfernen', '✕', 'is-del', r.type === 'pixel' ? 'Verpixelung entfernen' : 'Schwärzung entfernen']])
    })
  }

  // ohneVorschau: für Export/Einbacken – der gestrichelte Schwärzungs-
  // Vorschlag und der Zuschnitt-Rahmen dürfen nie ins gespeicherte Bild geraten.
  function redraw(ohneVorschau) {
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
    if (ohneVorschau) {
      var marks = dlg.querySelector('.photo-edit-marks')
      ;[].slice.call(marks.children).forEach(function (c) { if (c !== kzBoxEl) c.remove() })
      if (kzBoxEl) kzBoxEl.hidden = true
      return
    }
    var boxen = vorschlagBoxen(state)
    var lw = Math.max(2, canvas.width / 300) / zoom.z
    ctx.save()
    ctx.lineWidth = lw
    ctx.setLineDash([lw * 4, lw * 3])
    if (typeof boxen !== 'string') boxen.forEach(function (b, i) {
      if (abgedeckt(b) || state.freigegeben[i]) return
      ctx.fillStyle = 'rgba(255,193,7,0.25)'
      ctx.fillRect(b.x, b.y, b.w, b.h)
      ctx.strokeStyle = '#ffc107'
      ctx.strokeRect(b.x, b.y, b.w, b.h)
    })
    if (state.kz) {
      var k = state.kz
      ctx.setLineDash([])
      ctx.strokeStyle = '#0dcaf0'
      ctx.lineWidth = lw * 1.5
      ctx.strokeRect(k.x, k.y, k.w, k.h)
    }
    ctx.restore()
    drawCrop()
    renderMarks()
  }

  // Schnappschuss vor jeder Änderung (Rotieren/Zuschneiden erzeugen neue
  // Canvas-Objekte, die Referenz genügt) – Rückgängig ohne Rückfragen.
  // nurKz: nur die Kennzeichen-Markierung ändert sich – das Foto selbst
  // bleibt unverändert und muss nicht neu hochgeladen werden.
  function snapshot(nurKz) {
    state.history.push({ base: state.base, redactions: state.redactions.slice(), crop: state.crop, geometrie: state.geometrie, kz: state.kz, kzKeins: state.kzKeins, nurKz: !!nurKz })
    if (!nurKz) state.dirty = true
    autoSave()
  }

  // ---- Auto-Speichern ------------------------------------------------------
  // Jede Änderung am Foto (Schwärzen, Zuschnitt, Drehen, Kennzeichen-Box) wird
  // kurz danach gespeichert – kein „Speichern" nötig. Vor Fotowechsel,
  // Schließen, Bestätigen und Einreichen wird ausstehendes sofort geschrieben
  // (flushSave). s.rev zählt Änderungen, damit eine während des Uploads
  // gemachte Änderung nicht als gespeichert gilt.
  var AUTOSAVE_MS = 800
  function autoSave() {
    var s = state
    if (!s) return
    s.rev = (s.rev || 0) + 1
    s.saveErr = false
    clearTimeout(s.saveTimer)
    s.saveTimer = setTimeout(function () { flushSave(s).catch(function () {}) }, AUTOSAVE_MS)
    updateUi()
  }
  function unsaved(s) {
    return !!(s && (s.dirty || (kzPflicht(s) && s.kzGeaendert && !s.kzVorschlag && (s.kz || s.kzKeins))))
  }
  function flushSave(s) {
    clearTimeout(s.saveTimer)
    s.saveTimer = null
    s.saveChain = (s.saveChain || Promise.resolve()).catch(function () {}).then(function () { return persist(s) })
    return s.saveChain
  }
  function persist(s) {
    if (!unsaved(s)) return Promise.resolve()
    // Canvas gehört nur dem aktuellen Foto; beim Ziehen später erneut.
    if (state !== s || !s.base) return Promise.resolve()
    if (s.drawing) {
      s.saveTimer = setTimeout(function () { flushSave(s).catch(function () {}) }, AUTOSAVE_MS)
      return Promise.resolve()
    }
    var rev = s.rev
    var kzKeins = s.kzKeins
    var kzBox = s.kz ? kzAnteile(s) : null
    var bild = s.dirty ? flatten() : null
    if (bild) redraw()
    s.saving = true
    updateUi()
    var upload = !bild
      ? Promise.resolve(false)
      : new Promise(function (resolve) { bild.toBlob(resolve, 'image/jpeg', 0.9) }).then(function (blob) {
          var fd = new FormData()
          fd.append('bilder', blob, 'bearbeitet.jpg')
          return fetch(s.put, { method: 'PUT', body: fd })
        }).then(function (r) {
          if (!r.ok || r.redirected) throw new Error('Foto konnte nicht gespeichert werden.')
          s.gespeichert = true
          if (s.rev === rev) s.dirty = false
          if (s.dritteOkNachSpeichern) return dritteOk(s).catch(function () {}).then(function () { return true })
          return true
        })
    return upload
      .then(function (hochgeladen) {
        // Der PUT setzt die Box serverseitig zurück – dann immer neu senden.
        if (!kzPflicht(s) || !(hochgeladen || s.kzGeaendert) || (!kzKeins && !kzBox)) return
        var kzRev = s.rev
        return kzSpeichern(s, kzKeins ? { keins: true } : { box: kzBox }).then(function () {
          if (s.rev !== kzRev) s.kzGeaendert = true
        })
      })
      .then(function () {
        s.saving = false
        if (state === s) { updateUi(); loadStatus(s) }
      }, function (err) {
        s.saving = false
        s.saveErr = true
        if (state === s) updateUi()
        var e = new Error((err && err.message) || 'Foto konnte nicht gespeichert werden.')
        e.persist = true
        throw e
      })
  }
  function undo() {
    var s = state.history.pop()
    if (!s) return
    state.base = s.base
    state.redactions = s.redactions
    state.crop = s.crop
    state.geometrie = s.geometrie
    state.kz = s.kz
    state.kzKeins = s.kzKeins
    if (s.nurKz) state.kzGeaendert = true
    else state.dirty = true
    redraw()
    autoSave()
  }

  // Markierungen einbacken und den Zuschnitt anwenden – fürs Drehen und
  // fürs Speichern.
  function flatten() {
    redraw(true)
    var r = cropRect()
    var x = Math.max(0, Math.round(r.x))
    var y = Math.max(0, Math.round(r.y))
    var c = document.createElement('canvas')
    c.width = Math.max(1, Math.min(canvas.width - x, Math.round(r.w)))
    c.height = Math.max(1, Math.min(canvas.height - y, Math.round(r.h)))
    c.getContext('2d').drawImage(canvas, x, y, c.width, c.height, 0, 0, c.width, c.height)
    return c
  }

  function rotate() {
    snapshot()
    state.geometrie = true
    var kzAlt = state.kz ? kzAnteile(state) : null
    var old = flatten()
    var c = document.createElement('canvas')
    c.width = old.height
    c.height = old.width
    var cx = c.getContext('2d')
    cx.translate(c.width, 0)
    cx.rotate(Math.PI / 2)
    cx.drawImage(old, 0, 0)
    resetZoom()
    state.base = c
    state.redactions = []
    state.crop = null
    // Markierung mitdrehen (90° im Uhrzeigersinn): (x, y) → (1 − y, x).
    if (state.kz) {
      state.kz = kzAlt ? { x: (1 - kzAlt[3]) * c.width, y: kzAlt[0] * c.height, w: (kzAlt[3] - kzAlt[1]) * c.width, h: (kzAlt[2] - kzAlt[0]) * c.height } : null
      state.kzGeaendert = true
    }
    redraw()
    updateUi()
  }

  // Ein Zeiger, zwei Bedeutungen: an Rand/Ecke des Zuschnitt-Rahmens (±18 px)
  // zieht man den Rahmen, überall sonst zieht man eine Schwärzung auf.
  var CURSOR = { n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }
  var MIN_CROP = 40
  function attachDrawing() {
    var drag = null // { mode: 'draw'|'crop', start, griff, crop0, moved }
    var pid = null
    function pos(e) {
      var r = bildRect()
      return { x: (e.clientX - r.left) / r.k, y: (e.clientY - r.top) / r.k }
    }
    function griffAn(p) {
      var c = cropRect()
      var tol = 18 / bildRect().k
      var inY = p.y > c.y - tol && p.y < c.y + c.h + tol
      var inX = p.x > c.x - tol && p.x < c.x + c.w + tol
      var g = ''
      if (inX && Math.abs(p.y - c.y) < tol) g += 'n'
      else if (inX && Math.abs(p.y - (c.y + c.h)) < tol) g += 's'
      if (inY && Math.abs(p.x - c.x) < tol) g += 'w'
      else if (inY && Math.abs(p.x - (c.x + c.w)) < tol) g += 'e'
      return g
    }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
    canvas.addEventListener('pointerdown', function (e) {
      if (!state || !state.base || state.busy || !e.isPrimary || e.button > 0) return
      var p = pos(e)
      var g = griffAn(p)
      drag = { mode: g ? 'crop' : 'draw', start: p, griff: g, crop0: cropRect(), moved: false }
      pid = e.pointerId
      state.drawing = true
      canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    canvas.addEventListener('pointermove', function (e) {
      if (!state || !state.base) return
      if (!drag) {
        if (e.pointerType === 'mouse') canvas.style.cursor = CURSOR[griffAn(pos(e))] || 'crosshair'
        return
      }
      if (e.pointerId !== pid) return
      var p = pos(e)
      if (drag.mode === 'crop') {
        if (!drag.moved) snapshot()
        drag.moved = true
        var c = drag.crop0
        var x1 = c.x, y1 = c.y, x2 = c.x + c.w, y2 = c.y + c.h
        var dx = p.x - drag.start.x
        var dy = p.y - drag.start.y
        if (drag.griff.indexOf('w') !== -1) x1 = clamp(c.x + dx, 0, x2 - MIN_CROP)
        if (drag.griff.indexOf('e') !== -1) x2 = clamp(c.x + c.w + dx, x1 + MIN_CROP, canvas.width)
        if (drag.griff.indexOf('n') !== -1) y1 = clamp(c.y + dy, 0, y2 - MIN_CROP)
        if (drag.griff.indexOf('s') !== -1) y2 = clamp(c.y + c.h + dy, y1 + MIN_CROP, canvas.height)
        var voll = x1 <= 0.5 && y1 <= 0.5 && x2 >= canvas.width - 0.5 && y2 >= canvas.height - 0.5
        state.crop = voll ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
        redraw()
        return
      }
      redraw()
      ctx.save()
      ctx.fillStyle = state.tool === 'plate' ? 'rgba(13,202,240,0.25)' : state.tool === 'pixel' ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.6)'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1 / bildRect().k
      ctx.fillRect(drag.start.x, drag.start.y, p.x - drag.start.x, p.y - drag.start.y)
      ctx.strokeRect(drag.start.x, drag.start.y, p.x - drag.start.x, p.y - drag.start.y)
      ctx.restore()
    })
    function finish(e) {
      if (!drag || e.pointerId !== pid) return
      var d = drag
      drag = null
      state.drawing = false
      if (d.mode === 'draw') {
        var p = pos(e)
        var x = clamp(Math.min(d.start.x, p.x), 0, canvas.width)
        var y = clamp(Math.min(d.start.y, p.y), 0, canvas.height)
        var r = {
          x: x, y: y,
          w: clamp(Math.max(d.start.x, p.x), 0, canvas.width) - x,
          h: clamp(Math.max(d.start.y, p.y), 0, canvas.height) - y,
        }
        if (r.w >= MIN_BOX && r.h >= MIN_BOX && state.tool === 'plate') {
          kzSetzen(r, false)
          // Ein Kennzeichen je Foto – danach wieder schwärzen.
          setTool('black')
          return
        }
        if (r.w >= MIN_BOX && r.h >= MIN_BOX) {
          snapshot()
          state.redactions.push({ x: r.x, y: r.y, w: r.w, h: r.h, type: state.tool === 'pixel' ? 'pixel' : 'black' })
        }
      }
      redraw()
      updateUi()
      if (d.mode === 'draw') dritteErledigt()
    }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', function () {
      drag = null
      if (state) state.drawing = false
      if (state && state.base) redraw()
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
    if (unsaved(s) || s.saving) {
      return flushSave(s).then(function () { if (state === s) moveTo(dest) }, function (err) { alert((err && err.message) || 'Speichern fehlgeschlagen.') })
    }
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
    setUrl(null)
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
    var s = state
    if (!s) return close()
    // Ausstehende Änderungen und ein getipptes Kennzeichen erst speichern.
    flushSave(s).then(function () { return savePlate() }).then(function () {
      if (state === s) close()
    }, function (err) {
      if (confirm(((err && err.message) || 'Speichern fehlgeschlagen.') + ' Trotzdem schließen? Die Änderungen gehen verloren.')) close()
    })
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
    if (kzFehlt(s)) {
      setTool('plate')
      var hint = dlg.querySelector('.photo-edit-hint')
      hint.classList.remove('pe-flash')
      void hint.offsetWidth
      hint.classList.add('pe-flash')
      return
    }
    if (kzPflicht(s) && s.kz && !s.kzKeins && !kzAnteile(s)) {
      alert('Die Kennzeichen-Markierung liegt außerhalb des Zuschnitts – bitte neu markieren.')
      setTool('plate')
      return
    }
    var btn = dlg.querySelector('[data-act=save]')
    s.busy = true
    btn.textContent = 'Bestätigt …'
    updateUi()
    s.kzVorschlag = false
    savePlate()
      .then(function () { return flushSave(s) })
      .then(function () { return fetch(s.put + '/geprueft', { method: 'POST' }) })
      .then(function (r) {
        if (!r.ok || r.redirected) throw new Error()
        return next(s.az)
      })
      .catch(function (err) {
        // savePlate() hat seinen Fehler schon gemeldet.
        // savePlate() hat seinen Fehler schon gemeldet.
        if (err && err.persist) alert(err.message + ' Bitte erneut versuchen.')
        else if (!err || !err.message) alert('Speichern fehlgeschlagen – bitte erneut versuchen.')
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
    if (window.verstossSelect) window.verstossSelect.check(verstossHidden().parentNode)
    verstossHidden().closest('.pe-field').hidden = verstoss == null
    var tatort = plate != null && opts.tatort != null ? String(opts.tatort).replace(/\s+/g, ' ').trim() : null
    tatortInput().value = tatort || ''
    tatortInput().closest('.photo-edit-tatort').hidden = tatort == null
    chosenCoords = null
    if (!state || state.az !== opts.az) dlg.querySelector('[data-adr-vorschlag]').hidden = true
    var adrAlt = state && state.az === opts.az ? state.adrVorschlag : null
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
      put: opts.put, az: opts.az, base: null, redactions: [], history: [], tool: opts.tool === 'pixel' ? 'pixel' : 'black', dirty: false,
      crop: null, freigegeben: {}, dritteOkNachSpeichern: false, drawing: false,
      kz: null, kzKeins: false, kzGeaendert: false, kzBereit: false,
      adrVorschlag: adrAlt,
      ok: !!opts.ok, pos: opts.pos || 1, total: opts.total || 1, open: opts.open || 0, busy: false,
    }
    resetZoom()
    renderStrip()
    updateMoveLabel()
    setUrl(state)
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
      kzInit(state)
      dlg.querySelector('[data-act=save]').focus()
    }
    img.onerror = function () { if (state === s) msg('Foto konnte nicht geladen werden.') }
    img.src = opts.src
  }

  // „Prüfen" in der Zeile bzw. „🔍 N Fotos prüfen" unter den Miniaturen (und
  // der Knopf der Prüf-Karte in /pruefen): Dialog auf dem ersten ungeprüften,
  // sonst dem ersten Foto öffnen. Entwürfe ohne Fotos haben nichts zu
  // schwärzen – dann direkt die Einreichen-Vorschau (report-submit.js), die
  // auch das fehlende Foto bemängelt.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-review-photos]')
    if (!b) return
    var row = b.closest('[data-az]')
    if (!row) return
    var t = row.querySelector('[data-photo-edit][data-geprueft="0"]') || row.querySelector('[data-photo-edit]')
    if (t) openThumb(t)
    else if (window.submitPreview) window.submitPreview.open(row.getAttribute('data-az'))
  })

  // Geöffnetes Foto in der Adresszeile (?anzeige=AZ&foto=N): Neuladen oder
  // ein geteilter Link öffnet denselben Dialog wieder (s. openFromUrl).
  function setUrl(s) {
    if (!window.history || !history.replaceState) return
    var u = new URL(location.href)
    if (s && s.az) {
      u.searchParams.set('anzeige', s.az)
      u.searchParams.set('foto', String(s.pos || 1))
    } else {
      u.searchParams.delete('anzeige')
      u.searchParams.delete('foto')
    }
    if (u.href !== location.href) history.replaceState(history.state, '', u.href)
  }

  function openFromUrl() {
    var q = new URLSearchParams(location.search)
    var az = q.get('anzeige')
    if (!az || (dlg && dlg.open)) return false
    var row = document.querySelector('[data-az="' + az.replace(/[^\w-]/g, '') + '"]')
    var all = row ? row.querySelectorAll('[data-photo-edit]') : []
    if (!all.length) return false
    var n = Math.max(1, parseInt(q.get('foto'), 10) || 1)
    openThumb(all[Math.min(n, all.length) - 1])
    return true
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openFromUrl)
  else setTimeout(openFromUrl, 0)

  window.photoEditor = {
    openFromUrl: openFromUrl,
    open: open,
    openThumb: openThumb,
    close: function () { if (dlg && dlg.open) close() },
    isOpen: function () { return !!(dlg && dlg.open) },
  }
})()
