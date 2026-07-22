// Verhalten der gemeinsamen Anzeigen-Liste (src/views/partials/report-table.ejs):
// - Thumbnails per Drag & Drop zwischen Entwürfen (oder in eine neue Anzeige) verschieben
// - Klick auf ein Thumbnail öffnet die Lightbox (gilt für alle [data-full-src] der Seite)
;(function () {
  var dragged = null // { imageId, az }

  // Per Drag & Drop neu erstellte Entwürfe direkt UNTER ihrem Quell-Eintrag
  // einsortieren (statt der Server-Sortierung), damit man bequem weitere Fotos
  // aus derselben Anzeige hinüberziehen kann. Die Zuordnung (neues AZ -> Quell-AZ)
  // liegt pro Seite in der sessionStorage und wird nach jedem Reload wieder
  // angewendet, solange beide Einträge noch als Entwurf in der Liste stehen.
  var PLACE_KEY = 'draftPlacement:' + location.pathname
  function loadPlacements() {
    try {
      return JSON.parse(sessionStorage.getItem(PLACE_KEY)) || {}
    } catch (_) {
      return {}
    }
  }
  function rememberPlacement(newAz, afterAz) {
    var map = loadPlacements()
    map[newAz] = afterAz
    try {
      sessionStorage.setItem(PLACE_KEY, JSON.stringify(map))
    } catch (_) {}
  }
  function applyPlacements() {
    var map = loadPlacements()
    var changed = false
    Object.keys(map).forEach(function (newAz) {
      var source = document.querySelector('[data-drop-az="' + map[newAz] + '"]')
      var created = document.querySelector('[data-drop-az="' + newAz + '"]')
      if (source && created && source.parentNode === created.parentNode) {
        source.parentNode.insertBefore(created, source.nextSibling)
      } else {
        delete map[newAz] // Eintrag weg oder kein Entwurf mehr – Zuordnung vergessen
        changed = true
      }
    })
    if (changed) {
      try {
        sessionStorage.setItem(PLACE_KEY, JSON.stringify(map))
      } catch (_) {}
    }
  }

  document.querySelectorAll('[data-drag-image]').forEach(function (img) {
    img.addEventListener('dragstart', function (e) {
      dragged = { imageId: img.getAttribute('data-drag-image'), az: img.getAttribute('data-drag-az') }
      e.dataTransfer.effectAllowed = 'move'
      img.style.opacity = '0.4'
      // Das Drop-Ziel "neue Anzeige" direkt unter den Quell-Eintrag holen –
      // kurzer Weg statt ans Listenende ziehen. Verzögert, weil DOM-Änderungen
      // während dragstart den Drag in manchen Browsern abbrechen würden.
      setTimeout(function () {
        var dropNew = document.getElementById('drop-new-draft')
        var source = dragged && document.querySelector('[data-drop-az="' + dragged.az + '"]')
        if (dropNew && source) source.parentNode.insertBefore(dropNew, source.nextSibling)
      }, 0)
    })
    img.addEventListener('dragend', function () {
      img.style.opacity = ''
      document.querySelectorAll('[data-drop-az]').forEach(function (row) {
        row.classList.remove('bg-primary-subtle')
      })
      var dropNew = document.getElementById('drop-new-draft')
      if (dropNew) dropNew.classList.remove('border-primary', 'text-primary')
    })
  })

  function moveDragged(moved, body) {
    fetch('/anzeige/' + moved.az + '/images/' + moved.imageId + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (!res.ok) { alert(res.d.error || 'Verschieben fehlgeschlagen.'); return }
        if (body.newDraft && res.d.targetAz) rememberPlacement(res.d.targetAz, moved.az)
        location.reload()
      })
      .catch(function () { alert('Verschieben fehlgeschlagen.') })
  }

  document.querySelectorAll('[data-drop-az]').forEach(function (row) {
    var az = row.getAttribute('data-drop-az')
    row.addEventListener('dragover', function (e) {
      if (!dragged || dragged.az === az) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      row.classList.add('bg-primary-subtle')
    })
    row.addEventListener('dragleave', function () {
      row.classList.remove('bg-primary-subtle')
    })
    row.addEventListener('drop', function (e) {
      if (!dragged || dragged.az === az) return
      e.preventDefault()
      var moved = dragged
      dragged = null
      moveDragged(moved, { targetAz: az })
    })
  })

  // Drop-Ziel "neue Anzeige": legt einen frischen Entwurf an (EXIF des Fotos
  // als Vorbelegung) und hängt das Foto dort an.
  var dropNew = document.getElementById('drop-new-draft')
  if (dropNew) {
    dropNew.addEventListener('dragover', function (e) {
      if (!dragged) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      dropNew.classList.add('border-primary', 'text-primary')
    })
    dropNew.addEventListener('dragleave', function () {
      dropNew.classList.remove('border-primary', 'text-primary')
    })
    dropNew.addEventListener('drop', function (e) {
      if (!dragged) return
      e.preventDefault()
      var moved = dragged
      dragged = null
      moveDragged(moved, { newDraft: true })
    })
  }

  // Neu erstellte Entwürfe nach dem Reload wieder unter ihren Quell-Eintrag hängen.
  applyPlacements()

  // Lightbox: Klick auf ein Thumbnail zeigt das Bild in groß.
  var justDragged = false
  document.addEventListener('dragend', function () {
    justDragged = true
    setTimeout(function () { justDragged = false }, 200)
  }, true)

  var lightbox = document.createElement('div')
  lightbox.style.cssText =
    'display:none;position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.8);' +
    'align-items:center;justify-content:center;cursor:zoom-out;padding:2rem'
  var lightboxImg = document.createElement('img')
  lightboxImg.style.cssText = 'max-width:100%;max-height:100%;border-radius:.5rem'
  lightbox.appendChild(lightboxImg)
  document.body.appendChild(lightbox)
  function closeLightbox() {
    lightbox.style.display = 'none'
    lightboxImg.src = ''
  }
  lightbox.addEventListener('click', closeLightbox)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeLightbox()
  })
  document.querySelectorAll('[data-full-src]').forEach(function (img) {
    img.addEventListener('click', function () {
      if (justDragged) return // Klick direkt nach Drag & Drop ignorieren
      lightboxImg.src = img.getAttribute('data-full-src')
      lightbox.style.display = 'flex'
    })
  })
})()
