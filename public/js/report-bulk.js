// Gemeinsame Listenbedienung für Dashboard und Import; keine externen Assets.
;(function () {
  var table = document.querySelector('.report-table')
  if (!table) return
  var bulkForm = document.getElementById('bulk-discard-form')
  // Zwei „Alle auswählen"-Häkchen: im Tabellenkopf (Desktop) und in der
  // Filterleiste (Handy – dort gibt es keinen Tabellenkopf).
  var selectAlls = Array.from(document.querySelectorAll('#bulk-select-all, #bulk-select-all-m'))
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
  // Sortierung nach Tatzeit (Spaltenkopf „Tatzeit"): neueste zuerst ↔ älteste
  // zuerst, gemerkt pro Browser. Zeilen ohne Datum landen immer unten.
  // Schlüssel: data-sort-ts der Zeile (report-row.ejs).
  var SORT_KEY = 'owia.reportSort'
  var sortBtn = document.getElementById('sort-tatzeit')
  var sortDir = 'desc'
  try { if (localStorage.getItem(SORT_KEY) === 'asc') sortDir = 'asc' } catch (_) {}
  function applySort() {
    if (!sortBtn) return
    var tbody = table.tBodies[0]
    var rows = Array.from(tbody.querySelectorAll('tr[data-az]'))
    rows.sort(function (a, b) {
      var x = a.dataset.sortTs || ''
      var y = b.dataset.sortTs || ''
      if (!x || !y) return x ? -1 : y ? 1 : 0
      return sortDir === 'asc' ? x.localeCompare(y) : y.localeCompare(x)
    })
    rows.forEach(function (r) { tbody.appendChild(r) })
    sortBtn.querySelector('span').textContent = sortDir === 'asc' ? '▲' : '▼'
    sortBtn.title = sortDir === 'asc' ? 'Älteste zuerst – klicken für neueste zuerst' : 'Neueste zuerst – klicken für älteste zuerst'
    sortBtn.parentNode.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending')
  }
  if (sortBtn) {
    sortBtn.addEventListener('click', function () {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc'
      try { localStorage.setItem(SORT_KEY, sortDir) } catch (_) {}
      applySort()
    })
    applySort()
  }

  function boxes() { return Array.from(table.querySelectorAll('.bulk-select')) }
  function selected() { return boxes().filter(function (box) { return box.checked }) }
  function update() {
    var rows = Array.from(table.querySelectorAll('tbody > tr[data-status]'))
    var term = search.value.trim().toLocaleLowerCase('de')
    rows.forEach(function (row) {
      // Inline-Felder (Kennzeichen, Marke, Verstoß) stehen nicht im textContent.
      var text = row.textContent + ' ' + Array.from(row.querySelectorAll('input[data-inline-field], textarea[data-inline-field]')).map(function (el) { return el.value }).join(' ')
      var matches = (!status.value || row.dataset.status === status.value) && (!term || text.toLocaleLowerCase('de').includes(term))
      row.hidden = !matches
      if (!matches) { var box = row.querySelector('.bulk-select'); if (box) box.checked = false }
    })
    var visible = boxes().filter(function (box) { return !box.closest('tr').hidden })
    var count = selected().length
    boxes().forEach(function (box) { box.closest('tr').classList.toggle('is-selected', box.checked) })
    var shown = rows.filter(function (row) { return !row.hidden }).length
    document.getElementById('report-visible-count').textContent = shown === rows.length ? rows.length + ' Anzeigen' : shown + ' von ' + rows.length + ' Anzeigen'
    if (!bulkForm) return
    bulkForm.classList.toggle('d-none', count === 0)
    bulkForm.classList.toggle('d-flex', count > 0)
    document.body.classList.toggle('has-bulk-selection', count > 0)
    document.getElementById('bulk-count').textContent = count === 1 ? '1 Entwurf ausgewählt' : count + ' Entwürfe ausgewählt'
    var all = visible.length > 0 && visible.every(function (box) { return box.checked })
    selectAlls.forEach(function (el) {
      el.checked = all
      el.indeterminate = count > 0 && !all
    })
    document.body.style.paddingBottom = count ? (bulkForm.offsetHeight + 24) + 'px' : ''
  }
  window.addEventListener('resize', update)
  search.addEventListener('input', update)
  // Status-Filter pro Browser merken (reine Ansichts-Vorliebe → localStorage;
  // gesperrter Speicher, z.B. privates Fenster, wird still ignoriert).
  var STATUS_KEY = 'owia.reportStatusFilter'
  try {
    var savedStatus = localStorage.getItem(STATUS_KEY)
    if (savedStatus && Array.from(status.options).some(function (o) { return o.value === savedStatus })) {
      status.value = savedStatus
      if (window.searchableSelect) window.searchableSelect.sync(status)
    }
  } catch (_) {}
  status.addEventListener('change', function () {
    try { localStorage.setItem(STATUS_KEY, status.value) } catch (_) {}
    update()
  })
  document.addEventListener('reports:updated', update)
  document.addEventListener('change', function (event) {
    if (selectAlls.indexOf(event.target) !== -1) {
      boxes().forEach(function (box) { if (!box.closest('tr').hidden) box.checked = event.target.checked })
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
        content.innerHTML = '<form data-edit><label class="form-label d-block">Verstoßart<select name="offenseMode" class="form-select"><option value="keep">Unverändert lassen</option><option value="set">Setzen</option><option value="clear">Leeren</option></select></label><label class="form-label d-block" data-offense-label hidden>Verstoß auswählen<select name="offense" class="form-select"></select></label><label class="report-select-label d-flex gap-2 mb-3"><input name="overwrite" type="checkbox" class="form-check-input"> Vorhandene Verstoßarten überschreiben oder leeren</label><p class="small text-muted">Ohne diese Auswahl werden nur leere Verstoßarten ergänzt. „Fahrzeug verlassen“ setzt die gewählte Angabe für alle ausgewählten Entwürfe.</p><label class="form-label d-block">Fahrzeug verlassen<select name="leftMode" class="form-select"><option value="keep">Unverändert lassen</option><option value="yes">Ja</option><option value="no">Nein</option></select></label><button class="btn btn-primary mt-2" type="submit">Änderungen prüfen</button></form><div data-preview class="mt-3"></div>'
        var form = content.querySelector('form')
        // Ganzer Katalog; durchsucht wird im Auswahlfeld selbst (searchable-select.js).
        form.elements.offense.replaceChildren(new Option('Verstoß suchen oder auswählen …', ''))
        options.offenses.forEach(function (offense) { form.elements.offense.add(new Option(offense, offense)) })
        form.elements.offenseMode.addEventListener('change', function () {
          content.querySelector('[data-offense-label]').hidden = form.elements.offenseMode.value !== 'set'
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
  // ---------------------------------------------------------------------------
  // Löschen im Modal statt über die Bestätigungsseite: Einzel-Löschen (🗑 in
  // der Zeile) und Sammel-Löschen. Der Server verlangt weiterhin confirmed=1
  // (ohne JS bleibt die Bestätigungsseite der Fallback).
  // ---------------------------------------------------------------------------
  function rowSummary(row) {
    var val = function (sel) { var el = row.querySelector(sel); return el ? (el.value || el.textContent || '').trim() : '' }
    var parts = [val('[data-inline-field="kennzeichen"]'), val('[data-inline-field="tatort"]')].filter(Boolean)
    var photos = row.querySelectorAll('.report-thumb').length
    if (photos) parts.push(photos === 1 ? '1 Foto' : photos + ' Fotos')
    return parts.join(' · ')
  }

  function confirmDelete(azList) {
    open(azList.length === 1 ? 'Entwurf löschen?' : azList.length + ' Entwürfe löschen?')
    var list = document.createElement('ul')
    list.className = 'small mb-3'
    azList.forEach(function (az) {
      var row = table.querySelector('tr[data-az="' + az + '"]')
      var li = document.createElement('li')
      var code = document.createElement('code')
      code.textContent = az
      li.appendChild(code)
      var info = row ? rowSummary(row) : ''
      if (info) li.appendChild(document.createTextNode(' – ' + info))
      list.appendChild(li)
    })
    var note = document.createElement('p')
    note.className = 'small text-muted'
    note.textContent = 'Fotos und Angaben werden endgültig gelöscht.'
    var actions = document.createElement('div')
    actions.className = 'd-flex gap-2 justify-content-end'
    var cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn btn-outline-secondary'
    cancel.textContent = 'Abbrechen'
    cancel.addEventListener('click', function () { dialog.close() })
    var go = document.createElement('button')
    go.type = 'button'
    go.className = 'btn btn-danger'
    go.textContent = azList.length === 1 ? 'Endgültig löschen' : azList.length + ' Entwürfe löschen'
    actions.appendChild(cancel)
    actions.appendChild(go)
    content.append(list, note, actions)
    go.focus()
    go.addEventListener('click', async function () {
      working(true)
      message.textContent = 'Wird gelöscht …'
      try {
        var single = azList.length === 1
        var body = new URLSearchParams({ confirmed: '1' })
        if (!single) azList.forEach(function (az) { body.append('az', az) })
        var res = await fetch(single ? '/anzeige/' + encodeURIComponent(azList[0]) + '/discard' : '/anzeigen/loeschen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          // Erfolg = Weiterleitung zur Liste; ihr nicht folgen (die Seite
          // bleibt, die Zeilen werden unten entfernt).
          redirect: 'manual',
        })
        if (!res.ok && res.type !== 'opaqueredirect') throw new Error()
        // Zeilen entfernen (Server hat nur Entwürfe gelöscht – Rest bleibt).
        await Promise.all(azList.map(function (az) {
          return window.reportTableRefresh ? window.reportTableRefresh(az).catch(function () {}) : null
        }))
        working(false)
        dialog.close()
        update()
      } catch (_) {
        working(false)
        message.textContent = 'Löschen fehlgeschlagen – bitte erneut versuchen.'
      }
    })
  }

  document.addEventListener('submit', function (e) {
    var form = e.target
    if (form === bulkForm) {
      e.preventDefault()
      var az = selected().map(function (box) { return box.value })
      if (az.length) confirmDelete(az)
      return
    }
    var m = /\/anzeige\/([^/]+)\/discard$/.exec(form.getAttribute('action') || '')
    if (!m || !table.contains(form)) return
    e.preventDefault()
    confirmDelete([decodeURIComponent(m[1])])
  })

  update()
})()
