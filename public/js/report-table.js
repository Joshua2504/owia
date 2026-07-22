// Verhalten der gemeinsamen Anzeigen-Tabelle (src/views/partials/report-table.ejs):
// - Thumbnails per Drag & Drop zwischen Entwürfen (oder in eine neue Anzeige) verschieben.
//   Alle Änderungen passieren OHNE Seiten-Reload direkt im DOM (das Thumbnail
//   wandert in die Ziel-Zeile; eine neue Anzeige kommt als serverseitig
//   gerenderte Zeile von /anzeige/:az/listenzeile) – die Tabelle bleibt ruhig
//   und die Scroll-Position erhalten.
// - Klick auf ein Thumbnail öffnet die Lightbox (gilt für alle [data-full-src] der Seite)
// - Hover-Lupe zum Kennzeichen-Prüfen: siehe public/js/image-loupe.js
;(function () {
  var dragged = null // { imageId, az, el }

  // ---------------------------------------------------------------------------
  // Drag & Drop
  // ---------------------------------------------------------------------------

  function bindDragImage(img) {
    img.addEventListener('dragstart', function (e) {
      dragged = {
        imageId: img.getAttribute('data-drag-image'),
        az: img.getAttribute('data-drag-az'),
        el: img,
      }
      e.dataTransfer.effectAllowed = 'move'
      img.style.opacity = '0.4'
      // Das Drop-Ziel "neue Anzeige" direkt unter den Quell-Eintrag holen –
      // kurzer Weg statt ans Listenende ziehen. Bei Tabellenzeilen wird es in
      // eine eingeschobene Zwischenzeile (colspan über alle Spalten) gesetzt.
      // Verzögert, weil DOM-Änderungen während dragstart den Drag in manchen
      // Browsern abbrechen würden.
      setTimeout(function () {
        var dropNew = document.getElementById('drop-new-draft')
        var source = dragged && document.querySelector('[data-drop-az="' + dragged.az + '"]')
        if (!dropNew || !source) return
        if (source.tagName === 'TR') {
          var row = document.getElementById('drop-new-draft-row')
          if (!row) {
            row = document.createElement('tr')
            row.id = 'drop-new-draft-row'
            row.appendChild(document.createElement('td'))
          }
          row.firstChild.colSpan = source.children.length
          row.firstChild.appendChild(dropNew)
          source.parentNode.insertBefore(row, source.nextSibling)
        } else {
          source.parentNode.insertBefore(dropNew, source.nextSibling)
        }
      }, 0)
    })
    img.addEventListener('dragend', function () {
      img.style.opacity = ''
      document.querySelectorAll('[data-drop-az]').forEach(function (row) {
        row.classList.remove('table-primary', 'bg-primary-subtle')
      })
      restoreDropZone()
    })
  }

  // Drop-Ziel "neue Anzeige" nach dem Drag zurück an seinen ursprünglichen
  // Platz unter der Tabelle (die Zwischenzeile verschwindet wieder).
  var dropNewHome = null // { parent, nextSibling }
  function restoreDropZone() {
    var dropNew = document.getElementById('drop-new-draft')
    var row = document.getElementById('drop-new-draft-row')
    if (dropNew && dropNewHome && dropNew.parentNode !== dropNewHome.parent) {
      dropNewHome.parent.insertBefore(dropNew, dropNewHome.nextSibling)
      dropNew.classList.remove('border-primary', 'text-primary')
    }
    if (row) row.remove()
  }

  function moveDragged(moved, body) {
    fetch('/anzeige/' + moved.az + '/images/' + moved.imageId + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (!res.ok) { alert(res.d.error || 'Verschieben fehlgeschlagen.'); return }
        if (body.newDraft) insertNewDraftRow(moved, res.d.targetAz)
        else adoptImage(moved, res.d.targetAz)
      })
      .catch(function () { alert('Verschieben fehlgeschlagen.') })
  }

  // Thumbnail ohne Reload in die Ziel-Zeile übernehmen: Element umhängen und
  // seine URLs/Attribute auf das neue Aktenzeichen umschreiben.
  function adoptImage(moved, targetAz) {
    var targetRow = document.querySelector('[data-drop-az="' + targetAz + '"]')
    var photos = targetRow && targetRow.querySelector('[data-photos]')
    var img = moved.el
    if (!photos || !img) { location.reload(); return } // Fallback: alte Ziel-Zeile unbekannt
    img.src = '/anzeige/' + targetAz + '/image/' + moved.imageId + '/thumb.jpg'
    img.setAttribute('data-full-src', '/anzeige/' + targetAz + '/image/' + moved.imageId)
    img.setAttribute('data-drag-az', targetAz)
    photos.appendChild(img)
  }

  // Neue Anzeige: fertig gerenderte Zeile vom Server holen und direkt unter der
  // Quell-Zeile einfügen (das verschobene Foto ist darin bereits enthalten).
  function insertNewDraftRow(moved, targetAz) {
    var source = document.querySelector('[data-drop-az="' + moved.az + '"]')
    var dropNew = document.getElementById('drop-new-draft')
    var queue = dropNew && dropNew.getAttribute('data-queue')
    fetch('/anzeige/' + targetAz + '/listenzeile' + (queue ? '?queue=' + queue : ''))
      .then(function (r) {
        if (!r.ok) throw new Error()
        return r.text()
      })
      .then(function (html) {
        if (!source || source.tagName !== 'TR') { location.reload(); return }
        var tbody = document.createElement('tbody')
        tbody.innerHTML = html
        var row = tbody.querySelector('tr')
        if (!row) { location.reload(); return }
        source.parentNode.insertBefore(row, source.nextSibling)
        if (moved.el) moved.el.remove() // Foto hängt jetzt in der neuen Zeile
        bindRow(row)
      })
      .catch(function () { location.reload() }) // Zeile nicht ladbar – Reload als Fallback
  }

  function bindDropTarget(row) {
    var az = row.getAttribute('data-drop-az')
    row.addEventListener('dragover', function (e) {
      if (!dragged || dragged.az === az) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      row.classList.add(row.tagName === 'TR' ? 'table-primary' : 'bg-primary-subtle')
    })
    row.addEventListener('dragleave', function () {
      row.classList.remove('table-primary', 'bg-primary-subtle')
    })
    row.addEventListener('drop', function (e) {
      if (!dragged || dragged.az === az) return
      e.preventDefault()
      var moved = dragged
      dragged = null
      moveDragged(moved, { targetAz: az })
    })
  }

  // Events einer (neu eingefügten) Zeile verdrahten; für die initiale Seite
  // übernimmt das der Block ganz unten.
  function bindRow(row) {
    row.querySelectorAll('[data-drag-image]').forEach(bindDragImage)
    if (row.hasAttribute('data-drop-az')) bindDropTarget(row)
    row.querySelectorAll('[data-full-src]').forEach(bindLightbox)
    if (window.imageLoupe) row.querySelectorAll('img[data-full-src]').forEach(window.imageLoupe.bind)
  }

  document.querySelectorAll('[data-drag-image]').forEach(bindDragImage)
  document.querySelectorAll('[data-drop-az]').forEach(bindDropTarget)

  // Drop-Ziel "neue Anzeige": legt einen frischen Entwurf an (EXIF des Fotos
  // als Vorbelegung) und hängt das Foto dort an.
  var dropNew = document.getElementById('drop-new-draft')
  if (dropNew) {
    dropNewHome = { parent: dropNew.parentNode, nextSibling: dropNew.nextSibling }
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

  // ---------------------------------------------------------------------------
  // Lightbox: Klick auf ein Thumbnail zeigt das Bild in groß.
  // ---------------------------------------------------------------------------
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
  function bindLightbox(img) {
    img.addEventListener('click', function () {
      if (justDragged) return // Klick direkt nach Drag & Drop ignorieren
      lightboxImg.src = img.getAttribute('data-full-src')
      lightbox.style.display = 'flex'
    })
  }
  document.querySelectorAll('[data-full-src]').forEach(bindLightbox)
})()
