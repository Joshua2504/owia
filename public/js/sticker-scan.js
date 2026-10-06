// Sticker-Scanner in der Anzeige (partials/sticker-card.ejs): Kamera an,
// QR-Code lesen, Code ins Formular eintragen und absenden – den Rest erledigt
// POST /anzeige/:az/sticker (routes/sticker.ts).
// Erkennung per BarcodeDetector, wo vorhanden (Chrome/Android); sonst jsQR,
// das erst beim Öffnen des Scanners nachgeladen wird (~130 KB, v. a. für iOS).
;(function () {
  'use strict'
  var form = document.querySelector('[data-sticker-form]')
  var box = document.querySelector('[data-sticker-scanner]')
  var startBtn = document.querySelector('[data-sticker-scan]')
  if (!form || !box || !startBtn) return
  var video = box.querySelector('video')
  var status = box.querySelector('[data-sticker-status]')
  // Inhalt eines OWiA-Stickers: „HTTPS://HOST/S/7KQ2XM9P" (services/stickers.ts).
  var RE = /\/S\/([0-9A-Z]{8})(?:[/?#]|$)/i

  var stream = null
  var timer = null
  var detector = null
  var canvas = null
  var done = false

  function setStatus(text) { status.textContent = text }

  function stopStream() {
    clearTimeout(timer)
    timer = null
    if (stream) stream.getTracks().forEach(function (t) { t.stop() })
    stream = null
    video.srcObject = null
  }

  function close() {
    stopStream()
    box.classList.add('d-none')
  }

  function loadJsQR() {
    return new Promise(function (resolve, reject) {
      if (window.jsQR) return resolve()
      var s = document.createElement('script')
      s.src = '/public/vendor/jsqr.min.js'
      s.onload = function () { resolve() }
      s.onerror = reject
      document.head.appendChild(s)
    })
  }

  function decode() {
    if (detector) {
      return detector.detect(video).then(function (codes) {
        return codes.map(function (c) { return c.rawValue })
      })
    }
    var w = video.videoWidth
    var h = video.videoHeight
    if (!w || !h) return Promise.resolve([])
    // Auf ~640 px verkleinern: jsQR ist sonst auf älteren Handys zu langsam.
    var scale = Math.min(1, 640 / Math.max(w, h))
    canvas = canvas || document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    var ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    var r = window.jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
    return Promise.resolve(r ? [r.data] : [])
  }

  function tick() {
    if (done || !stream) return
    decode().then(function (texts) {
      for (var i = 0; i < texts.length; i++) {
        var m = RE.exec(texts[i] || '')
        if (m) {
          done = true
          form.elements.code.value = m[1].toUpperCase()
          setStatus('Erkannt: ' + m[1].toUpperCase() + ' – wird verknüpft …')
          stopStream()
          form.submit()
          return
        }
      }
      if (texts.length) setStatus('Das ist kein OWiA-Sticker – bitte den QR-Code eines Stickers ins Bild halten.')
    }).catch(function () { /* einzelner Frame unlesbar – weiter versuchen */ }).then(function () {
      if (!done && stream) timer = setTimeout(tick, 200)
    })
  }

  function start() {
    done = false
    box.classList.remove('d-none')
    setStatus('Kamera wird gestartet …')
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Dieser Browser kann nicht auf die Kamera zugreifen – bitte den Code unter dem QR-Code abtippen.')
      return
    }
    var ready = Promise.resolve()
    if (!detector && 'BarcodeDetector' in window) {
      ready = window.BarcodeDetector.getSupportedFormats().then(function (formats) {
        if (formats.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      }).catch(function () {})
    }
    ready
      .then(function () { return detector ? null : loadJsQR() })
      .then(function () {
        return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      })
      .then(function (s) {
        stream = s
        video.srcObject = s
        return video.play()
      })
      .then(function () {
        setStatus('QR-Code des Stickers ins Bild halten …')
        tick()
      })
      .catch(function (err) {
        stopStream()
        setStatus(err && err.name === 'NotAllowedError'
          ? 'Kamerazugriff verweigert – bitte den Code unter dem QR-Code abtippen.'
          : 'Kamera nicht verfügbar – bitte den Code unter dem QR-Code abtippen.')
      })
  }

  startBtn.addEventListener('click', start)
  box.querySelector('[data-sticker-stop]').addEventListener('click', close)
  // Kamera nicht im Hintergrund weiterlaufen lassen.
  document.addEventListener('visibilitychange', function () { if (document.hidden) close() })
})()
