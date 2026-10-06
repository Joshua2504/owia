// Gemeinsame Listenbedienung für Dashboard und Import; keine externen Assets.
;(function () {
  var table = document.querySelector('.report-table')
  if (!table) return
  var bulkForm = document.getElementById('bulk-discard-form')
  var selectAll = document.getElementById('bulk-select-all')
  var search = document.getElementById('report-search')
  var status = document.getElementById('report-status')
  var dialog = document.createElement('dialog')
  dialog.className = 'report-dialog'
  dialog.innerHTML = '<div class="d-flex justify-content-between align-items-center gap-2 mb-3"><h2 id="report-dialog-title" class="h5 mb-0"></h2><button type="button" class="btn btn-outline-secondary" data-close>Schließen</button></div><div data-content></div><p data-message class="mt-3 mb-0" role="status" aria-live="polite"></p>'
  dialog.setAttribute('aria-labelledby', 'report-dialog-title')
  document.body.appendChild(dialog)
  var content = dialog.querySelector('[data-content]')
  var message = dialog.querySelector('[data-message]')
  var busy = false
  dialog.querySelector('[data-close]').addEventListener('click', function () { if (!busy) dialog.close() })
  dialog.addEventListener('cancel', function (event) { if (busy) event.preventDefault() })
  function open(title) {
    dialog.querySelector('h2').textContent = title
    content.replaceChildren()
    message.textContent = ''
    dialog.showModal()
  }
  function working(value) {
    busy = value
    dialog.querySelectorAll('button, input, select').forEach(function (el) { el.disabled = value })
    dialog.setAttribute('aria-busy', String(value))
  }
  async function request(url, body) {
    var response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    if (response.redirected) throw new Error('Bitte erneut anmelden und die Seite neu laden.')
    var data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Anfrage fehlgeschlagen.')
    return data
  }
  function boxes() { return Array.from(table.querySelectorAll('.bulk-select')) }
  function selected() { return boxes().filter(function (box) { return box.checked }) }
  function update() {
    var rows = Array.from(table.querySelectorAll('tbody > tr[data-status]'))
    var term = search.value.trim().toLocaleLowerCase('de')
    rows.forEach(function (row) {
      var matches = (!status.value || row.dataset.status === status.value) && (!term || row.textContent.toLocaleLowerCase('de').includes(term))
      row.hidden = !matches
      if (!matches) { var box = row.querySelector('.bulk-select'); if (box) box.checked = false }
    })
    var visible = boxes().filter(function (box) { return !box.closest('tr').hidden })
    var count = selected().length
    boxes().forEach(function (box) { box.closest('tr').classList.toggle('is-selected', box.checked) })
    document.getElementById('report-visible-count').textContent = rows.filter(function (row) { return !row.hidden }).length + ' Anzeigen sichtbar'
    if (!bulkForm) return
    bulkForm.classList.toggle('d-none', count === 0)
    bulkForm.classList.toggle('d-flex', count > 0)
    document.body.classList.toggle('has-bulk-selection', count > 0)
    document.getElementById('bulk-count').textContent = count + ' Entwürfe ausgewählt'
    selectAll.checked = visible.length > 0 && visible.every(function (box) { return box.checked })
    selectAll.indeterminate = count > 0 && !selectAll.checked
    document.body.style.paddingBottom = count ? (bulkForm.offsetHeight + 24) + 'px' : ''
  }
  window.addEventListener('resize', update)
  search.addEventListener('input', update)
  status.addEventListener('change', update)
  document.addEventListener('reports:updated', update)
  document.addEventListener('change', function (event) {
    if (event.target === selectAll) {
      boxes().forEach(function (box) { if (!box.closest('tr').hidden) box.checked = selectAll.checked })
      update()
    } else if (event.target.matches('.bulk-select')) update()
  })
  if (bulkForm) {
    document.getElementById('bulk-clear').addEventListener('click', function () { boxes().forEach(function (box) { box.checked = false }); update() })
    document.getElementById('bulk-edit').addEventListener('click', async function () {
      var az = selected().map(function (box) { return box.value })
      open('Gemeinsam bearbeiten (' + az.length + ')')
      if (az.length > 50) { message.textContent = 'Bitte höchstens 50 Entwürfe gleichzeitig bearbeiten.'; return }
      working(true)
      try {
        var options = await request('/anzeigen/bearbeitungsoptionen')
        content.innerHTML = '<form data-edit><label class="form-label d-block">Verstoßart<select name="offenseMode" class="form-select"><option value="keep">Unverändert lassen</option><option value="set">Setzen</option><option value="clear">Leeren</option></select></label><label class="form-label d-block" data-offense-search-label hidden>Verstoß suchen<input type="search" name="offenseSearch" class="form-control" placeholder="z. B. Gehweg oder Tatbestandsnummer"></label><label class="form-label d-block" data-offense-label hidden>Verstoß auswählen<select name="offense" class="form-select"></select></label><label class="report-select-label d-flex gap-2 mb-3"><input name="overwrite" type="checkbox" class="form-check-input"> Vorhandene Verstoßarten überschreiben oder leeren</label><p class="small text-muted">Ohne diese Auswahl werden nur leere Verstoßarten ergänzt. „Fahrzeug verlassen“ setzt die gewählte Angabe für alle ausgewählten Entwürfe.</p><label class="form-label d-block">Fahrzeug verlassen<select name="leftMode" class="form-select"><option value="keep">Unverändert lassen</option><option value="yes">Ja</option><option value="no">Nein</option></select></label><button class="btn btn-primary mt-2" type="submit">Änderungen prüfen</button></form><div data-preview class="mt-3"></div>'
        var form = content.querySelector('form')
        function filterOffenses() {
          var term = form.elements.offenseSearch.value.trim().toLocaleLowerCase('de')
          var matches = options.offenses.filter(function (offense) { return offense.toLocaleLowerCase('de').includes(term) })
          form.elements.offense.replaceChildren(new Option(matches.length > 100 ? 'Bitte Suche eingrenzen (erste 100 Treffer) …' : 'Bitte Verstoß auswählen …', ''))
          matches.slice(0, 100).forEach(function (offense) { form.elements.offense.add(new Option(offense, offense)) })
        }
        filterOffenses()
        form.elements.offenseSearch.addEventListener('input', filterOffenses)
        form.elements.offenseMode.addEventListener('change', function () {
          content.querySelector('[data-offense-label]').hidden = form.elements.offenseMode.value !== 'set'
          content.querySelector('[data-offense-search-label]').hidden = form.elements.offenseMode.value !== 'set'
        })
        form.addEventListener('input', function () { content.querySelector('[data-preview]').replaceChildren() })
        form.addEventListener('change', function () { content.querySelector('[data-preview]').replaceChildren() })
        form.addEventListener('submit', async function (event) {
          event.preventDefault()
          working(true)
          message.textContent = 'Vorschau wird erstellt …'
          var previewBox = content.querySelector('[data-preview]')
          previewBox.replaceChildren()
          try {
            var preview = await request('/anzeigen/sammelbearbeitung/vorschau', { az: az, offenseMode: form.elements.offenseMode.value, offense: form.elements.offense.value, overwrite: form.elements.overwrite.checked, leftMode: form.elements.leftMode.value })
            preview.items.forEach(function (item) {
              var card = document.createElement('div')
              card.className = 'border rounded p-2 mb-2'
              var title = document.createElement('strong')
              title.textContent = item.az + (item.plate ? ' · ' + item.plate : '')
              card.appendChild(title)
              var detail = document.createElement('p')
              detail.className = 'small mb-0'
              detail.textContent = item.reason || 'Verstoß: ' + (item.offense || 'leer') + ' → ' + (item.nextOffense || 'leer') + '\nFahrzeug verlassen: ' + (item.left === null ? 'leer' : item.left ? 'Ja' : 'Nein') + ' → ' + (item.nextLeft === null ? 'leer' : item.nextLeft ? 'Ja' : 'Nein')
              detail.style.whiteSpace = 'pre-wrap'
              card.appendChild(detail)
              previewBox.appendChild(card)
            })
            if (preview.count) {
              var apply = document.createElement('button')
              apply.type = 'button'
              apply.className = 'btn btn-primary'
              apply.textContent = preview.count + ' Entwürfe ändern'
              previewBox.appendChild(apply)
              apply.addEventListener('click', async function () {
                working(true)
                message.textContent = 'Speichert …'
                try {
                  var data = await request('/anzeigen/sammelbearbeitung/speichern', { token: preview.token })
                  previewBox.replaceChildren()
                  data.results.forEach(function (result) {
                    var line = document.createElement('p')
                    line.textContent = result.az + ': ' + result.message
                    previewBox.appendChild(line)
                    if (result.ok) { var box = boxes().find(function (b) { return b.value === result.az }); if (box) box.checked = false }
                  })
                  var refreshed = await Promise.allSettled(data.results.filter(function (r) { return r.ok }).map(function (r) { return window.reportTableRefresh(r.az) }))
                  var refreshFailed = refreshed.some(function (r) { return r.status === 'rejected' })

                  var reload = document.createElement('button')
                  reload.type = 'button'
                  reload.className = 'btn btn-primary'
                  reload.textContent = 'Aktualisierte Liste anzeigen'
                  reload.addEventListener('click', function () { location.reload() })
                  previewBox.appendChild(reload)
                  message.textContent = data.results.filter(function (r) { return r.ok }).length + ' Entwürfe gespeichert. Fehlgeschlagene bleiben ausgewählt.' + (refreshFailed ? ' Bitte die Liste neu laden, um alle Änderungen zu sehen.' : '')
                  update()
                } catch (error) { message.textContent = error.message }
                finally { working(false) }
              })
            }
            message.textContent = preview.count + ' Entwürfe werden geändert. Die Vorschau gilt zehn Minuten.'
          } catch (error) { message.textContent = error.message }
          finally { working(false) }
        })
      } catch (error) { message.textContent = error.message }
      finally { working(false) }
    })
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('.photo-move')
    if (!button) return
    var img = button.closest('.report-photo').querySelector('img')
    var sourceAz = img.dataset.dragAz
    open('Foto verschieben')
    content.innerHTML = '<label class="form-label d-block">Ziel suchen<input type="search" class="form-control" data-target-search placeholder="Kennzeichen, Aktenzeichen, Tatort"></label><label class="form-label d-block">Ziel-Entwurf<select class="form-select" data-target></select></label><button class="btn btn-primary" type="button" data-move>Foto verschieben</button>'
    var photoPreview = document.createElement('img')
    photoPreview.src = img.src
    photoPreview.alt = 'Ausgewähltes Beweisfoto'
    photoPreview.className = 'rounded border w-100 mb-2'
    photoPreview.style.cssText = 'max-height:180px;object-fit:contain'
    var sourceLabel = document.createElement('p')
    sourceLabel.className = 'small text-muted'
    sourceLabel.textContent = 'Quelle: ' + sourceAz
    content.prepend(sourceLabel)
    content.prepend(photoPreview)
    var target = content.querySelector('[data-target]')
    var targetSearch = content.querySelector('[data-target-search]')
    function targets() {
      target.replaceChildren(new Option('Neue Anzeige erstellen', 'new'))
      table.querySelectorAll('tr[data-drop-az]').forEach(function (row) {
        if (row.dataset.dropAz === sourceAz) return
        var label = row.dataset.dropAz + ' · ' + row.querySelector('.cell-plate').textContent.trim() + ' · ' + row.querySelector('.cell-place').textContent.trim()
        if (label.toLocaleLowerCase('de').includes(targetSearch.value.toLocaleLowerCase('de'))) target.add(new Option(label, row.dataset.dropAz))
      })
    }
    targets()
    targetSearch.addEventListener('input', targets)
    content.querySelector('[data-move]').addEventListener('click', async function () {
      var destination = target.value
      working(true)
      message.textContent = 'Foto wird verschoben …'
      try {
        await window.reportTableMove({ az: sourceAz, imageId: img.dataset.dragImage, el: img }, destination === 'new' ? { newDraft: true } : { targetAz: destination })
        message.textContent = 'Foto verschoben.'
        content.replaceChildren()
      } catch (error) { message.textContent = error.message || 'Verschieben fehlgeschlagen.' }
      finally { working(false) }
    })
  })
  update()
})()
