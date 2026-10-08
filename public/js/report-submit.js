// Einreichen-Vorschau (aus dem Prüf-Dialog photo-edit.js, dem Prüf-Modus und
// als Rückfall des „Prüfen"-Knopfs der Liste bei Entwürfen ohne Fotos):
// Modal mit Datenvorschau, Prüfhinweisen
// und dem frisch erzeugten PDF (POST /anzeige/:az/einreichen-vorschau). Erst
// „Jetzt einreichen" schickt POST /anzeige/:az/submit (JSON-Modus, dieselben
// serverseitigen Prüfungen). Danach wird die Zeile neu geladen.
//
// Auch der Foto-Dialog (photo-edit.js, Liste und Prüf-Modus) öffnet die
// Vorschau: window.submitPreview.open(az, { onSubmitted }) – onSubmitted
// ersetzt dann das Neuladen der Zeile (der Foto-Dialog macht weiter).
;(function () {
  var dlg = null
  var current = null
  var onSubmitted = null

  function build() {
    dlg = document.createElement('dialog')
    dlg.className = 'editor-dialog submit-dialog'
    dlg.setAttribute('aria-labelledby', 'submit-dialog-title')
    dlg.innerHTML =
      '<div class="editor-dialog-head">' +
      '<h2 id="submit-dialog-title" class="h6 mb-0">Anzeige einreichen</h2>' +
      '<button type="button" class="btn btn-sm btn-secondary" data-close>Schließen ✕</button>' +
      '</div>' +
      '<div class="submit-body">' +
      '<div class="submit-data"></div>' +
      '<div class="submit-pdf"></div>' +
      '</div>' +
      '<div class="submit-foot">' +
      '<span class="small text-muted me-auto" data-msg role="status"></span>' +
      '<button type="button" class="btn btn-outline-secondary" data-close>Abbrechen</button>' +
      '<button type="button" class="btn btn-success" data-go disabled>Jetzt einreichen</button>' +
      (document.body.hasAttribute('data-admin') ? '<button type="button" class="btn btn-primary" data-go data-sofort disabled title="Prüfung direkt bestätigen und ans Ordnungsamt senden">Einreichen &amp; versenden</button>' : '') +
      '</div>'
    document.body.appendChild(dlg)
    dlg.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', close) })
    dlg.addEventListener('close', function () { document.documentElement.classList.remove('has-editor-dialog') })
    dlg.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', submit) })
  }

  function close() {
    if (dlg.open) dlg.close()
  }

  function text(tag, cls, t) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (t != null) e.textContent = t
    return e
  }

  function render(d) {
    var box = dlg.querySelector('.submit-data')
    box.replaceChildren()
    if (d.problems.length) {
      var warn = text('div', 'alert alert-warning py-2 small')
      warn.appendChild(text('strong', '', 'Noch nicht einreichbar:'))
      var ul = text('ul', 'mb-0 ps-3')
      d.problems.forEach(function (p) {
        var li = text('li', '', p.message + ' ')
        if (p.link) {
          var a = text('a', '', 'Zu den Einstellungen →')
          a.href = p.link
          a.target = '_blank'
          li.appendChild(a)
        }
        ul.appendChild(li)
      })
      warn.appendChild(ul)
      box.appendChild(warn)
    } else if (d.verjaehrung) {
      box.appendChild(text('div', 'alert alert-info py-2 small', 'Achtung: Frist endet in ' + d.verjaehrung.restTage + ' Tag(en).'))
    }
    var f = d.fields
    var zeit = [f.tattag, f.tattag_bis ? '– ' + f.tattag_bis : null].filter(Boolean).join(' ') +
      (f.tatzeit_von ? ', ' + f.tatzeit_von + (f.tatzeit_bis && f.tatzeit_bis !== f.tatzeit_von ? ' – ' + f.tatzeit_bis : '') + ' Uhr' : '')
    var rows = [
      ['Empfänger', d.recipient.ordnungsamt + (d.recipient.email ? ' (' + d.recipient.email + ')' : '')],
      ['Kennzeichen', [f.kennzeichen, f.fahrzeug || f.fahrzeug_marke].filter(Boolean).join(' · ')],
      ['Tatzeit', zeit],
      ['Tatort', f.tatort],
      ['Verstoß', f.verstoss_art ? f.verstoss_art + (f.verstoss_variante ? ' (genauer: ' + f.verstoss_variante + ')' : '') : f.verstoss_art],
      ['Fahrzeug verlassen', f.fahrzeug_verlassen ? 'Ja' : 'Nein'],
      ['Behinderung', f.behinderung ? 'Ja' + (f.behinderung_text ? ': ' + f.behinderung_text : '') : 'Nein'],
      ['Beschreibung', f.beschreibung],
    ]
    var dl = text('dl', 'submit-fields')
    rows.forEach(function (r) {
      dl.appendChild(text('dt', '', r[0]))
      var dd = text('dd', r[1] ? '' : 'text-danger', r[1] || '— fehlt —')
      if (!r[1] && (r[0] === 'Beschreibung')) { dd.className = 'text-muted'; dd.textContent = '—' }
      dl.appendChild(dd)
    })
    box.appendChild(dl)
    if (d.images.length) {
      box.appendChild(text('div', 'small fw-semibold mb-1', 'Beweisfotos (' + d.images.length + ')'))
      var g = text('div', 'report-photos mb-2')
      d.images.forEach(function (im) {
        var img = document.createElement('img')
        img.className = 'report-thumb'
        img.src = im.thumb
        img.alt = 'Beweisfoto'
        img.setAttribute('data-full-src', im.full)
        g.appendChild(img)
      })
      box.appendChild(g)
    }
    var pdf = dlg.querySelector('.submit-pdf')
    pdf.replaceChildren()
    if (d.pdfUrl) {
      var frame = document.createElement('iframe')
      frame.title = 'PDF-Vorschau'
      frame.src = d.pdfUrl
      pdf.appendChild(frame)
    } else {
      pdf.appendChild(text('div', 'submit-nopdf', 'Für dieses Ordnungsamt gibt es kein PDF-Formular – die Anzeige geht als E-Mail mit Fotos raus.'))
    }
    dlg.querySelectorAll('[data-go]').forEach(function (b) { b.disabled = !d.canSubmit })
    dlg.querySelector('[data-msg]').textContent = d.canSubmit ? 'Nach dem Einreichen prüft ein Admin und versendet an das Ordnungsamt.' : ''
  }

  function open(az, opts) {
    if (!dlg) build()
    current = az
    onSubmitted = (opts && opts.onSubmitted) || null
    dlg.querySelector('h2').textContent = 'Anzeige ' + az + ' einreichen'
    dlg.querySelector('.submit-data').replaceChildren(text('div', 'text-muted', 'Vorschau und PDF werden erstellt …'))
    dlg.querySelector('.submit-pdf').replaceChildren()
    dlg.querySelectorAll('[data-go]').forEach(function (b) { b.disabled = true })
    dlg.querySelector('[data-msg]').textContent = ''
    dlg.querySelector('[data-msg]').className = 'small text-muted me-auto'
    dlg.showModal()
    document.documentElement.classList.add('has-editor-dialog')
    fetch('/anzeige/' + encodeURIComponent(az) + '/einreichen-vorschau', { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (current !== az) return
        if (!res.ok) throw new Error(res.d.error || 'Vorschau fehlgeschlagen.')
        render(res.d)
      })
      .catch(function (err) {
        dlg.querySelector('.submit-data').replaceChildren(text('div', 'alert alert-danger', err.message || 'Vorschau fehlgeschlagen.'))
      })
  }

  function submit(e) {
    var go = e.currentTarget
    var sofort = go.hasAttribute('data-sofort')
    var label = go.textContent
    var msg = dlg.querySelector('[data-msg]')
    if (sofort && !confirm('Anzeige ohne weitere Prüfung direkt ans Ordnungsamt versenden?')) return
    dlg.querySelectorAll('[data-go]').forEach(function (b) { b.disabled = true })
    go.textContent = sofort ? 'Wird versendet …' : 'Wird eingereicht …'
    var az = current
    fetch('/anzeige/' + encodeURIComponent(az) + '/submit' + (sofort ? '?sofort=1' : ''), { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (d) { return { ok: r.ok, d: d } }) })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Einreichen fehlgeschlagen.')
        close()
        if (onSubmitted) return onSubmitted(az, sofort)
        // Portal-Stadt (Frankfurt): Versand läuft live auf /versand.
        if (res.d.portal) { window.location.href = res.d.portal; return }
        if (window.reportTableRefresh) return window.reportTableRefresh(az)
      })
      .catch(function (err) {
        msg.textContent = err.message
        msg.className = 'small text-danger me-auto'
        if (window.reportTableRefresh) window.reportTableRefresh(az)
        if (!/^Eingereicht, aber/.test(err.message)) dlg.querySelectorAll('[data-go]').forEach(function (b) { b.disabled = false })
      })
      .finally(function () { go.textContent = label })
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-submit-preview]')
    if (!b) return
    var row = b.closest('tr[data-az]')
    if (row) open(row.dataset.az)
  })

  window.submitPreview = { open: open }
})()
