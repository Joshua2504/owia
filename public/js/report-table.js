// Verhalten der gemeinsamen Anzeigen-Tabelle (src/views/partials/report-table.ejs):
// - Thumbnails per Drag & Drop zwischen Entwürfen (oder in eine neue Anzeige) verschieben
// - Klick auf ein Thumbnail öffnet die Lightbox (gilt für alle [data-full-src] der Seite)
;(function () {
  var dragged = null // { imageId, az }

  document.querySelectorAll('[data-drag-image]').forEach(function (img) {
    img.addEventListener('dragstart', function (e) {
      dragged = { imageId: img.getAttribute('data-drag-image'), az: img.getAttribute('data-drag-az') }
      e.dataTransfer.effectAllowed = 'move'
      img.style.opacity = '0.4'
    })
    img.addEventListener('dragend', function () {
      img.style.opacity = ''
      document.querySelectorAll('[data-drop-az]').forEach(function (row) {
        row.classList.remove('table-primary')
      })
      var dropNew = document.getElementById('drop-new-draft')
      if (dropNew) dropNew.classList.remove('border-primary', 'text-primary')
    })
  })

  function moveDragged(moved, body) {
    fetch('/report/' + moved.az + '/images/' + moved.imageId + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (!res.ok) { alert(res.d.error || 'Verschieben fehlgeschlagen.'); return }
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
      row.classList.add('table-primary')
    })
    row.addEventListener('dragleave', function () {
      row.classList.remove('table-primary')
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
