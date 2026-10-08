// Live-Versand (/versand, src/views/admin/versand.ejs): startet Portal-Läufe,
// zeigt das Browserbild des Portal-Dienstes (Einzelbilder per Polling – robust
// hinter jedem Proxy) und reicht Klicks, Scrollen und Tastatur durch.
// Server: src/routes/portal.ts.
;(function () {
  'use strict'
  var root = document.querySelector('[data-versand]')
  if (!root) return

  var img = root.querySelector('[data-frame]')
  var empty = root.querySelector('[data-frame-empty]')
  var screen = root.querySelector('[data-screen]')
  var stateEl = root.querySelector('[data-live-state]')
  var stepEl = root.querySelector('[data-live-step]')
  var azEl = root.querySelector('[data-live-az]')
  var msgEl = root.querySelector('[data-live-msg]')
  var logEl = root.querySelector('[data-log]')
  var btnSubmit = root.querySelector('[data-act=absenden]')
  var btnResume = root.querySelector('[data-act=fortsetzen]')
  var btnCancel = root.querySelector('[data-act=abbrechen]')
  var optAuto = root.querySelector('[data-opt=auto]')
  var optNext = root.querySelector('[data-opt=next]')

  var current = null // { id, az }
  var lastFrame = -1
  var frameUrl = null
  var lastState = null
  var statusTimer = null
  var frameTimer = null
  var finished = {} // id → true (nicht erneut automatisch starten)

  // Optionen merken (nur Komfort, darf fehlen).
  ;[[optAuto, 'versand-auto'], [optNext, 'versand-next']].forEach(function (p) {
    try { p[0].checked = localStorage.getItem(p[1]) === '1' } catch (e) { /* egal */ }
    p[0].addEventListener('change', function () {
      try { localStorage.setItem(p[1], p[0].checked ? '1' : '0') } catch (e) { /* egal */ }
    })
  })

  var LABELS = {
    starting: ['startet …', 'info'], filling: ['füllt aus …', 'info'], needs_input: ['braucht dich', 'warning'],
    ready: ['bereit zum Absenden', 'success'], submitting: ['sendet …', 'primary'], done: ['versendet', 'success'],
    failed: ['Fehler', 'danger'], cancelled: ['abgebrochen', 'secondary'],
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Fehler (HTTP ' + r.status + ')')
        return d
      })
    })
  }

  function item(id) { return root.querySelector('.versand-item[data-id="' + id + '"]') }

  function showMsg(text, kind) {
    msgEl.hidden = !text
    msgEl.textContent = text || ''
    msgEl.className = 'alert py-2 px-3 small mb-2 alert-' + (kind || 'info')
  }

  // ---- Starten -------------------------------------------------------------
  function start(id) {
    var li = item(id)
    if (!li) return
    if (current && lastState && ['starting', 'filling', 'needs_input', 'ready', 'submitting'].indexOf(lastState) >= 0) {
      alert('Es läuft bereits ein Vorgang (' + current.az + ').')
      return
    }
    select(id)
    showMsg('Portal wird gestartet …', 'info')
    post('/versand/' + id + '/start', { auto: optAuto.checked })
      .then(function () { poll() })
      .catch(function (err) { showMsg(err.message, 'danger') })
  }

  function select(id) {
    var li = item(id)
    current = { id: id, az: li ? li.getAttribute('data-az') : String(id) }
    root.querySelectorAll('.versand-item').forEach(function (x) { x.classList.toggle('active-run', x === li) })
    azEl.textContent = current.az
    lastFrame = -1
    lastState = null
    logEl.textContent = ''
    if (!statusTimer) statusTimer = setInterval(poll, 1000)
    if (frameTimer) clearInterval(frameTimer)
    frameTimer = null
    if (!frameTimer) frameTimer = setInterval(loadFrame, 300)
    poll()
  }

  // ---- Status --------------------------------------------------------------
  function poll() {
    if (!current) return
    var id = current.id
    fetch('/versand/' + id + '/status', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { if (d && current && current.id === id) render(d) })
      .catch(function () { /* nächster Versuch */ })
  }

  function render(d) {
    var run = d.run
    var rep = d.report || {}
    var st = run ? run.state : rep.status === 'versendet' ? 'done' : null
    var lab = LABELS[st] || ['bereit', 'secondary']
    stateEl.textContent = lab[0]
    stateEl.className = 'badge text-bg-' + lab[1]
    stepEl.textContent = run && run.step && run.step.n ? 'Schritt ' + run.step.n + ': ' + run.step.title : ''

    btnSubmit.disabled = st !== 'ready'
    btnResume.hidden = st !== 'needs_input'
    btnCancel.disabled = ['starting', 'filling', 'needs_input', 'ready'].indexOf(st) < 0

    if (st === 'needs_input') showMsg('✋ ' + run.message, 'warning')
    else if (st === 'ready') showMsg('Alles ausgefüllt. Bitte die Zusammenfassung im Bild prüfen (scrollen) und dann „Jetzt absenden".', 'success')
    else if (st === 'done') showMsg('✅ Versendet' + (rep.vorgangsId ? ' – Vorgangs-ID ' + rep.vorgangsId : (run && run.result && run.result.vorgangsId ? ' – Vorgangs-ID ' + run.result.vorgangsId : '')) + '.', 'success')
    else if (st === 'failed') showMsg((run && run.submitted ? '⚠ Fehler NACH dem Absenden – Ergebnis unklar, bitte im Postfach prüfen: ' : 'Fehler: ') + (run.error || run.message), 'danger')
    else if (st === 'cancelled') showMsg('Abgebrochen – nichts wurde abgesendet.', 'secondary')
    else if (st) showMsg(run.message || '', 'info')

    if (run && run.log) {
      logEl.innerHTML = ''
      run.log.forEach(function (l) {
        var li = document.createElement('li')
        li.textContent = l.t.slice(11, 19) + '  ' + l.msg
        logEl.appendChild(li)
      })
    }
    if (st && st !== lastState) {
      // Nur ein hier beobachteter Lauf löst „nächste Anzeige" aus – nicht das
      // bloße Ansehen einer längst erledigten.
      var wasActive = ['starting', 'filling', 'needs_input', 'ready', 'submitting'].indexOf(lastState) >= 0
      lastState = st
      if (st === 'needs_input' || st === 'ready') screen.focus({ preventScroll: true })
      if (st === 'done' || st === 'failed' || st === 'cancelled') onFinished(st, wasActive)
    }
  }

  function onFinished(st, wasActive) {
    var id = current.id
    finished[id] = true
    // Letztes Bild noch holen, dann das Polling des Bildes einstellen.
    setTimeout(function () {
      if (current && current.id === id && frameTimer) {
        clearInterval(frameTimer)
        frameTimer = null
      }
    }, 3000)
    var li = item(id)
    if (st === 'done' && li) {
      li.classList.add('is-done')
      li.querySelectorAll('button').forEach(function (b) { b.disabled = true })
      updateCount()
    }
    if (st === 'done' && wasActive && optNext.checked) {
      var next = Array.prototype.slice.call(root.querySelectorAll('.versand-item')).find(function (x) {
        var nid = x.getAttribute('data-id')
        return !finished[nid] && !x.classList.contains('is-done') && !x.getAttribute('data-unklar') && !x.getAttribute('data-busy')
      })
      if (next) setTimeout(function () { start(next.getAttribute('data-id')) }, 1500)
    }
  }

  function updateCount() {
    var n = root.querySelectorAll('.versand-item:not(.is-done)').length
    root.querySelector('[data-count]').textContent = n
  }

  // ---- Live-Bild -------------------------------------------------------------
  function loadFrame() {
    if (!current || document.hidden) return
    var id = current.id
    fetch('/versand/' + id + '/frame?n=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (r.status !== 200) return null
        var no = Number(r.headers.get('X-Frame-No') || 0)
        if (no === lastFrame) return null
        lastFrame = no
        return r.blob()
      })
      .then(function (b) {
        if (!b || !current || current.id !== id) return
        var url = URL.createObjectURL(b)
        img.onload = function () { if (frameUrl && frameUrl !== url) URL.revokeObjectURL(frameUrl); frameUrl = url }
        img.src = url
        img.hidden = false
        empty.hidden = true
      })
      .catch(function () { /* nächstes Bild */ })
  }

  function input(body) {
    if (!current) return Promise.resolve()
    return post('/versand/' + current.id + '/input', body).catch(function (err) { showMsg(err.message, 'danger') })
  }

  img.addEventListener('click', function (e) {
    var r = img.getBoundingClientRect()
    input({ type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
    screen.focus({ preventScroll: true })
  })
  var wheelAcc = 0
  var wheelTimer = null
  screen.addEventListener('wheel', function (e) {
    if (!current || img.hidden) return
    e.preventDefault()
    wheelAcc += e.deltaY
    if (wheelTimer) return
    wheelTimer = setTimeout(function () {
      var dy = wheelAcc
      wheelAcc = 0
      wheelTimer = null
      input({ type: 'wheel', dy: dy })
    }, 120)
  }, { passive: false })
  // Tastatur, solange das Live-Bild den Fokus hat: Zeichen tippen, Sondertasten drücken.
  var SPECIAL = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']
  screen.addEventListener('keydown', function (e) {
    if (!current || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault()
      input({ type: 'type', text: e.key })
    } else if (SPECIAL.indexOf(e.key) >= 0) {
      e.preventDefault()
      input({ type: 'key', key: e.key === ' ' ? 'Space' : e.key })
    }
  })
  var typeField = root.querySelector('[data-type-text]')
  root.querySelector('[data-act=type]').addEventListener('click', function () {
    if (!typeField.value) return
    input({ type: 'type', text: typeField.value }).then(function () { typeField.value = '' })
  })
  typeField.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); root.querySelector('[data-act=type]').click() }
  })
  root.querySelectorAll('[data-key]').forEach(function (b) {
    b.addEventListener('click', function () { input({ type: 'key', key: b.getAttribute('data-key') }) })
  })

  // ---- Aktionen ------------------------------------------------------------
  btnSubmit.addEventListener('click', function () {
    if (!current) return
    btnSubmit.disabled = true
    post('/versand/' + current.id + '/absenden').then(poll).catch(function (err) { showMsg(err.message, 'danger'); poll() })
  })
  btnResume.addEventListener('click', function () {
    if (!current) return
    post('/versand/' + current.id + '/fortsetzen').then(poll).catch(function (err) { showMsg(err.message, 'danger') })
  })
  btnCancel.addEventListener('click', function () {
    if (!current || !confirm('Vorgang abbrechen? Es wird nichts abgesendet.')) return
    post('/versand/' + current.id + '/abbrechen').then(poll).catch(function (err) { showMsg(err.message, 'danger') })
  })

  root.querySelector('[data-list]').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]')
    var li = e.target.closest('.versand-item')
    if (!li) return
    var id = li.getAttribute('data-id')
    if (!b) {
      // Klick auf die Karte: laufenden/abgeschlossenen Vorgang ansehen.
      if (!e.target.closest('a')) select(id)
      return
    }
    var act = b.getAttribute('data-act')
    if (act === 'start') start(id)
    else if (act === 'mail') {
      if (!confirm('Diese Anzeige klassisch per E-Mail (mit PDF) an das Ordnungsamt senden?')) return
      post('/versand/' + id + '/per-mail').then(function () {
        li.classList.add('is-done')
        li.querySelectorAll('button').forEach(function (x) { x.disabled = true })
        updateCount()
      }).catch(function (err) { alert(err.message) })
    } else if (act === 'klaeren-ja') {
      var vid = prompt('Vorgangs-ID (falls bekannt, z. B. aus der Bestätigungsmail):', '')
      if (vid === null) return
      post('/versand/' + id + '/klaeren', { ergebnis: 'gesendet', vorgangsId: vid }).then(function () { location.reload() }).catch(function (err) { alert(err.message) })
    } else if (act === 'klaeren-nein') {
      if (!confirm('Ist die Anzeige sicher NICHT beim Portal angekommen? Sie kann dann erneut gesendet werden.')) return
      post('/versand/' + id + '/klaeren', { ergebnis: 'nicht-gesendet' }).then(function () { location.reload() }).catch(function (err) { alert(err.message) })
    }
  })

  // Vorauswahl (?az=…): Anzeige markieren und – falls sie gerade läuft – zeigen.
  var pre = root.getAttribute('data-selected-az')
  var preLi = pre && root.querySelector('.versand-item[data-az="' + pre + '"]')
  if (preLi) {
    preLi.scrollIntoView({ block: 'nearest' })
    select(preLi.getAttribute('data-id'))
  } else {
    var running = root.querySelector('.versand-item[data-busy="1"]')
    if (running) select(running.getAttribute('data-id'))
  }
})()
