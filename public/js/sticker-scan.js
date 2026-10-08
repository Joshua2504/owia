// Sticker-Scanner in der Anzeige (partials/sticker-card.ejs): Kamera an,
// QR-Code lesen, Code ins Formular eintragen und absenden – den Rest erledigt
// POST /anzeige/:az/sticker (routes/sticker.ts).
// Erkennung: public/js/qr-decode.js (BarcodeDetector, sonst jsQR nachgeladen).
;(function () {
  'use strict'
  var form = document.querySelector('[data-sticker-form]')
  var box = document.querySelector('[data-sticker-scanner]')
  var startBtn = document.querySelector('[data-sticker-scan]')
  if (!form || !box || !startBtn) return
  var video = box.querySelector('video')
  var status = box.querySelector('[data-sticker-status]')
  var RE = window.OWIA.STICKER_RE

  var stream = null
  var timer = null
  var decoder = null
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

  function tick() {
    if (done || !stream) return
    decoder.decode(video).then(function (texts) {
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
    window.OWIA.qrDecoder()
      .then(function (d) {
        decoder = d
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
