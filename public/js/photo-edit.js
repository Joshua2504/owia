// Foto direkt in der Anzeigen-Liste schwärzen, verpixeln, zuschneiden, drehen.
// Öffnet sich aus der Foto-Vorschau (image-preview.js, Buttons bei Entwurfs-
// Fotos mit data-photo-edit) als Vollbild-Dialog. Gespeichert wird wie im
// Editor (report-form.js): Leinwand → JPEG → PUT /anzeige/:az/images/:id
// (neue Fassung, das Original bleibt auf dem Server erhalten). Danach lädt
// report-table.js die Zeile neu (neue Vorschaubilder).
//
// Bewusst eigenständig statt report-form.js wiederzuverwenden: dessen
// Leinwand-Code hängt an den Editor-Karten (Autosave, Upload-Status, Karte).
;(function () {
  var MAX_DIM = 2560 // wie report-form.js
  var MIN_BOX = 6

  var dlg = null
  var canvas = null
  var ctx = null
  var state = null // { put, az, base, redactions, history, tool, dirty }

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
      '<div class="ms-auto d-flex gap-2">' +
      '<button type="button" class="btn btn-sm btn-outline-light" data-act="cancel">Abbrechen</button>' +
      '<button type="button" class="btn btn-sm btn-primary" data-act="save" disabled>Speichern</button>' +
      '</div></div>' +
      '<div class="photo-edit-stage"><canvas></canvas><div class="photo-edit-msg"></div></div>'
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
    dlg.addEventListener('cancel', function (e) {
      e.preventDefault()
      cancel()
    })
    attachDrawing()
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
    dlg.querySelector('[data-act=save]').disabled = !state.dirty
    var tips = {
      black: 'Rechtecke über Gesichter oder fremde Kennzeichen ziehen.',
      pixel: 'Rechtecke über die zu verpixelnden Bereiche ziehen.',
      crop: 'Den Ausschnitt aufziehen, der übrig bleiben soll.',
    }
    dlg.querySelector('.photo-edit-hint').textContent = state.tool ? tips[state.tool] : 'Werkzeug wählen.'
    canvas.classList.toggle('editing', !!state.tool)
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
    close()
  }

  function save() {
    var btn = dlg.querySelector('[data-act=save]')
    btn.disabled = true
    btn.textContent = 'Speichert …'
    redraw() // keine Zeichen-Vorschau im Export
    var s = state
    canvas.toBlob(function (blob) {
      var fd = new FormData()
      fd.append('bilder', blob, 'bearbeitet.jpg')
      fetch(s.put, { method: 'PUT', body: fd })
        .then(function (r) {
          if (!r.ok || r.redirected) throw new Error()
          close()
          if (window.reportTableRefresh) return window.reportTableRefresh(s.az)
        })
        .catch(function () {
          alert('Speichern fehlgeschlagen – bitte erneut versuchen.')
        })
        .finally(function () {
          btn.textContent = 'Speichern'
          btn.disabled = false
        })
    }, 'image/jpeg', 0.9)
  }

  // opts: { src: Bild-URL, put: PUT-URL der Fassung, az, tool }
  function open(opts) {
    if (!dlg) build()
    state = { put: opts.put, az: opts.az, base: null, redactions: [], history: [], tool: opts.tool || null, dirty: false }
    canvas.width = 1
    canvas.height = 1
    msg('Foto wird geladen …')
    dlg.showModal()
    document.documentElement.classList.add('has-editor-dialog')
    updateUi()
    var img = new Image()
    img.onload = function () {
      if (!state) return
      var scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
      var c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * scale))
      c.height = Math.max(1, Math.round(img.naturalHeight * scale))
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      state.base = c
      msg('')
      redraw()
      updateUi()
    }
    img.onerror = function () { msg('Foto konnte nicht geladen werden.') }
    img.src = opts.src
  }

  window.photoEditor = { open: open }
})()
