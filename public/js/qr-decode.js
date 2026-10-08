// QR-Codes aus einem laufenden <video> lesen – gemeinsam für den Sticker-
// Scanner in der Anzeige (sticker-scan.js) und den Kamera-Modus (kamera.js).
// Erkennung per BarcodeDetector, wo vorhanden (Chrome/Android); sonst jsQR,
// das erst bei Bedarf nachgeladen wird (~130 KB, v. a. für iOS).
//
//   window.OWIA.qrDecoder()                 → Promise<{ decode(video) }>
//   decoder.decode(video)                   → Promise<string[]> (Rohtexte)
//   window.OWIA.STICKER_RE                  → Code aus der Sticker-URL
;(function () {
  'use strict'
  // Inhalt eines OWiA-Stickers: „HTTPS://HOST/S/7KQ2XM9P" (services/stickers.ts).
  var STICKER_RE = /\/S\/([0-9A-Z]{8})(?:[/?#]|$)/i
  var ready = null

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

  function create() {
    var detector = null
    var canvas = null
    var probe = Promise.resolve()
    if ('BarcodeDetector' in window) {
      probe = window.BarcodeDetector.getSupportedFormats().then(function (formats) {
        if (formats.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      }).catch(function () {})
    }
    return probe
      .then(function () { return detector ? null : loadJsQR() })
      .then(function () {
        return {
          decode: function (video) {
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
          },
        }
      })
  }

  window.OWIA = window.OWIA || {}
  window.OWIA.STICKER_RE = STICKER_RE
  window.OWIA.qrDecoder = function () {
    if (!ready) {
      ready = create()
      ready.catch(function () { ready = null })
    }
    return ready
  }
})()
