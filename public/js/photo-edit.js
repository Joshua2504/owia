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
// Kennzeichen-Abgleich: Bei Entwürfen steht das Kennzeichen der Anzeige im
// Dialog-Kopf (Wert aus dem Feld [data-inline-field=kennzeichen] der Zeile bzw.
// Prüf-Karte) – man sieht das Foto und korrigiert es direkt. Gespeichert wird
// über PATCH /anzeige/:az/felder, beim Bestätigen/Schließen bzw. mit Enter im
// Feld; danach feuert document das Event 'owia:plate-changed' {az, kennzeichen}.
// data-detected-plate am Foto (ALPR-Ergebnis dieses Fotos) wird als
// Übernehmen-Vorschlag angeboten, wenn es abweicht.
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
      '<div class="btn-group btn-group-sm" role="group" aria-label="Werkzeug">' +
      '<button type="button" class="btn btn-outline-light" data-tool="black">⬛ Schwärzen</button>' +
      '<button type="button" class="btn btn-outline-light" data-tool="pixel">▩ Verpixeln</button>' +
      '<button type="button" class="btn btn-outline-light" data-tool="crop">✂️ Zuschneiden</button>' +
      '</div>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="rotate" title="Um 90° drehen">⟳ Drehen</button>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="undo" disabled>↩︎ Rückgängig</button>' +
      '<span class="photo-edit-hint small"></span>' +
      '<div class="photo-edit-plate" hidden>' +
      '<label class="small" for="photo-edit-plate-input">Kennzeichen</label>' +
      '<input type="text" id="photo-edit-plate-input" class="form-control form-control-sm plate-field" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
      '<button type="button" class="btn btn-sm btn-outline-warning" data-act="plate-suggest" hidden></button>' +
      '<label class="small" for="photo-edit-marke-input">Marke</label>' +
      '<input type="text" id="photo-edit-marke-input" class="form-control form-control-sm photo-edit-marke" maxlength="100" autocomplete="off" placeholder="z. B. VW Golf, grau">' +
      '</div>' +
      '<div class="ms-auto d-flex align-items-center gap-2">' +
      '<span class="photo-edit-status small"></span>' +
      '<button type="button" class="btn btn-sm btn-outline-danger" data-act="delete" title="Foto aus dem Entwurf löschen">🗑</button>' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="cancel">Schließen</button>' +
      '<button type="button" class="btn btn-sm btn-success" data-act="save" title="Enter">✓ Bestätigen</button>' +
      '</div></div>' +
      '<div class="photo-edit-body">' +
      '<div class="photo-edit-strip" aria-label="Alle Fotos der Anzeige"></div>' +
      '<div class="photo-edit-stage"><canvas></canvas><div class="photo-edit-msg"></div></div>' +
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
    dlg.querySelector('.photo-edit-strip').addEventListener('click', function (e) {
      var b = e.target.closest('[data-strip-index]')
      if (!b || !state || state.busy || !state.thumbs) return
      var t = state.thumbs[Number(b.getAttribute('data-strip-index'))]
      if (!t || t === state.thumb) return
      if (state.dirty && !confirm('Änderungen am Foto verwerfen?')) return
      savePlate().then(function () { openThumb(t) }, function () {})
    })
    plateInput().addEventListener('change', function () { savePlate().catch(function () {}) })
    markeInput().addEventListener('change', function () { savePlate().catch(function () {}) })
    dlg.addEventListener('cancel', function (e) {
      e.preventDefault()
      cancel()
    })
    // Enter bestätigt – zügiges Durchklicken ohne Maus.
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.target.closest('button') || !state) return
      // Enter im Kennzeichen-Feld speichert nur das Kennzeichen – das Foto
      // bestätigt erst ein zweites Enter (Fokus springt auf „Bestätigen").
      if (e.target === plateInput() || e.target === markeInput()) {
        e.preventDefault()
        savePlate().then(function () { dlg.querySelector('[data-act=save]').focus() }, function () {})
        return
      }
      if (!state.base || state.busy) return
      e.preventDefault()
      save()
    })
    attachDrawing()
  }

  function plateInput() {
    return dlg.querySelector('#photo-edit-plate-input')
  }
  function markeInput() {
    return dlg.querySelector('#photo-edit-marke-input')
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
        if (state === s) {
          plateInput().value = s.plate
          markeInput().value = s.marke || ''
        }
        // Felder der Zeile/Karte nachziehen (report-inline.js vergleicht mit dataset.saved).
        var host = rowOf(s.az)
        ;[['kennzeichen', s.plate], ['fahrzeug_marke', s.marke]].forEach(function (p) {
          if (!(p[0] in vals)) return
          var field = host && host.querySelector('[data-inline-field="' + p[0] + '"]')
          if (field) {
            field.value = p[1] || ''
            field.dataset.saved = p[1] || ''
          }
        })
        document.dispatchEvent(new CustomEvent('owia:plate-changed', { detail: { az: s.az, kennzeichen: s.plate } }))
        if (state === s) updateUi()
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
      var b = el('button', 'photo-edit-tile' + (t === state.thumb ? ' is-current' : '') +
        (t.getAttribute('data-geprueft') === '1' ? ' is-geprueft' : ' is-ungeprueft'))
      b.type = 'button'
      b.setAttribute('data-strip-index', String(i))
      b.title = 'Foto ' + (i + 1) + (t.getAttribute('data-geprueft') === '1' ? ' – geprüft' : ' – ungeprüft')
      var img = el('img')
      img.src = t.getAttribute('src')
      img.alt = ''
      b.appendChild(img)
      b.appendChild(el('span', 'thumb-check', t.getAttribute('data-geprueft') === '1' ? '✓' : '?'))
      strip.appendChild(b)
      if (t === state.thumb) setTimeout(function () { b.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, 0)
    })
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
      plateInput().classList.toggle('is-mismatch', !!state.detected && !!normPlate(cur) && compact(state.detected) !== compact(cur))
    }
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

  function close() {
    dlg.close()
    document.documentElement.classList.remove('has-editor-dialog')
    state = null
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
  function next(az) {
    var done = function () {
      var row = rowOf(az)
      var t = row && row.querySelector('[data-photo-edit][data-geprueft="0"]')
      if (t) openThumb(t)
      else close()
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
    open({
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
  //         plate (Kennzeichen der Anzeige; null = kein Abgleich), marke, detected }
  function open(opts) {
    if (!dlg) build()
    var plate = opts.plate != null && opts.az ? normPlate(opts.plate) : null
    var marke = plate != null && opts.marke != null ? String(opts.marke).trim() : null
    plateInput().value = plate || ''
    markeInput().value = marke || ''
    markeInput().hidden = marke == null
    markeInput().previousElementSibling.hidden = marke == null
    state = {
      plate: plate, marke: marke, detected: opts.detected ? normPlate(opts.detected) : null,
      thumb: opts.thumb || null, thumbs: opts.thumbs || null,
      put: opts.put, az: opts.az, base: null, redactions: [], history: [], tool: opts.tool || null, dirty: false,
      ok: !!opts.ok, pos: opts.pos || 1, total: opts.total || 1, open: opts.open || 0, busy: false,
    }
    renderStrip()
    canvas.width = 1
    canvas.height = 1
    msg('Foto wird geladen …')
    if (!dlg.open) dlg.showModal()
    document.documentElement.classList.add('has-editor-dialog')
    updateUi()
    var s = state
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

  window.photoEditor = { open: open, openThumb: openThumb }
})()
