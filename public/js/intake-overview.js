// Foto-Import-Ergebnis (/import/:id, src/views/intake/overview.ejs): Fotos
// ohne GPS/Zeit manuell einem Entwurf zuordnen oder daraus einen neuen Entwurf
// anlegen. Die Batch-ID kommt als data-intake-batch vom Container (kein
// Inline-Script wegen CSP); ohne den Block (alles zugeordnet) passiert nichts.
;(function () {
  'use strict'
  var root = document.querySelector('[data-intake-batch]')
  if (!root) return
  var batchId = root.getAttribute('data-intake-batch')

  function assign(photoId, body) {
    OWIA.fetchJson('/import/' + batchId + '/photos/' + photoId + '/assign', { json: body, fallback: 'Zuordnung fehlgeschlagen.' })
      .then(function () { location.reload() })
      .catch(function (err) { OWIA.alert(err.status ? err.message : 'Zuordnung fehlgeschlagen.') })
  }
  root.querySelectorAll('[data-assign-btn]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-assign-btn')
      var sel = root.querySelector('[data-assign-select="' + id + '"]')
      if (!sel || !sel.value) { OWIA.alert('Bitte zuerst einen Entwurf wählen.'); return }
      assign(id, { az: sel.value })
    })
  })
  root.querySelectorAll('[data-newdraft-btn]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      assign(btn.getAttribute('data-newdraft-btn'), { newDraft: true })
    })
  })
})()
