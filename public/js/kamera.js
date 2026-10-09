// Kamera-Modus (/kamera, routes/kamera.ts) – Startseite der PWA.
//
// Ablauf: Kamera startet sofort → beliebig viele Fotos (max. MAX je Anzeige) →
// „Fertig" → Ansicht „Entwurf angelegt" mit optionalem Sticker-Scan (derselbe
// Kamera-Stream liest den QR-Code) → „Nächster Verstoß" oder „Vervollständigen
// & senden" (Foto-Prüfdialog in der Liste, /anzeigen?anzeige=…&von=kamera).
//
// Hochladen läuft im Hintergrund und nacheinander: Beim ersten Foto wird der
// Entwurf angelegt, jedes Foto geht sofort hoch. Wer schon den nächsten
// Verstoß fotografiert, wartet nicht – die Fotos älterer Entwürfe laufen
// weiter; erst wenn alle oben sind, setzt POST …/fertig die Tatzeit.
//
// Aufnahme: ImageCapture.takePhoto() (volle Sensorauflösung, Chrome/Android),
// sonst ein Standbild aus dem Video (iOS). Beide Wege liefern kein EXIF –
// Aufnahmezeit (Wanduhr des Handys) und Standort gehen als Formularfelder mit.
// Blitz: Taschenlampe als Dauerlicht (torch), wo das nicht geht der echte
// Blitz von takePhoto (fillLightMode). Ohne beides kein Blitz-Knopf.
;(function () {
  'use strict'
  var root = document.getElementById('kamera')
  if (!root) return
  var MAX = Number(root.getAttribute('data-max')) || 10
  function $(sel) { return root.querySelector(sel) }
  function noop() {}

  var video = $('[data-video]')
  var scanVideo = $('[data-scan-video]')
  var shootEl = $('[data-screen=shoot]')
  var resultEl = $('[data-screen=result]')
  var flashBtn = $('[data-act=flash]')
  var closeBtn = $('[data-act=close]')
  var shutter = $('[data-act=shoot]')
  var doneBtn = $('[data-act=done]')
  var uploadsBtn = $('[data-uploads]')
  var gallery = $('[data-gallery]')
  var preview = $('[data-preview]')

  var stream = null
  var track = null
  var starting = null
  var imageCapture = null
  var takePhotoBroken = false
  var torch = false // Taschenlampe schaltbar
  var fillModes = [] // fillLightMode-Werte von takePhoto
  var flashOn = false // Standard: aus (bewusst nicht gemerkt)
  var busy = false
  var geoWatch = null
  var pos = null
  var screen = 'shoot'

  var nextId = 1
  var drafts = []
  var cur = newDraft() // Entwurf, der gerade fotografiert wird
  var shown = null // Entwurf in der Ansicht „Entwurf angelegt"
  var previewItem = null
  var pumping = false
  var pumpTimer = null

  function newDraft() {
    var d = { az: null, creating: null, items: [], finishRequested: false, finishing: false, finished: false, discarded: false, sticker: null }
    drafts.push(d)
    return d
  }
  function live(d) { return d.items.filter(function (it) { return it.status !== 'gone' }) }
  function pending(d) { return d.items.filter(function (it) { return it.status === 'wait' || it.status === 'up' }).length }
  function plural(n, eins, viele) { return n + ' ' + (n === 1 ? eins : viele) }

  // ---------------------------------------------------------------------------
  // Server
  // ---------------------------------------------------------------------------

  function fail(msg, permanent) {
    var e = new Error(msg)
    e.permanent = permanent
    return e
  }

  // Fehler werden zu fail(): permanent = Wiederholen sinnlos (4xx außer 429,
  // abgelaufene Sitzung), sonst versucht die Warteschlange es erneut.
  function send(url, opts) {
    opts = opts || {}
    return OWIA.fetchJson(url, { method: opts.method || 'POST', json: opts.json, body: opts.body })
      .catch(function (err) {
        // Abgelaufene Sitzung: requireAuth leitet auf die Login-Seite um.
        if (err.redirected) throw fail('Sitzung abgelaufen – bitte neu anmelden.', true)
        if (!err.status) throw fail('Keine Verbindung.', false)
        var d = err.data || {}
        var e = fail(d.error || 'Fehler ' + err.status, err.status < 500 && err.status !== 429)
        e.doppelt = !!d.doppelt
        throw e
      })
  }

  function azUrl(d, rest) { return '/kamera/' + encodeURIComponent(d.az) + rest }

  function ensureDraft(d) {
    if (d.az) return Promise.resolve(d.az)
    if (!d.creating) {
      d.creating = send('/kamera/entwurf').then(function (r) {
        d.az = r.az
        // Während des Anlegens verworfen: gleich in den Papierkorb.
        if (d.discarded) send(azUrl(d, '/verwerfen')).catch(noop)
        render()
        return d.az
      })
      d.creating.catch(function () { d.creating = null })
    }
    return d.creating
  }

  // Eine Warteschlange für alle Entwürfe, ein Upload zur Zeit (Handynetz).
  function nextWaiting() {
    var best = null
    drafts.forEach(function (d) {
      d.items.forEach(function (it) {
        if (it.status === 'wait' && (!best || (it.retryAt || 0) < (best.retryAt || 0))) best = it
      })
    })
    return best
  }

  function pump() {
    if (pumping) return
    clearTimeout(pumpTimer)
    var item = nextWaiting()
    if (!item) {
      checkFinish()
      render()
      return
    }
    var wait = (item.retryAt || 0) - Date.now()
    if (wait > 0) {
      pumpTimer = setTimeout(pump, wait)
      return
    }
    pumping = true
    item.status = 'up'
    render()
    var d = item.draft
    ensureDraft(d)
      .then(function () {
        var fd = new FormData()
        if (item.meta) {
          fd.append('aufgenommen', item.meta.aufgenommen)
          if (item.meta.pos) {
            fd.append('lat', String(item.meta.pos.lat))
            fd.append('lon', String(item.meta.pos.lon))
            fd.append('genauigkeit', String(Math.round(item.meta.pos.acc)))
          }
        }
        fd.append('bild', item.blob, item.name)
        return send(azUrl(d, '/foto'), { body: fd })
      })
      .then(function (r) {
        item.serverId = r.id
        if (item.status === 'gone') removeOnServer(item) // während des Uploads gelöscht
        else item.status = 'ok'
        item.blob = null
      }, function (err) {
        if (item.status === 'gone') return
        if (err.doppelt) {
          item.status = 'gone'
          flashHint(err.message)
        } else if (!err.permanent && (item.tries = (item.tries || 0) + 1) < 4) {
          item.status = 'wait'
          item.retryAt = Date.now() + [1500, 4000, 10000][item.tries - 1]
        } else {
          item.status = 'err'
          item.error = err.message
        }
      })
      .then(function () {
        pumping = false
        pump()
      })
  }

  function removeOnServer(item) {
    if (!item.serverId || !item.draft.az) return
    send('/anzeige/' + encodeURIComponent(item.draft.az) + '/images/' + item.serverId, { method: 'DELETE' }).catch(noop)
  }

  // Alle Fotos eines abgeschlossenen Entwurfs oben → Tatzeit setzen lassen.
  function checkFinish() {
    drafts.forEach(function (d) {
      if (!d.finishRequested || d.finished || d.finishing || d.discarded || !d.az || pending(d)) return
      d.finishing = true
      send(azUrl(d, '/fertig')).then(function () {
        d.finished = true
      }, function () {
        setTimeout(checkFinish, 4000)
      }).then(function () {
        d.finishing = false
        if (d !== shown) release(d)
        render()
      })
    })
  }

  function retryFailed() {
    drafts.forEach(function (d) {
      d.items.forEach(function (it) {
        if (it.status === 'err') {
          it.status = 'wait'
          it.tries = 0
          it.retryAt = 0
        }
      })
    })
    pump()
  }

  function discard(d) {
    d.discarded = true
    d.items.forEach(function (it) { if (it.status !== 'up') it.status = 'gone' })
    if (d.az) send(azUrl(d, '/verwerfen')).catch(noop)
    release(d)
  }

  // Vorschaubilder freigeben, sobald ein Entwurf nicht mehr angezeigt wird.
  function release(d) {
    if (d === cur || d === shown || pending(d)) return
    d.items.forEach(function (it) {
      if (it.url) URL.revokeObjectURL(it.url)
      it.url = null
    })
  }

  // ---------------------------------------------------------------------------
  // Kamera
  // ---------------------------------------------------------------------------

  function showMsg(text) {
    var box = $('[data-msg]')
    box.hidden = !text
    if (text) $('[data-msg-text]').textContent = text
  }

  function startCamera() {
    if (stream) return Promise.resolve()
    if (starting) return starting
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMsg('Dieser Browser kann nicht auf die Kamera zugreifen. Du kannst Fotos aus der Galerie wählen.')
      return Promise.resolve()
    }
    showMsg(null)
    startGeo()
    starting = navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false })
      .catch(function (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err
        return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      })
      .then(function (s) {
        if (document.hidden) {
          s.getTracks().forEach(function (t) { t.stop() })
          return
        }
        stream = s
        track = s.getVideoTracks()[0]
        video.srcObject = s
        video.play().catch(noop)
        if (screen === 'result') startScan()
        return setupTrack()
      })
      .catch(function (err) {
        showMsg(err && err.name === 'NotAllowedError'
          ? 'Kein Zugriff auf die Kamera. Bitte in den Browser-Einstellungen erlauben – oder Fotos aus der Galerie wählen.'
          : 'Kamera nicht verfügbar. Du kannst Fotos aus der Galerie wählen.')
      })
      .then(function () {
        starting = null
        render()
      })
    return starting
  }

  function setupTrack() {
    var caps = track.getCapabilities ? track.getCapabilities() : {}
    torch = !!caps.torch
    if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(noop)
    }
    imageCapture = null
    fillModes = []
    var ready = Promise.resolve()
    if ('ImageCapture' in window && !takePhotoBroken) {
      try { imageCapture = new window.ImageCapture(track) } catch (_) { imageCapture = null }
      if (imageCapture && imageCapture.getPhotoCapabilities) {
        ready = imageCapture.getPhotoCapabilities().then(function (pc) {
          fillModes = pc.fillLightMode || []
        }).catch(noop)
      }
    }
    return ready.then(function () {
      flashBtn.hidden = !(torch || fillModes.indexOf('flash') >= 0)
      applyTorch()
    })
  }

  function applyTorch() {
    if (!torch || !track) return
    track.applyConstraints({ advanced: [{ torch: flashOn }] }).catch(noop)
  }

  function stopCamera() {
    stopScan()
    if (stream) stream.getTracks().forEach(function (t) { t.stop() })
    stream = null
    track = null
    imageCapture = null
    video.srcObject = null
    scanVideo.srcObject = null
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch)
    geoWatch = null
  }

  // Standort laufend mitlesen, damit er beim Auslösen schon da ist.
  function startGeo() {
    if (geoWatch !== null || !navigator.geolocation) return
    geoWatch = navigator.geolocation.watchPosition(function (p) {
      pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }
    }, noop, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 })
  }

  function freshPos() {
    return pos && Date.now() - pos.at < 120000 ? pos : null
  }

  function toJpeg(source, w, h, quality) {
    // Lange Seite höchstens 4000 px: reicht für Kennzeichen, bleibt unter dem
    // Upload-Limit und schont den Speicher älterer Handys.
    var scale = Math.min(1, 4000 / Math.max(w, h))
    var c = document.createElement('canvas')
    c.width = Math.round(w * scale)
    c.height = Math.round(h * scale)
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height)
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('leer')) }, 'image/jpeg', quality)
    })
  }

  function grabFrame() {
    var w = video.videoWidth
    var h = video.videoHeight
    if (!w || !h) return Promise.reject(new Error('Kamera noch nicht bereit'))
    return toJpeg(video, w, h, 0.92)
  }

  // takePhoto-JPEGs können eine EXIF-Drehung tragen; über ein ImageBitmap
  // gezeichnet, steht das Bild danach richtig herum (und ist kleiner).
  function normalize(blob) {
    var bmp
    try { bmp = createImageBitmap(blob, { imageOrientation: 'from-image' }) } catch (_) { bmp = createImageBitmap(blob) }
    return bmp.then(function (b) {
      return toJpeg(b, b.width, b.height, 0.9).then(function (out) {
        if (b.close) b.close()
        return out
      })
    })
  }

  function capture() {
    if (!imageCapture || takePhotoBroken) return grabFrame()
    var settings = {}
    if (!torch) {
      var mode = flashOn ? 'flash' : 'off'
      if (fillModes.indexOf(mode) >= 0) settings.fillLightMode = mode
    }
    var timeout = new Promise(function (_, reject) { setTimeout(function () { reject(new Error('Zeitüberschreitung')) }, 5000) })
    return Promise.race([imageCapture.takePhoto(settings), timeout])
      .then(normalize)
      .catch(function () {
        // Manche Geräte können takePhoto nicht zuverlässig – ab jetzt Standbilder.
        takePhotoBroken = true
        return grabFrame()
      })
      .then(function (blob) {
        if (flashOn) applyTorch() // takePhoto setzt die Lampe teils zurück
        return blob
      })
  }

  function blitzEffect() {
    var fx = $('[data-fx]')
    fx.classList.remove('is-on')
    void fx.offsetWidth
    fx.classList.add('is-on')
    if (navigator.vibrate) navigator.vibrate(15)
  }

  function shoot() {
    if (busy || !stream) return
    if (live(cur).length >= MAX) return flashHint('Maximal ' + MAX + ' Fotos pro Anzeige – tippe auf „Fertig“.')
    busy = true
    var meta = { aufgenommen: OWIA.dateStamp(new Date()), pos: freshPos() }
    blitzEffect()
    render()
    capture()
      .then(function (blob) { addItem(cur, blob, meta, 'kamera-' + meta.aufgenommen.replace(/\D/g, '') + '.jpg') })
      .catch(function () { flashHint('Foto konnte nicht aufgenommen werden – bitte nochmal.') })
      .then(function () {
        busy = false
        render()
      })
  }

  function addItem(d, blob, meta, name) {
    d.items.push({ id: nextId++, draft: d, blob: blob, url: URL.createObjectURL(blob), meta: meta, name: name, status: 'wait' })
    render()
    var strip = $('[data-strip]')
    strip.scrollLeft = strip.scrollWidth
    pump()
  }

  function pickFiles(files) {
    var frei = MAX - live(cur).length
    var list = Array.prototype.slice.call(files || []).filter(function (f) { return /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png)$/i.test(f.name) })
    if (list.length > frei) flashHint('Nur ' + frei + ' weitere Fotos möglich – der Rest wurde übersprungen.')
    // Galerie-Fotos tragen ihr eigenes EXIF (Zeit, GPS) – keine Ersatzwerte.
    list.slice(0, frei).forEach(function (f) { addItem(cur, f, null, f.name || 'foto.jpg') })
  }

  // ---------------------------------------------------------------------------
  // Sticker-Scan in der Ansicht „Entwurf angelegt"
  // ---------------------------------------------------------------------------

  var scanning = false
  var scanTimer = null
  var lastCode = null

  function scanStatus(text, cls) {
    var el = $('[data-scan-status]')
    el.textContent = text
    el.className = 'small mt-2 ' + (cls || '')
  }

  function startScan() {
    if (scanning || !shown || shown.sticker) return
    if (!stream) return scanStatus('Kamera aus – bitte den Code unter dem QR-Code eintippen.', 'text-secondary')
    scanning = true
    scanVideo.srcObject = stream
    scanVideo.play().catch(noop)
    window.OWIA.qrDecoder().then(function (decoder) {
      function tick() {
        if (!scanning) return
        decoder.decode(scanVideo).then(function (texts) {
          for (var i = 0; i < texts.length; i++) {
            var m = window.OWIA.STICKER_RE.exec(texts[i] || '')
            if (m) {
              var code = m[1].toUpperCase()
              if (code !== lastCode) {
                lastCode = code
                linkSticker(code)
                return
              }
            }
          }
          if (texts.length && !lastCode) scanStatus('Das ist kein OWiA-Sticker – bitte den QR-Code eines Stickers ins Bild halten.', 'text-warning')
        }).catch(noop).then(function () {
          if (scanning) scanTimer = setTimeout(tick, 250)
        })
      }
      tick()
    }).catch(function () {
      scanning = false
      scanStatus('QR-Erkennung nicht verfügbar – bitte den Code unter dem QR-Code eintippen.', 'text-warning')
    })
  }

  function stopScan() {
    scanning = false
    clearTimeout(scanTimer)
  }

  function linkSticker(code) {
    var d = shown
    if (!d || d.sticker) return
    stopScan()
    scanStatus('Sticker wird verknüpft …')
    ensureDraft(d)
      .then(function () { return send(azUrl(d, '/sticker'), { json: { code: code } }) })
      .then(function (r) {
        d.sticker = r.code
        if (navigator.vibrate) navigator.vibrate([20, 60, 20])
        render()
      }, function (err) {
        // Netzfehler: derselbe Code darf beim nächsten Erkennen erneut versucht werden.
        if (!err.permanent) lastCode = null
        scanStatus(err.message, 'text-danger')
        if (d === shown && screen === 'result') startScan()
      })
  }

  // ---------------------------------------------------------------------------
  // Ansichten
  // ---------------------------------------------------------------------------

  var hintTimer = null
  var hintOverride = null
  function flashHint(text) {
    hintOverride = text
    clearTimeout(hintTimer)
    hintTimer = setTimeout(function () { hintOverride = null; render() }, 3500)
    render()
  }

  function thumbsHtml(items, cls) {
    var esc = window.OWIA.escapeHtml
    return items.map(function (it) {
      return '<button type="button" class="' + cls + ' is-' + it.status + '" data-item="' + it.id + '"' +
        (it.error ? ' title="' + esc(it.error) + '"' : '') + ' aria-label="Foto ansehen">' +
        (it.url ? '<img src="' + esc(it.url) + '" alt="">' : '') + '</button>'
    }).join('')
  }

  function render() {
    var n = live(cur).length
    closeBtn.textContent = n ? '✕ Verwerfen' : '← Anzeigen'
    doneBtn.disabled = n === 0
    $('[data-count]').textContent = n
    shutter.disabled = !stream || busy || n >= MAX
    flashBtn.textContent = flashOn ? '⚡ An' : '⚡ Aus'
    flashBtn.setAttribute('aria-pressed', flashOn ? 'true' : 'false')
    flashBtn.classList.toggle('is-on', flashOn)
    $('[data-hint]').textContent = hintOverride || (
      n === 0 ? 'Verstoß fotografieren – Übersicht und Kennzeichen.'
        : n >= MAX ? 'Maximal ' + MAX + ' Fotos – tippe auf „Fertig“.'
          : plural(n, 'Foto', 'Fotos') + ' – weitere aufnehmen oder „Fertig“.')
    $('[data-strip]').innerHTML = thumbsHtml(live(cur), 'kam-thumb')

    // Hintergrund-Uploads aller Entwürfe (auch bereits abgeschlossener).
    var offen = 0
    var fehler = 0
    drafts.forEach(function (d) {
      if (d.discarded) return
      offen += pending(d)
      d.items.forEach(function (it) { if (it.status === 'err') fehler++ })
    })
    uploadsBtn.hidden = !offen && !fehler
    uploadsBtn.classList.toggle('is-err', !!fehler)
    uploadsBtn.textContent = fehler ? '⚠ ' + fehler + ' nicht hochgeladen – erneut' : '⬆ ' + offen

    if (screen === 'result' && shown) renderResult()
  }

  function renderResult() {
    var d = shown
    var items = live(d)
    var ok = items.filter(function (it) { return it.status === 'ok' }).length
    var err = items.filter(function (it) { return it.status === 'err' }).length
    $('[data-r-az]').textContent = d.az || 'wird angelegt …'
    $('[data-r-fotos]').textContent = plural(items.length, 'Foto', 'Fotos')
    $('[data-r-thumbs]').innerHTML = thumbsHtml(items, 'kam-thumb kam-thumb-sm')
    var up = $('[data-r-upload]')
    if (err) {
      up.className = 'kam-r-upload small text-danger'
      up.innerHTML = '⚠ ' + plural(err, 'Foto wurde', 'Fotos wurden') + ' nicht hochgeladen. ' +
        '<button type="button" class="btn btn-sm btn-outline-light ms-1" data-act="retry">Erneut versuchen</button>'
    } else if (!d.finished) {
      up.className = 'kam-r-upload small text-secondary'
      up.textContent = 'Fotos werden hochgeladen … ' + ok + '/' + items.length
    } else {
      up.className = 'kam-r-upload small text-success'
      up.textContent = 'Alle Fotos gespeichert ✓ Kennzeichen und Adresse werden automatisch erkannt.'
    }

    var complete = $('[data-act=complete]')
    var bereit = d.finished && d.az
    complete.classList.toggle('disabled', !bereit)
    complete.setAttribute('aria-disabled', bereit ? 'false' : 'true')
    complete.href = bereit ? '/anzeigen?anzeige=' + encodeURIComponent(d.az) + '&foto=1&von=kamera' : '#'

    var okBox = $('[data-sticker-ok]')
    okBox.hidden = !d.sticker
    $('[data-scan]').hidden = !!d.sticker
    $('[data-scan-status]').hidden = !!d.sticker
    $('[data-code-form]').hidden = !!d.sticker
    if (d.sticker) okBox.textContent = '✓ Sticker ' + d.sticker + ' verknüpft – jetzt gut sichtbar aufkleben.'
  }

  function showScreen(name) {
    screen = name
    shootEl.hidden = name !== 'shoot'
    resultEl.hidden = name !== 'result'
    if (name === 'result') {
      resultEl.scrollTop = 0
      lastCode = null
      scanStatus('QR-Code des Stickers ins Bild halten …')
      $('[data-code-form]').reset()
      startScan()
    } else {
      stopScan()
    }
    render()
  }

  function finishShoot() {
    if (!live(cur).length) return
    if (shown && shown !== cur) {
      var alt = shown
      shown = null
      release(alt)
    }
    cur.finishRequested = true
    shown = cur
    cur = newDraft()
    ensureDraft(shown).catch(noop)
    checkFinish()
    showScreen('result')
  }

  function openPreview(id) {
    var all = []
    drafts.forEach(function (d) { all = all.concat(d.items) })
    previewItem = all.filter(function (it) { return it.id === id })[0] || null
    if (!previewItem || !previewItem.url) return
    $('[data-preview-img]').src = previewItem.url
    // Abgeschlossene Entwürfe: Fotos nur noch im Prüf-Modus löschen.
    $('[data-act=remove]').hidden = previewItem.draft !== cur
    preview.hidden = false
  }

  function closePreview() {
    preview.hidden = true
    previewItem = null
  }

  // ---------------------------------------------------------------------------
  // Ereignisse
  // ---------------------------------------------------------------------------

  root.addEventListener('click', function (e) {
    var thumb = e.target.closest('[data-item]')
    if (thumb) return openPreview(Number(thumb.getAttribute('data-item')))
    var btn = e.target.closest('[data-act]')
    if (!btn) return
    switch (btn.getAttribute('data-act')) {
      case 'shoot':
        return shoot()
      case 'done':
        return finishShoot()
      case 'flash':
        flashOn = !flashOn
        applyTorch()
        return render()
      case 'pick':
        return gallery.click()
      case 'start':
        return startCamera()
      case 'close': {
        var n = live(cur).length
        if (!n) {
          // Alle Fotos wieder gelöscht, Entwurf aber schon angelegt: nicht leer liegen lassen.
          if (cur.az || cur.creating) discard(cur)
          location.href = '/anzeigen'
          return
        }
        return OWIA.ask(plural(n, 'Foto', 'Fotos') + ' verwerfen?', { danger: true, ok: 'Verwerfen' }).then(function (ok) {
          if (!ok) return
          discard(cur)
          cur = newDraft()
          render()
        })
      }
      case 'next':
        return showScreen('shoot')
      case 'complete':
        if (btn.classList.contains('disabled')) e.preventDefault()
        return
      case 'discard':
        if (!shown) return
        return OWIA.ask('Diesen Entwurf mit ' + plural(live(shown).length, 'Foto', 'Fotos') + ' verwerfen? Er landet im Papierkorb.', { danger: true, ok: 'Verwerfen' }).then(function (ok) {
          if (!ok || !shown) return
          discard(shown)
          shown = null
          showScreen('shoot')
        })
      case 'retry':
        return retryFailed()
      case 'keep':
        return closePreview()
      case 'remove':
        if (previewItem) {
          var it = previewItem
          if (it.status === 'ok') removeOnServer(it)
          it.status = 'gone'
          closePreview()
          if (!live(cur).length && (cur.az || cur.creating)) {
            discard(cur)
            cur = newDraft()
          }
          render()
        }
    }
  })

  uploadsBtn.addEventListener('click', retryFailed)

  gallery.addEventListener('change', function () {
    pickFiles(gallery.files)
    gallery.value = ''
  })

  $('[data-code-form]').addEventListener('submit', function (e) {
    e.preventDefault()
    var code = String(this.elements.code.value || '').trim()
    if (!code) return
    lastCode = null
    linkSticker(code)
  })

  // Lautstärketasten gehen im Browser nicht – aber Enter/Leertaste (z. B.
  // Bluetooth-Auslöser) lösen aus.
  document.addEventListener('keydown', function (e) {
    if (screen !== 'shoot' || !preview.hidden || e.target.closest('input,textarea,select,button,a')) return
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'AudioVolumeUp') {
      e.preventDefault()
      shoot()
    }
  })

  // Kamera nicht im Hintergrund weiterlaufen lassen; beim Zurückkehren neu starten.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopCamera()
    else startCamera()
  })

  window.addEventListener('beforeunload', function (e) {
    var offen = drafts.some(function (d) { return !d.discarded && (pending(d) || (d.finishRequested && !d.finished && d.az)) })
    if (!offen) return
    e.preventDefault()
    e.returnValue = ''
  })

  render()
  startCamera()
})()
