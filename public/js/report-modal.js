// „Bearbeiten" in der Anzeigen-Liste öffnet den Editor in einem Modal statt
// auf einer neuen Seite. Der Editor selbst bleibt die normale Seite
// /anzeige/:az/bearbeiten – hier im <iframe> mit ?embed=1 (ohne Navigation,
// layout.ejs). Strg-/Cmd-/Mittelklick auf den Link öffnet wie gewohnt einen
// neuen Tab; im Modal gibt es dafür zusätzlich „In neuem Tab".
//
// Kommunikation mit dem Editor (report-form.js) per postMessage (same origin):
//   Editor → Liste  { type: 'owia:changed', az, structural }  Daten geändert;
//                   structural = Fotos verschoben/neue Anzeige → Liste neu laden
//                   { type: 'owia:close' }                   Speichern & schließen
//   Liste → Editor  { type: 'owia:flush' }  offene Änderungen sofort sichern;
//                   Antwort { type: 'owia:flushed', busy } (busy = Upload läuft)
;(function () {
  var dialog = null
  var frame = null
  var titleEl = null
  var tabLink = null
  var visited = {} // Aktenzeichen, deren Zeile beim Schließen aktualisiert wird
  var structural = false
  var closing = false

  function build() {
    dialog = document.createElement('dialog')
    dialog.className = 'editor-dialog'
    dialog.setAttribute('aria-labelledby', 'editor-dialog-title')
    dialog.innerHTML =
      '<div class="editor-dialog-head">' +
      '<h2 id="editor-dialog-title" class="h6 mb-0 text-truncate"></h2>' +
      '<div class="d-flex gap-2 flex-shrink-0">' +
      '<a class="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener" data-tab>In neuem Tab ↗</a>' +
      '<button type="button" class="btn btn-sm btn-secondary" data-close>Schließen ✕</button>' +
      '</div></div>' +
      '<div class="editor-dialog-body"><div class="editor-dialog-loading"><span class="spinner-border spinner-border-sm"></span> Editor wird geladen …</div>' +
      '<iframe title="Anzeige bearbeiten"></iframe></div>'
    document.body.appendChild(dialog)
    frame = dialog.querySelector('iframe')
    titleEl = dialog.querySelector('h2')
    tabLink = dialog.querySelector('[data-tab]')
    dialog.querySelector('[data-close]').addEventListener('click', requestClose)
    // Escape: erst den Editor sichern lassen, dann schließen.
    dialog.addEventListener('cancel', function (e) {
      e.preventDefault()
      requestClose()
    })
    tabLink.addEventListener('click', function () {
      // Der Tab übernimmt – Modal schließen, damit nicht zwei Editoren parallel
      // denselben Entwurf autosaven.
      flush().then(finish)
    })
    frame.addEventListener('load', onFrameLoad)
  }

  function editPath(pathname) {
    var m = /^\/anzeige\/([^/]+)\/bearbeiten$/.exec(pathname)
    return m ? decodeURIComponent(m[1]) : null
  }

  function onFrameLoad() {
    var loc
    try {
      loc = frame.contentWindow.location
    } catch (_) {
      return
    }
    if (loc.href === 'about:blank') return
    dialog.classList.add('is-loaded')
    var az = editPath(loc.pathname)
    if (!az) {
      // Editor hat die Seite verlassen (Import-Queue fertig, Detailseite …):
      // Modal schließen und die Liste vollständig neu laden.
      structural = true
      finish()
      return
    }
    visited[az] = true
    titleEl.textContent = 'Anzeige ' + az + ' bearbeiten'
    var url = new URL(loc.href)
    url.searchParams.delete('embed')
    tabLink.href = url.pathname + url.search
    try { frame.contentWindow.focus() } catch (_) {}
  }

  function open(href) {
    if (!dialog) build()
    visited = {}
    structural = false
    closing = false
    dialog.classList.remove('is-loaded')
    var url = new URL(href, location.href)
    url.searchParams.set('embed', '1')
    titleEl.textContent = 'Anzeige bearbeiten'
    tabLink.href = href
    frame.src = url.pathname + url.search
    dialog.showModal()
    document.documentElement.classList.add('has-editor-dialog')
  }

  // Editor um sofortiges Speichern bitten; höchstens kurz warten.
  var flushWaiter = null
  function flush() {
    return new Promise(function (resolve) {
      var win = frame && frame.contentWindow
      if (!win) return resolve({})
      var done = function (data) {
        flushWaiter = null
        resolve(data || {})
      }
      flushWaiter = done
      setTimeout(function () { if (flushWaiter === done) done({}) }, 2500)
      try {
        win.postMessage({ type: 'owia:flush' }, location.origin)
      } catch (_) {
        done({})
      }
    })
  }

  function requestClose() {
    if (closing) return
    closing = true
    flush().then(function (res) {
      if (res.busy && !res.bestaetigt) {
        return OWIA.ask('Fotos werden noch hochgeladen bzw. gespeichert. Trotzdem schließen?', { ok: 'Trotzdem schließen' }).then(function (ok) {
          closing = false
          if (ok) finish()
        })
      }
      finish()
    })
  }

  function finish() {
    if (!dialog.open) return
    dialog.close()
    frame.src = 'about:blank'
    document.documentElement.classList.remove('has-editor-dialog')
    closing = false
    if (structural) {
      location.reload()
      return
    }
    Object.keys(visited).forEach(function (az) {
      if (!window.reportTableRefresh) return
      window.reportTableRefresh(az).catch(function () { location.reload() })
    })
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || typeof e.data.type !== 'string') return
    if (!frame || e.source !== frame.contentWindow) return
    if (e.data.type === 'owia:flushed' && flushWaiter) flushWaiter(e.data)
    else if (e.data.type === 'owia:changed') {
      if (e.data.az) visited[e.data.az] = true
      if (e.data.structural) structural = true
    } else if (e.data.type === 'owia:close') finish()
  })

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-edit-modal]')
    if (!a || e.defaultPrevented) return
    // Neuer Tab / neues Fenster bleibt dem Browser überlassen.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (typeof HTMLDialogElement === 'undefined') return // sehr alte Browser: normale Seite
    e.preventDefault()
    // Bearbeiten = Prüf-Dialog (photo-edit.js) auf dem ersten ungeprüften,
    // sonst dem ersten Foto. Der alte Editor nur noch für Entwürfe ohne Fotos.
    var az = editPath(new URL(a.href, location.href).pathname)
    var row = az && document.querySelector('[data-az="' + az.replace(/[^\w-]/g, '') + '"]')
    var t = row && (row.querySelector('[data-photo-edit][data-geprueft="0"]') || row.querySelector('[data-photo-edit]'))
    if (t && window.photoEditor) return window.photoEditor.openThumb(t)
    open(a.getAttribute('href'))
  })
})()
