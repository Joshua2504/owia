// Verhalten der gemeinsamen Anzeigen-Tabelle (src/views/partials/report-table.ejs):
// - Thumbnails per Drag & Drop zwischen Entwürfen (oder in eine neue Anzeige) verschieben.
//   Alle Änderungen passieren OHNE Seiten-Reload direkt im DOM (das Thumbnail
//   wandert in die Ziel-Zeile; eine neue Anzeige kommt als serverseitig
//   gerenderte Zeile von /anzeige/:az/listenzeile) – die Tabelle bleibt ruhig
//   und die Scroll-Position erhalten.
// - Hover-Vorschau, Lupe und Lightbox der Thumbnails: public/js/image-preview.js
// - window.reportTableRefresh(az): eine Zeile neu vom Server holen (nach
//   Inline-/Modal-Bearbeitung); verschwundene Entwürfe fliegen aus der Liste.
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
      document.body.classList.add('is-dragging')
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
      document.body.classList.remove('is-dragging')
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
    return fetch('/anzeige/' + moved.az + '/images/' + moved.imageId + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Verschieben fehlgeschlagen.')
        if (body.newDraft) return insertNewDraftRow(moved, res.d.targetAz)
        else adoptImage(moved, res.d.targetAz)
      })

  }

  // Thumbnail ohne Reload in die Ziel-Zeile übernehmen: Element umhängen und
  // seine URLs/Attribute auf das neue Aktenzeichen umschreiben.
  function adoptImage(moved, targetAz) {
    var targetRow = document.querySelector('[data-drop-az="' + targetAz + '"]')
    var photos = targetRow && targetRow.querySelector('[data-photos]')
    var img = moved.el
    if (!photos || !img) { location.reload(); return } // Fallback: alte Ziel-Zeile unbekannt
    var version = (img.getAttribute('src').split('?v=')[1] || '')
    var suffix = version ? '?v=' + version : ''
    img.src = '/anzeige/' + targetAz + '/image/' + moved.imageId + '/thumb.jpg' + suffix
    img.setAttribute('data-full-src', '/anzeige/' + targetAz + '/image/' + moved.imageId + suffix)
    img.setAttribute('data-drag-az', targetAz)
    photos.appendChild(img.closest('.thumb-wrap') || img)
    targetRow.querySelector('.cell-photos').classList.remove('cell-empty')
    updatePhotoCell(moved.az)
    // Beide Zeilen frisch vom Server (Fotozahl „+N", Reihenfolge).
    window.reportTableRefresh(moved.az).catch(function () {})
    window.reportTableRefresh(targetAz).catch(function () {})
    document.dispatchEvent(new Event('reports:updated'))
  }

  // Neue Anzeige: fertig gerenderte Zeile vom Server holen und direkt unter der
  // Quell-Zeile einfügen (das verschobene Foto ist darin bereits enthalten).
  function insertNewDraftRow(moved, targetAz) {
    var source = document.querySelector('[data-drop-az="' + moved.az + '"]')
    var dropNew = document.getElementById('drop-new-draft')
    var queue = dropNew && dropNew.getAttribute('data-queue')
    return fetch('/anzeige/' + targetAz + '/listenzeile' + (queue ? '?queue=' + queue : ''))
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
        if (moved.el) (moved.el.closest('.thumb-wrap') || moved.el).remove() // Foto hängt jetzt in der neuen Zeile
        bindRow(row)
        updatePhotoCell(moved.az)
        document.dispatchEvent(new Event('reports:updated'))
      })
      .catch(function () { location.reload() }) // Zeile nicht ladbar – Reload als Fallback
  }

  function updatePhotoCell(az) {
    var row = document.querySelector('[data-drop-az="' + az + '"]')
    if (row) row.querySelector('.cell-photos').classList.toggle('cell-empty', !row.querySelector('[data-full-src]'))
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
      // Teil einer Mehrfachauswahl (photo-picks.js): alle ausgewählten mitnehmen.
      if (window.photoPicks && window.photoPicks.handles(moved.imageId)) return window.photoPicks.moveTo({ targetAz: az })
      moveDragged(moved, { targetAz: az }).catch(function (error) { alert(error.message) })
    })
  }

  // Events einer (neu eingefügten) Zeile verdrahten; für die initiale Seite
  // übernimmt das der Block ganz unten.
  function bindRow(row) {
    row.querySelectorAll('[data-drag-image]').forEach(bindDragImage)
    if (row.hasAttribute('data-drop-az')) bindDropTarget(row)
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
      if (window.photoPicks && window.photoPicks.handles(moved.imageId)) return window.photoPicks.moveTo({ newDraft: true })
      moveDragged(moved, { newDraft: true }).catch(function (error) { alert(error.message) })
    })
  }

  // Auch die Touch-Bedienung verwendet denselben Ablauf wie Drag & Drop.
  window.reportTableMove = moveDragged
  window.reportTableRefresh = async function (az) {
    var old = document.querySelector('[data-drop-az="' + az + '"]')
    if (!old) return
    var drop = document.getElementById('drop-new-draft')
    var queue = drop && drop.getAttribute('data-queue')
    var response = await fetch('/anzeige/' + az + '/listenzeile' + (queue ? '?queue=' + queue : ''))
    if (response.status === 404) {
      // Entwurf wurde gelöscht (z.B. im Editor-Modal verworfen).
      old.remove()
      document.dispatchEvent(new Event('reports:updated'))
      return
    }
    if (!response.ok || response.redirected) throw new Error('Liste konnte nicht aktualisiert werden.')
    var tbody = document.createElement('tbody')
    tbody.innerHTML = await response.text()
    var row = tbody.querySelector('tr')
    if (!row) throw new Error('Liste konnte nicht aktualisiert werden.')
    // Auswahl-Häkchen über die Aktualisierung retten.
    var wasChecked = old.querySelector('.bulk-select:checked')
    old.replaceWith(row)
    if (wasChecked && row.querySelector('.bulk-select')) row.querySelector('.bulk-select').checked = true
    bindRow(row)
    document.dispatchEvent(new Event('reports:updated'))
  }
})()
