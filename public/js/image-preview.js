// Foto-Vorschau für alle Listen, den Editor und die Detailseite.
//
//   Klick aufs Vorschaubild      → größere Vorschau direkt unter der Maus
//                                  (bewusst NICHT beim Hover: das störte beim
//                                  Ziehen von Fotos per Drag & Drop)
//   Klick auf die Vorschau       → Lupe rechts daneben (Ausschnitt folgt dem
//                                  Cursor, Mausrad ändert die Vergrößerung);
//                                  erneuter Klick schaltet die Lupe wieder aus
//   Doppelklick auf die Vorschau → Vollbild (Lightbox, Klick = 100 % / eingepasst)
//   Maus verlässt Vorschau+Bild, Escape oder Klick daneben → schließen
// Ohne Maus (Handy) öffnet ein Tipp direkt die Lightbox.
//
// Bindet sich per Event-Delegation an jedes <img data-full-src> bzw.
// <img data-zoom-src> (Attribut = URL des Originals). Dadurch funktionieren auch
// ohne Reload eingefügte Tabellenzeilen und neue Editor-Karten ohne Nachrüsten.
// <img data-no-lightbox> öffnet beim Klick keine Lightbox (Editor-Karten mit
// eigener Klick-Aktion).
//
// Hover-Vorschau und Lupe nur auf Geräten mit echter Maus – auf dem Handy gibt
// es kein Hover, dort öffnet ein Tipp direkt die Lightbox.
// Lupen-Fläche ist ein echtes <img> (kein CSS-Background), damit die
// EXIF-Drehung der Fotos in allen Browsern korrekt angewendet wird.
;(function () {
  var HIDE_DELAY_MS = 220 // Zeit, um von der Miniatur in die Vorschau zu wechseln
  var PREVIEW_MAX_W = 560
  var PREVIEW_MAX_H = 440
  var GAP = 14
  var canHover = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches

  function srcOf(el) {
    return el.getAttribute('data-full-src') || el.getAttribute('data-zoom-src')
  }
  function isThumb(el) {
    return el && el.tagName === 'IMG' && (el.hasAttribute('data-full-src') || el.hasAttribute('data-zoom-src'))
  }

  // ---------------------------------------------------------------------------
  // Elemente
  // ---------------------------------------------------------------------------
  var preview = document.createElement('div')
  preview.className = 'img-preview'
  preview.setAttribute('aria-hidden', 'true')
  preview.innerHTML =
    '<img alt="" class="img-preview-img">' +
    '<div class="img-preview-lens"></div>' +
    '<div class="img-preview-hint">Klicken zum Zoomen</div>'
  var previewImg = preview.querySelector('img')
  var lens = preview.querySelector('.img-preview-lens')
  var hint = preview.querySelector('.img-preview-hint')

  var zoom = document.createElement('div')
  zoom.className = 'img-zoom'
  zoom.setAttribute('aria-hidden', 'true')
  zoom.innerHTML = '<img alt=""><span class="img-zoom-level"></span>'
  var zoomImg = zoom.querySelector('img')
  var zoomLevel = zoom.querySelector('.img-zoom-level')

  function mount() {
    if (!preview.parentNode) document.body.appendChild(preview)
    if (!zoom.parentNode) document.body.appendChild(zoom)
  }

  var current = null // aktuelles Vorschaubild (Thumb-Element)
  var showTimer = null
  var hideTimer = null
  var zoomOn = false
  var factor = 3 // Vergrößerung relativ zur Vorschau
  var lastMove = null

  function hideAll() {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    current = null
    zoomOn = false
    preview.classList.remove('is-visible', 'is-zooming')
    zoom.classList.remove('is-visible')
  }

  function scheduleHide() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hideAll, HIDE_DELAY_MS)
  }

  // Vorschau-Größe aus dem Seitenverhältnis des Fotos, an den Viewport angepasst.
  function sizeFor(ratio) {
    var maxW = Math.min(PREVIEW_MAX_W, window.innerWidth - 2 * GAP)
    var maxH = Math.min(PREVIEW_MAX_H, window.innerHeight - 2 * GAP)
    var w = maxW
    var h = w / ratio
    if (h > maxH) {
      h = maxH
      w = h * ratio
    }
    return { w: Math.round(w), h: Math.round(h) }
  }

  // Unter dem Cursor platzieren; reicht der Platz nach unten nicht, darüber.
  function place(x, y, size) {
    var left = Math.min(Math.max(GAP, x - size.w * 0.25), window.innerWidth - size.w - GAP)
    var top = y + GAP
    if (top + size.h > window.innerHeight - GAP) {
      top = y - GAP - size.h
      if (top < GAP) top = Math.max(GAP, window.innerHeight - size.h - GAP)
    }
    preview.style.width = size.w + 'px'
    preview.style.height = size.h + 'px'
    preview.style.left = Math.round(left) + 'px'
    preview.style.top = Math.round(top) + 'px'
  }

  function show(thumb, e) {
    mount()
    var full = srcOf(thumb)
    if (!full) return
    current = thumb
    zoomOn = false
    preview.classList.remove('is-zooming')
    zoom.classList.remove('is-visible')
    hint.textContent = 'Klick: Lupe · Doppelklick: Vollbild'
    var ratio = thumb.naturalWidth && thumb.naturalHeight ? thumb.naturalWidth / thumb.naturalHeight : 4 / 3
    place(e.clientX, e.clientY, sizeFor(ratio))
    // Sofort das (schon geladene) Vorschaubild zeigen, dann das Original
    // nachladen – die Vorschau ist so ohne Wartezeit da.
    if (previewImg.getAttribute('data-src') !== full) {
      previewImg.setAttribute('data-src', full)
      previewImg.src = thumb.currentSrc || thumb.src
      var loader = new Image()
      loader.onload = function () {
        if (previewImg.getAttribute('data-src') !== full) return
        previewImg.src = full
        zoomImg.src = full
        // Exaktes Seitenverhältnis des Originals (Thumbs in Listen sind beschnitten).
        if (current === thumb && loader.naturalWidth) {
          var r = preview.getBoundingClientRect()
          var size = sizeFor(loader.naturalWidth / loader.naturalHeight)
          preview.style.width = size.w + 'px'
          preview.style.height = size.h + 'px'
          if (r.left + size.w > window.innerWidth - GAP) preview.style.left = Math.max(GAP, window.innerWidth - size.w - GAP) + 'px'
          if (r.top + size.h > window.innerHeight - GAP) preview.style.top = Math.max(GAP, window.innerHeight - size.h - GAP) + 'px'
        }
      }
      loader.src = full
    }
    preview.classList.add('is-visible')
  }

  // ---------------------------------------------------------------------------
  // Lupe
  // ---------------------------------------------------------------------------
  function placeZoom() {
    var r = preview.getBoundingClientRect()
    var w = Math.min(520, Math.max(260, window.innerWidth - r.right - 2 * GAP))
    var h = r.height
    var left = r.right + GAP
    // Rechts kein Platz → links neben die Vorschau.
    if (left + w > window.innerWidth - GAP) left = r.left - GAP - w
    if (left < GAP) left = GAP
    zoom.style.width = Math.round(w) + 'px'
    zoom.style.height = Math.round(h) + 'px'
    zoom.style.left = Math.round(left) + 'px'
    zoom.style.top = Math.round(r.top) + 'px'
  }

  function updateZoom(e) {
    if (!zoomOn) return
    lastMove = e
    var r = previewImg.getBoundingClientRect()
    var natW = zoomImg.naturalWidth
    var natH = zoomImg.naturalHeight
    if (!natW || !natH || !r.width) return
    var zr = zoom.getBoundingClientRect()
    // Dargestellte Größe des Fotos in der Lupe = Vorschau × Faktor.
    var dispW = r.width * factor
    var dispH = r.height * factor
    zoomImg.style.width = dispW + 'px'
    zoomImg.style.height = dispH + 'px'
    var fx = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1)
    var fy = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)
    var offX = Math.min(0, Math.max(zr.width - dispW, zr.width / 2 - fx * dispW))
    var offY = Math.min(0, Math.max(zr.height - dispH, zr.height / 2 - fy * dispH))
    zoomImg.style.left = Math.round(offX) + 'px'
    zoomImg.style.top = Math.round(offY) + 'px'
    // Rahmen in der Vorschau = sichtbarer Ausschnitt der Lupe.
    var lw = (zr.width / dispW) * r.width
    var lh = (zr.height / dispH) * r.height
    lens.style.width = Math.round(lw) + 'px'
    lens.style.height = Math.round(lh) + 'px'
    lens.style.left = Math.round((-offX / dispW) * r.width) + 'px'
    lens.style.top = Math.round((-offY / dispH) * r.height) + 'px'
    zoomLevel.textContent = factor.toFixed(1).replace('.0', '').replace('.', ',') + '×'
  }

  function setZoom(on, e) {
    zoomOn = on
    preview.classList.toggle('is-zooming', on)
    hint.textContent = on ? 'Mausrad: Vergrößerung · Klick: Lupe aus' : 'Klick: Lupe · Doppelklick: Vollbild'
    if (on) {
      if (zoomImg.getAttribute('src') !== previewImg.getAttribute('data-src')) zoomImg.src = previewImg.getAttribute('data-src')
      placeZoom()
      zoom.classList.add('is-visible')
      var go = function () { updateZoom(e) }
      if (zoomImg.complete && zoomImg.naturalWidth) go()
      else zoomImg.onload = function () { if (zoomOn) updateZoom(lastMove || e) }
    } else {
      zoom.classList.remove('is-visible')
    }
  }

  preview.addEventListener('mouseenter', function () { clearTimeout(hideTimer) })
  preview.addEventListener('mouseleave', function (e) {
    if (current && e.relatedTarget === current) return
    scheduleHide()
  })
  preview.addEventListener('click', function (e) {
    if (e.detail > 1) return // Teil eines Doppelklicks
    setZoom(!zoomOn, e)
  })
  preview.addEventListener('dblclick', function () {
    var src = previewImg.getAttribute('data-src')
    if (src) openBox(src)
  })
  preview.addEventListener('mousemove', updateZoom)
  preview.addEventListener('wheel', function (e) {
    if (!zoomOn) return
    e.preventDefault()
    factor = Math.min(8, Math.max(1.5, factor * (e.deltaY < 0 ? 1.2 : 1 / 1.2)))
    updateZoom(e)
  }, { passive: false })

  if (canHover) {
    // Zurück von der Vorschau aufs Bild: offen lassen.
    document.addEventListener('mouseover', function (e) {
      if (current && e.target === current) clearTimeout(hideTimer)
    })
    document.addEventListener('mouseout', function (e) {
      var t = e.target
      if (!isThumb(t)) return
      clearTimeout(showTimer)
      if (e.relatedTarget && (e.relatedTarget === preview || preview.contains(e.relatedTarget))) return
      if (current && t === current) scheduleHide()
    })
    // Klick daneben schließt.
    document.addEventListener('mousedown', function (e) {
      if (!current) return
      if (preview.contains(e.target) || e.target === current) return
      hideAll()
    })
  }
  // Beim Ziehen (Foto verschieben), Scrollen und Tastatur-Escape stört die Vorschau.
  document.addEventListener('dragstart', hideAll, true)
  window.addEventListener('scroll', function () { if (current && !zoomOn) hideAll() }, { passive: true })
  window.addEventListener('blur', hideAll)

  // ---------------------------------------------------------------------------
  // Lightbox (Klick auf ein Vorschaubild)
  // ---------------------------------------------------------------------------
  var box = document.createElement('div')
  box.className = 'img-lightbox'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-label', 'Foto in groß')
  box.innerHTML =
    '<button type="button" class="btn btn-light img-lightbox-close" aria-label="Schließen">✕</button>' +
    '<img alt="Foto in groß">'
  var boxImg = box.querySelector('img')
  var lastFocus = null
  function openBox(src) {
    hideAll()
    if (!box.parentNode) document.body.appendChild(box)
    box.classList.remove('is-actual')
    boxImg.src = src
    box.classList.add('is-visible')
    document.documentElement.style.overflow = 'hidden'
    lastFocus = document.activeElement
    box.querySelector('button').focus()
  }
  function closeBox() {
    if (!box.classList.contains('is-visible')) return
    box.classList.remove('is-visible')
    boxImg.removeAttribute('src')
    document.documentElement.style.overflow = ''
    if (lastFocus && lastFocus.focus) lastFocus.focus()
  }
  box.addEventListener('click', function (e) {
    // Klick aufs Foto: eingepasst ↔ Originalgröße (pannbar per Scrollen).
    if (e.target === boxImg) box.classList.toggle('is-actual')
    else closeBox()
  })

  // Ein Klick unmittelbar nach Drag & Drop ist kein Öffnen-Wunsch.
  var justDragged = false
  document.addEventListener('dragend', function () {
    justDragged = true
    setTimeout(function () { justDragged = false }, 200)
  }, true)
  document.addEventListener('click', function (e) {
    var t = e.target
    if (!isThumb(t) || justDragged) return
    e.preventDefault()
    if (canHover) {
      // Mit Maus: Vorschau unter dem Cursor (erneuter Klick schließt sie).
      if (current === t) hideAll()
      else show(t, e)
      return
    }
    if (t.hasAttribute('data-no-lightbox')) return
    openBox(srcOf(t))
  })
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    if (box.classList.contains('is-visible')) closeBox()
    else hideAll()
  })

  window.imagePreview = { hide: hideAll, open: openBox }
})()
