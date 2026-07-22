// Lupe: beim Hover über ein Beweisfoto das Original 1:1 vergrößert anzeigen,
// der Cursor steuert den Ausschnitt (Kennzeichen prüfen ohne Lightbox).
// Bindet sich an alle <img> mit data-full-src (Anzeigen-/Import-Listen) oder
// data-zoom-src (Anzeigen-Detailseite); das Attribut liefert die Original-URL.
// Als Zoomfläche dient ein echtes <img> (kein CSS-Background), damit die
// EXIF-Drehung der Fotos in allen Browsern korrekt angewendet wird.
// Während eines Drag & Drop feuern keine Maus-Events; zusätzlich blenden
// dragstart/click (Lightbox) die Lupe explizit aus.
;(function () {
  var targets = document.querySelectorAll('img[data-full-src], img[data-zoom-src]')
  if (!targets.length) return

  var LOUPE_W = 300
  var LOUPE_H = 210
  var LOUPE_DELAY_MS = 150 // kurzes Verweilen nötig – kein Laden beim Vorbeifahren

  var loupe = document.createElement('div')
  loupe.style.cssText =
    'display:none;position:fixed;z-index:1990;width:' + LOUPE_W + 'px;height:' + LOUPE_H + 'px;' +
    'overflow:hidden;border:2px solid #fff;border-radius:.5rem;background:#222;' +
    'box-shadow:0 2px 14px rgba(0,0,0,.45);pointer-events:none'
  var loupeImg = document.createElement('img')
  loupeImg.style.cssText = 'position:absolute;left:0;top:0;max-width:none'
  loupe.appendChild(loupeImg)
  document.body.appendChild(loupe)

  var loupeTimer = null
  var loupeReady = false // Original geladen und Lupe aktiv?

  function hideLoupe() {
    clearTimeout(loupeTimer)
    loupeTimer = null
    loupeReady = false
    loupe.style.display = 'none'
  }

  // Ausschnitt + Position anhand der Cursor-Lage über dem Vorschaubild setzen.
  // Vorschaubilder sind mit object-fit:cover beschnitten – der sichtbare Bereich
  // wird auf das Original zurückgerechnet, damit die Lupe exakt die Stelle
  // unter dem Cursor zeigt.
  function positionLoupe(e, thumb) {
    var natW = loupeImg.naturalWidth
    var natH = loupeImg.naturalHeight
    if (!loupeReady || !natW || !natH) return
    var rect = thumb.getBoundingClientRect()
    var scale = Math.max(rect.width / natW, rect.height / natH)
    var visW = rect.width / scale
    var visH = rect.height / scale
    var fx = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    var fy = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
    var ix = (natW - visW) / 2 + fx * visW // Cursor-Punkt im Original (px)
    var iy = (natH - visH) / 2 + fy * visH
    loupeImg.style.left = Math.round(LOUPE_W / 2 - ix) + 'px'
    loupeImg.style.top = Math.round(LOUPE_H / 2 - iy) + 'px'

    // Neben dem Cursor anzeigen, an den Viewport-Rändern auf die andere Seite kippen.
    var x = e.clientX + 24
    var y = e.clientY + 24
    if (x + LOUPE_W > window.innerWidth - 8) x = e.clientX - LOUPE_W - 24
    if (y + LOUPE_H > window.innerHeight - 8) y = e.clientY - LOUPE_H - 24
    loupe.style.left = Math.max(8, x) + 'px'
    loupe.style.top = Math.max(8, y) + 'px'
  }

  targets.forEach(function (thumb) {
    var src = thumb.getAttribute('data-full-src') || thumb.getAttribute('data-zoom-src')
    if (!src) return
    var lastEvent = null
    thumb.addEventListener('mouseenter', function (e) {
      lastEvent = e
      clearTimeout(loupeTimer)
      loupeTimer = setTimeout(function () {
        var show = function () {
          loupeReady = true
          loupe.style.display = 'block'
          if (lastEvent) positionLoupe(lastEvent, thumb)
        }
        if (loupeImg.src.indexOf(src) !== -1 && loupeImg.complete && loupeImg.naturalWidth) {
          show()
        } else {
          loupeReady = false
          loupeImg.onload = show
          loupeImg.src = src
        }
      }, LOUPE_DELAY_MS)
    })
    thumb.addEventListener('mousemove', function (e) {
      lastEvent = e
      positionLoupe(e, thumb)
    })
    thumb.addEventListener('mouseleave', hideLoupe)
    // Beim Ziehen (Foto verschieben) und in der Lightbox stört die Lupe nur.
    thumb.addEventListener('dragstart', hideLoupe)
    thumb.addEventListener('click', hideLoupe)
  })
})()
