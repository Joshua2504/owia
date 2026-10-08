// Mini-Player für den laufenden Portal-Versand (Server: GET /api/versand/live
// in src/routes/portal.ts). Unten links auf jeder Seite, solange ein Versand
// läuft – Admins sehen jeden, Nutzer den ihrer eigenen Anzeige. Beim Hovern
// groß; nur Ansicht, Eingriffe auf /versand (Klick führt Admins dorthin).
;(function () {
  'use strict'
  var body = document.body
  if (!body || !body.hasAttribute('data-user') || body.classList.contains('is-embed')) return
  if (document.querySelector('[data-versand]')) return // /versand hat das große Bild

  var LABELS = {
    starting: 'startet …', filling: 'füllt das Formular aus …', needs_input: 'wartet auf Rückfrage',
    ready: 'bereit zum Absenden', submitting: 'sendet ab …', done: '✓ versendet', failed: 'Fehler', cancelled: 'abgebrochen',
  }
  var admin = body.hasAttribute('data-admin')
  var el = null
  var img = null
  var label = null
  var live = null
  var frameTimer = null
  var hideTimer = null

  function build() {
    el = document.createElement(admin ? 'a' : 'div')
    el.className = 'versand-mini'
    el.hidden = true
    el.innerHTML = '<div class="versand-mini-screen"><img alt="Live-Bild des Versands"></div>' +
      '<div class="versand-mini-bar"><span class="versand-mini-dot"></span><span class="versand-mini-label"></span></div>'
    img = el.querySelector('img')
    label = el.querySelector('.versand-mini-label')
    document.body.appendChild(el)
  }

  function frame() {
    clearTimeout(frameTimer)
    if (!live || document.hidden) return
    var id = live.id
    fetch('/api/versand/live/' + id + '/frame', { cache: 'no-store' })
      .then(function (r) { return r.status === 200 ? r.blob() : null })
      .then(function (b) {
        if (b && live && live.id === id) {
          var old = img.src
          img.src = URL.createObjectURL(b)
          if (old && old.indexOf('blob:') === 0) URL.revokeObjectURL(old)
          el.classList.add('has-frame')
        }
      })
      .catch(function () {})
      .then(function () { if (live) frameTimer = setTimeout(frame, 500) })
  }

  function poll() {
    if (document.hidden) return setTimeout(poll, 5000)
    fetch('/api/versand/live', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok && !r.redirected ? r.json() : { live: null } })
      .catch(function () { return { live: null } })
      .then(function (d) {
        var l = d.live
        if (l) {
          if (!el) build()
          clearTimeout(hideTimer)
          var neu = !live || live.id !== l.id
          live = l
          el.hidden = false
          el.dataset.state = l.state
          label.textContent = l.az + ' · ' + (LABELS[l.state] || l.state)
          el.title = 'Versand ' + l.az + (l.message ? ' – ' + l.message : '') + (admin ? ' (Klick: Live-Versand öffnen)' : '')
          if (admin) el.href = '/versand?az=' + encodeURIComponent(l.az)
          if (neu) { el.classList.remove('has-frame'); frame() }
        } else if (live) {
          // Lauf vorbei: kurz „versendet" stehen lassen, dann ausblenden.
          live = null
          clearTimeout(frameTimer)
          if (el.dataset.state === 'submitting' || el.dataset.state === 'ready') {
            el.dataset.state = 'done'
            label.textContent = label.textContent.replace(/ · .*$/, ' · ' + LABELS.done)
          }
          hideTimer = setTimeout(function () { el.hidden = true }, 6000)
        }
        setTimeout(poll, live ? 2000 : 8000)
      })
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && live) frame() })
  poll()
})()
