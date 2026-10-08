// Mehrere Fotos in der Anzeigen-Liste auswählen und gemeinsam verschieben.
// Auswahl: Häkchen auf der Miniatur (erscheint beim Hover) oder Strg-/Cmd-
// Klick aufs Foto. Verschieben: über die Leiste („In neue Anzeige" bzw. in
// einen Entwurf) oder per Drag & Drop eines ausgewählten Fotos – dann wandern
// alle ausgewählten mit (report-table.js fragt window.photoPicks.handles()).
//
// Die Fotos können aus verschiedenen Entwürfen stammen: Pro Quell-Entwurf ein
// POST /anzeige/:az/images/move; bei „neue Anzeige" legt der erste Aufruf sie
// an, die übrigen verschieben in diese. Danach wird die Liste neu geladen.
;(function () {
  if (!document.querySelector('.report-table')) return

  var bar = document.createElement('div')
  bar.className = 'photo-pick-bar'
  bar.hidden = true
  bar.setAttribute('role', 'region')
  bar.setAttribute('aria-label', 'Ausgewählte Fotos')
  bar.innerHTML =
    '<span class="fw-semibold" data-count></span>' +
    '<button type="button" class="btn btn-sm btn-primary" data-new>In neue Anzeige</button>' +
    '<select class="form-select form-select-sm w-auto" data-target aria-label="In Entwurf verschieben"></select>' +
    '<button type="button" class="btn btn-sm btn-outline-danger" data-delete>Löschen</button>' +
    '<button type="button" class="btn btn-sm btn-link" data-clear>Auswahl aufheben</button>'
  document.body.appendChild(bar)
  var target = bar.querySelector('[data-target]')

  function picks() {
    return Array.from(document.querySelectorAll('.thumb-pick:checked'))
  }

  function update() {
    var list = picks()
    document.querySelectorAll('.thumb-pick').forEach(function (cb) {
      cb.closest('.thumb-wrap').classList.toggle('is-picked', cb.checked)
    })
    document.body.classList.toggle('has-photo-picks', list.length > 0)
    bar.hidden = list.length === 0
    bar.querySelector('[data-count]').textContent = list.length === 1 ? '1 Foto ausgewählt' : list.length + ' Fotos ausgewählt'
    // Ziel-Entwürfe: alle Entwurfs-Zeilen der Liste.
    var keep = target.value
    target.replaceChildren(new Option('In Entwurf verschieben …', ''))
    document.querySelectorAll('tr[data-drop-az]').forEach(function (row) {
      var az = row.getAttribute('data-drop-az')
      var plate = row.querySelector('[data-inline-field="kennzeichen"]')
      var place = row.querySelector('[data-inline-field="tatort"]')
      var label = [az, plate && plate.value, place && place.value.slice(0, 40)].filter(Boolean).join(' · ')
      target.add(new Option(label, az))
    })
    target.value = keep
    if (window.searchableSelect) window.searchableSelect.sync(target)
  }

  async function moveTo(dest) {
    var list = picks()
    if (!list.length) return
    var groups = {}
    list.forEach(function (cb) {
      var az = cb.getAttribute('data-pick-az')
      ;(groups[az] = groups[az] || []).push(Number(cb.getAttribute('data-pick-id')))
    })
    bar.querySelectorAll('button, select').forEach(function (b) { b.disabled = true })
    var targetAz = dest.targetAz || null
    try {
      for (var az of Object.keys(groups)) {
        if (az === targetAz) continue // liegt schon dort
        var body = targetAz ? { imageIds: groups[az], targetAz: targetAz } : { imageIds: groups[az], newDraft: true }
        var res = await fetch('/anzeige/' + encodeURIComponent(az) + '/images/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        })
        var data = await res.json().catch(function () { return {} })
        if (!res.ok) throw new Error(data.error || 'Verschieben fehlgeschlagen.')
        targetAz = data.targetAz
      }
      location.reload()
    } catch (err) {
      OWIA.alert(err.message + ' Bereits verschobene Fotos bleiben verschoben; die Liste wird neu geladen.')
      location.reload()
    }
  }

  document.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('.thumb-pick')) update()
  })
  // Strg-/Cmd-Klick aufs Foto = auswählen (vor der Vorschau in image-preview.js,
  // daher in der Capture-Phase).
  document.addEventListener('click', function (e) {
    var img = e.target.closest && e.target.closest('.thumb-wrap .report-thumb')
    if (!img || !(e.ctrlKey || e.metaKey || e.shiftKey)) return
    var cb = img.parentNode.querySelector('.thumb-pick')
    if (!cb) return
    e.preventDefault()
    e.stopPropagation()
    cb.checked = !cb.checked
    update()
  }, true)
  // Ausgewählte Fotos löschen (DELETE je Foto), danach Liste neu laden.
  bar.querySelector('[data-delete]').addEventListener('click', async function () {
    var list = picks()
    if (!list.length) return
    if (!(await OWIA.ask((list.length === 1 ? 'Das ausgewählte Foto' : 'Die ' + list.length + ' ausgewählten Fotos') + ' endgültig löschen?', { danger: true, ok: 'Löschen' }))) return
    bar.querySelectorAll('button, select').forEach(function (b) { b.disabled = true })
    var failed = 0
    for (var cb of list) {
      var res = await fetch('/anzeige/' + encodeURIComponent(cb.getAttribute('data-pick-az')) + '/images/' + cb.getAttribute('data-pick-id'), { method: 'DELETE' }).catch(function () { return null })
      if (!res || !res.ok) failed++
    }
    if (failed) OWIA.alert(failed + ' Foto(s) konnten nicht gelöscht werden.')
    location.reload()
  })
  bar.querySelector('[data-new]').addEventListener('click', function () { moveTo({ newDraft: true }) })
  bar.querySelector('[data-clear]').addEventListener('click', function () {
    picks().forEach(function (cb) { cb.checked = false })
    update()
  })
  target.addEventListener('change', function () {
    if (target.value) moveTo({ targetAz: target.value })
  })

  window.photoPicks = {
    // Gehört das gezogene Foto zur Auswahl? Dann verschiebt report-table.js
    // per moveTo() alle ausgewählten statt nur dieses eine.
    handles: function (imageId) {
      return picks().some(function (cb) { return cb.getAttribute('data-pick-id') === String(imageId) })
    },
    moveTo: moveTo,
  }
})()
