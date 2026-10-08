// Live-Versand (/versand, src/views/admin/versand.ejs): startet Portal-Läufe
// nacheinander in einem Fenster (Portal-Dienst: immer nur 1 Lauf), zeigt das
// Browserbild (Einzelbilder per Polling – robust hinter jedem Proxy) und reicht
// Klicks, Scrollen und Tastatur durch. Server: src/routes/portal.ts.
;(function () {
  'use strict'
  var root = document.querySelector('[data-versand]')
  if (!root) return

  var optAuto = root.querySelector('[data-opt=auto]')
  var optNext = root.querySelector('[data-opt=next]')
  var ACTIVE = ['starting', 'filling', 'needs_input', 'ready', 'submitting']
  var LABELS = {
    starting: ['startet …', 'info'], filling: ['füllt aus …', 'info'], needs_input: ['braucht dich', 'warning'],
    ready: ['bereit zum Absenden', 'success'], submitting: ['sendet …', 'primary'], done: ['versendet', 'success'],
    failed: ['Fehler', 'danger'], cancelled: ['abgebrochen', 'secondary'],
  }
  var finished = {} // Anzeige-ID → in dieser Sitzung erledigt (nicht erneut automatisch starten)

  // Optionen merken (nur Komfort, darf fehlen).
  ;[[optAuto, 'versand-auto'], [optNext, 'versand-next']].forEach(function (p) {
    try { p[0].checked = localStorage.getItem(p[1]) === '1' } catch (e) { /* egal */ }
    p[0].addEventListener('change', function () {
      try { localStorage.setItem(p[1], p[0].checked ? '1' : '0') } catch (e) { /* egal */ }
    })
  })

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
  function items() { return Array.prototype.slice.call(root.querySelectorAll('.versand-item')) }
  function updateCount() {
    root.querySelector('[data-count]').textContent = root.querySelectorAll('.versand-item:not(.is-done)').length
  }

  // ---- Ein Fenster = ein Lauf ------------------------------------------------
  function Slot(el, nr) {
    var self = this
    this.el = el
    this.nr = nr
    this.current = null // { id, az }
    this.state = null
    this.lastFrame = -1
    this.frameUrl = null
    this.statusTimer = null
    this.frameTimer = null
    var q = function (s) { return el.querySelector(s) }
    this.img = q('[data-frame]')
    this.empty = q('[data-frame-empty]')
    this.screen = q('[data-screen]')
    this.stateEl = q('[data-live-state]')
    this.stepEl = q('[data-live-step]')
    this.azEl = q('[data-live-az]')
    this.msgEl = q('[data-live-msg]')
    this.logEl = q('[data-log]')
    this.btnSubmit = q('[data-act=absenden]')
    this.btnResume = q('[data-act=fortsetzen]')
    this.btnCancel = q('[data-act=abbrechen]')
    q('[data-slot-nr]').textContent = 'Live'

    this.img.addEventListener('click', function (e) {
      var r = self.img.getBoundingClientRect()
      self.input({ type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
      self.screen.focus({ preventScroll: true })
    })
    var wheelAcc = 0
    var wheelTimer = null
    this.screen.addEventListener('wheel', function (e) {
      if (!self.current || self.img.hidden) return
      e.preventDefault()
      wheelAcc += e.deltaY
      if (wheelTimer) return
      wheelTimer = setTimeout(function () {
        var dy = wheelAcc
        wheelAcc = 0
        wheelTimer = null
        self.input({ type: 'wheel', dy: dy })
      }, 120)
    }, { passive: false })
    // Tastatur, solange das Live-Bild den Fokus hat.
    var SPECIAL = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']
    this.screen.addEventListener('keydown', function (e) {
      if (!self.current || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length === 1 && e.key !== ' ') {
        e.preventDefault()
        self.input({ type: 'type', text: e.key })
      } else if (SPECIAL.indexOf(e.key) >= 0) {
        e.preventDefault()
        self.input({ type: 'key', key: e.key === ' ' ? 'Space' : e.key })
      }
    })
    var typeField = q('[data-type-text]')
    var typeBtn = q('[data-act=type]')
    typeBtn.addEventListener('click', function () {
      if (!typeField.value) return
      self.input({ type: 'type', text: typeField.value }).then(function () { typeField.value = '' })
    })
    typeField.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); typeBtn.click() }
    })
    el.querySelectorAll('[data-key]').forEach(function (b) {
      b.addEventListener('click', function () { self.input({ type: 'key', key: b.getAttribute('data-key') }) })
    })
    this.btnSubmit.addEventListener('click', function () {
      if (!self.current) return
      self.btnSubmit.disabled = true
      post('/versand/' + self.current.id + '/absenden').then(function () { self.poll() })
        .catch(function (err) { self.showMsg(err.message, 'danger'); self.poll() })
    })
    this.btnResume.addEventListener('click', function () {
      if (!self.current) return
      post('/versand/' + self.current.id + '/fortsetzen').then(function () { self.poll() })
        .catch(function (err) { self.showMsg(err.message, 'danger') })
    })
    this.btnCancel.addEventListener('click', function () {
      if (!self.current) return
      var cur = self.current
      OWIA.ask('Vorgang ' + cur.az + ' abbrechen? Es wird nichts abgesendet.', { danger: true, ok: 'Vorgang abbrechen', cancel: 'Weiterlaufen lassen' }).then(function (ok) {
        if (!ok) return
        post('/versand/' + cur.id + '/abbrechen').then(function () { self.poll() })
          .catch(function (err) { self.showMsg(err.message, 'danger') })
      })
    })
  }

  Slot.prototype.busy = function () { return !!this.current && ACTIVE.indexOf(this.state) >= 0 }

  Slot.prototype.showMsg = function (text, kind) {
    this.msgEl.hidden = !text
    this.msgEl.textContent = text || ''
    this.msgEl.className = 'alert py-2 px-3 small mb-2 alert-' + (kind || 'info')
  }

  Slot.prototype.input = function (body) {
    var self = this
    if (!this.current) return Promise.resolve()
    return post('/versand/' + this.current.id + '/input', body).catch(function (err) { self.showMsg(err.message, 'danger') })
  }

  // Anzeige in diesem Fenster zeigen (laufend oder abgeschlossen).
  Slot.prototype.show = function (id) {
    var self = this
    var li = item(id)
    this.current = { id: String(id), az: li ? li.getAttribute('data-az') : String(id) }
    this.state = null
    this.lastFrame = -1
    this.logEl.textContent = ''
    this.azEl.textContent = this.current.az
    markActive()
    if (!this.statusTimer) this.statusTimer = setInterval(function () { self.poll() }, 1000)
    if (this.frameTimer) clearInterval(this.frameTimer)
    this.frameTimer = setInterval(function () { self.loadFrame() }, 300)
    this.poll()
  }

  Slot.prototype.start = function (id) {
    var self = this
    this.show(id)
    this.state = 'starting'
    this.showMsg('Portal wird gestartet …', 'info')
    post('/versand/' + id + '/start', { auto: optAuto.checked })
      .then(function () { self.poll() })
      .catch(function (err) {
        self.state = 'failed'
        self.showMsg(err.message, 'danger')
        finished[id] = true
        if (optNext.checked) setTimeout(function () { startNext(self) }, 1500)
      })
  }

  Slot.prototype.poll = function () {
    var self = this
    if (!this.current) return
    var id = this.current.id
    fetch('/versand/' + id + '/status', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { if (d && self.current && self.current.id === id) self.render(d) })
      .catch(function () { /* nächster Versuch */ })
  }

  Slot.prototype.render = function (d) {
    var run = d.run
    var rep = d.report || {}
    var st = run ? run.state : rep.status === 'versendet' ? 'done' : null
    // Ein frischer Start meldet kurz noch keinen Lauf – dann nicht zurücksetzen.
    if (!st && this.state === 'starting') return
    var lab = LABELS[st] || ['bereit', 'secondary']
    this.stateEl.textContent = lab[0]
    this.stateEl.className = 'badge text-bg-' + lab[1]
    this.stepEl.textContent = run && run.step && run.step.n ? 'Schritt ' + run.step.n + ': ' + run.step.title : ''
    this.btnSubmit.disabled = st !== 'ready'
    this.btnResume.hidden = st !== 'needs_input'
    this.btnCancel.disabled = ['starting', 'filling', 'needs_input', 'ready'].indexOf(st) < 0

    var vid = rep.vorgangsId || (run && run.result && run.result.vorgangsId)
    if (st === 'needs_input') this.showMsg('✋ ' + run.message, 'warning')
    else if (st === 'ready') {
      this.showMsg((run && run.pauses ? 'Es gab ' + run.pauses + ' Eingriff' + (run.pauses === 1 ? '' : 'e') + ' – bitte selbst prüfen. ' : '') +
        'Alles ausgefüllt. Zusammenfassung im Bild prüfen (scrollen) und „Jetzt absenden".', 'success')
    } else if (st === 'done') this.showMsg('✅ Versendet' + (vid ? ' – Vorgangs-ID ' + vid : '') + '.', 'success')
    else if (st === 'failed') this.showMsg((run && run.submitted ? '⚠ Fehler NACH dem Absenden – Ergebnis unklar, bitte prüfen: ' : 'Fehler: ') + ((run && (run.error || run.message)) || ''), 'danger')
    else if (st === 'cancelled') this.showMsg('Abgebrochen – nichts wurde abgesendet.', 'secondary')
    else if (st) this.showMsg((run && run.message) || '', 'info')

    if (run && run.log) {
      var logEl = this.logEl
      logEl.innerHTML = ''
      run.log.forEach(function (l) {
        var li = document.createElement('li')
        li.textContent = l.t.slice(11, 19) + '  ' + l.msg
        logEl.appendChild(li)
      })
    }
    if (st && st !== this.state) {
      // Nur ein hier beobachteter Lauf löst „nächste Anzeige" aus – nicht das
      // bloße Ansehen einer längst erledigten.
      var wasActive = ACTIVE.indexOf(this.state) >= 0
      this.state = st
      if (st === 'needs_input' || st === 'ready') this.screen.focus({ preventScroll: true })
      if (st === 'done' || st === 'failed' || st === 'cancelled') this.finish(st, wasActive)
    }
  }

  Slot.prototype.finish = function (st, wasActive) {
    var self = this
    var id = this.current.id
    finished[id] = true
    // Letztes Bild noch holen, dann das Bild-Polling einstellen.
    setTimeout(function () {
      if (self.current && self.current.id === id && self.frameTimer && ACTIVE.indexOf(self.state) < 0) {
        clearInterval(self.frameTimer)
        self.frameTimer = null
      }
    }, 3000)
    var li = item(id)
    if (st === 'done' && li) {
      li.classList.add('is-done')
      li.querySelectorAll('button').forEach(function (b) { b.disabled = true })
      updateCount()
    }
    if (wasActive && optNext.checked && (st === 'done' || st === 'failed')) setTimeout(function () { startNext(self) }, 1500)
  }

  Slot.prototype.loadFrame = function () {
    var self = this
    if (!this.current || document.hidden) return
    var id = this.current.id
    fetch('/versand/' + id + '/frame?n=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (r.status !== 200) return null
        var no = Number(r.headers.get('X-Frame-No') || 0)
        if (no === self.lastFrame) return null
        self.lastFrame = no
        return r.blob()
      })
      .then(function (b) {
        if (!b || !self.current || self.current.id !== id) return
        var url = URL.createObjectURL(b)
        self.img.onload = function () { if (self.frameUrl && self.frameUrl !== url) URL.revokeObjectURL(self.frameUrl); self.frameUrl = url }
        self.img.src = url
        self.img.hidden = false
        self.empty.hidden = true
      })
      .catch(function () { /* nächstes Bild */ })
  }

  var slots = Array.prototype.slice.call(root.querySelectorAll('[data-slot]')).map(function (el, i) { return new Slot(el, i + 1) })

  function markActive() {
    var shown = slots.map(function (s) { return s.current && s.current.id })
    items().forEach(function (li) { li.classList.toggle('active-run', shown.indexOf(li.getAttribute('data-id')) >= 0) })
  }
  function slotOf(id) { return slots.filter(function (s) { return s.current && s.current.id === String(id) })[0] }
  function freeSlot() { return slots.filter(function (s) { return !s.busy() })[0] }

  function startItem(id) {
    var s = slotOf(id)
    if (s && s.busy()) return s
    s = s || freeSlot()
    if (!s) { OWIA.alert('Es läuft bereits eine Anzeige – bitte warten, bis sie fertig ist.'); return null }
    s.start(id)
    return s
  }

  function nextItem() {
    return items().filter(function (li) {
      var id = li.getAttribute('data-id')
      return li.getAttribute('data-sendbar') && !finished[id] && !slotOf(id) && !li.classList.contains('is-done') &&
        !li.getAttribute('data-unklar') && !li.getAttribute('data-busy')
    })[0]
  }
  function startNext(slot) {
    if (slot.busy()) return
    var li = nextItem()
    if (li) slot.start(li.getAttribute('data-id'))
  }

  var testBtn = document.querySelector('[data-act=selbsttest]')
  if (testBtn) testBtn.addEventListener('click', function () {
    testBtn.disabled = true
    post('/versand/selbsttest').then(function () {
      testBtn.textContent = 'Selbsttest läuft (ca. 30 s) …'
      setTimeout(function () { location.reload() }, 45000)
    }).catch(function (err) { OWIA.alert(err.message); testBtn.disabled = false })
  })

  root.querySelector('[data-act=alle]').addEventListener('click', function () {
    optNext.checked = true
    optNext.dispatchEvent(new Event('change'))
    slots.forEach(function (s, i) { setTimeout(function () { startNext(s) }, i * 2500) })
  })

  root.querySelector('[data-list]').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]')
    var li = e.target.closest('.versand-item')
    if (!li) return
    var id = li.getAttribute('data-id')
    if (!b) {
      // Klick auf die Karte: Vorgang in seinem (oder einem freien) Fenster ansehen.
      if (e.target.closest('a')) return
      var s = slotOf(id) || freeSlot() || slots[0]
      if (!s.busy() || (s.current && s.current.id === id)) s.show(id)
      return
    }
    var act = b.getAttribute('data-act')
    if (act === 'start') startItem(id)
    else if (act === 'klaeren-ja') {
      OWIA.prompt('Vorgangs-ID (falls bekannt, z. B. aus der Zusammenfassung):', '', { title: 'Beim Portal angekommen', ok: 'Speichern' }).then(function (vid) {
        if (vid === null) return
        post('/versand/' + id + '/klaeren', { ergebnis: 'gesendet', vorgangsId: vid }).then(function () { location.reload() }).catch(function (err) { OWIA.alert(err.message) })
      })
    } else if (act === 'klaeren-nein') {
      OWIA.ask('Ist die Anzeige sicher NICHT beim Portal angekommen? Sie kann dann erneut gesendet werden.', { danger: true, ok: 'Nicht angekommen' }).then(function (ok) {
        if (!ok) return
        post('/versand/' + id + '/klaeren', { ergebnis: 'nicht-gesendet' }).then(function () { location.reload() }).catch(function (err) { OWIA.alert(err.message) })
      })
    }
  })

  // Vom Server gestartete Läufe (Auto-Start nach der Freigabe, Warteschlange)
  // erkennen: alle 3 s nach dem laufenden Versand fragen (wie der Mini-Player)
  // und ihn ins freie bzw. nicht beschäftigte Fenster holen.
  function watchLive() {
    if (document.hidden) return setTimeout(watchLive, 3000)
    fetch('/api/versand/live', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
      .then(function (d) {
        var l = d && d.live
        if (l && !slotOf(l.id)) {
          var s = slots.filter(function (x) { return !x.busy() })[0]
          if (s) {
            s.show(l.id)
            if (!item(l.id)) s.azEl.textContent = s.current.az = l.az
          }
        }
        setTimeout(watchLive, 3000)
      })
  }
  watchLive()

  // Laufende Vorgänge (z. B. nach Neuladen) und die Vorauswahl (?az=…) zeigen.
  root.querySelectorAll('.versand-item[data-busy="1"]').forEach(function (li, i) {
    if (slots[i]) slots[i].show(li.getAttribute('data-id'))
  })
  var pre = root.getAttribute('data-selected-az')
  var preLi = pre && root.querySelector('.versand-item[data-az="' + pre + '"]')
  if (preLi) {
    preLi.scrollIntoView({ block: 'nearest' })
    if (!slotOf(preLi.getAttribute('data-id'))) {
      var fs = slots.filter(function (s) { return !s.current })[0]
      if (fs) fs.show(preLi.getAttribute('data-id'))
    }
  }
})()
