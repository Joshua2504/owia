// Seitenübergreifende Kleinigkeiten aus layout.ejs (am Ende des Body, vor
// Bootstrap eingebunden). Ausgelagert, damit die CSP ohne 'unsafe-inline'
// für Scripts auskommt – Inline-Scripts gibt es in den Views nicht mehr.
;(function () {
  'use strict'

  // Service Worker (public/sw.js, Route /sw.js): cacht nur statische
  // /public/-Assets und macht die App installierbar.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {})
  }

  // Installierte PWA: Start ist die Startseite (manifest start_url /), dort
  // geht es per Knopf weiter zur Erfassung. Ältere Installationen starten noch
  // mit /kamera bzw. /import – Browser übernehmen ein geändertes start_url
  // nicht zuverlässig (iOS nie). Deshalb nur beim allerersten Seitenaufruf der
  // App-Sitzung (ohne Query/Referrer) auf / umleiten; danach – und über den
  // App-Shortcut (/kamera?von=app) – bleiben beide normal erreichbar.
  ;(function () {
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone
    if (!standalone || !document.body || !document.body.hasAttribute('data-user')) return
    try {
      if (sessionStorage.getItem('owia-app-start')) return
      sessionStorage.setItem('owia-app-start', '1')
    } catch (_) { return }
    var altStart = location.pathname === '/kamera' || location.pathname === '/import'
    if (altStart && !location.search && !document.referrer) location.replace('/')
  })()

  // Flash-Message: eigener Schließen-Handler, damit das X auch ohne geladenes
  // Bootstrap-JS funktioniert; Erfolgsmeldungen blenden sich selbst aus.
  ;(function () {
    var el = document.getElementById('flash-message')
    if (!el) return
    function dismiss() {
      el.classList.remove('show')
      setTimeout(function () { el.remove() }, 200)
    }
    var closeBtn = el.querySelector('.btn-close')
    if (closeBtn) closeBtn.addEventListener('click', dismiss)
    if (el.classList.contains('alert-success')) setTimeout(dismiss, 6000)
  })()

  // Cookie-Hinweis (rein informativ, s. layout.ejs): einmal bestätigt, merkt
  // sich localStorage – ist es gesperrt, erscheint der Hinweis einfach wieder.
  ;(function () {
    try {
      if (localStorage.getItem('cookieNoticeSeen')) return
    } catch (_) { /* localStorage gesperrt -> Hinweis einfach zeigen */ }
    var box = document.getElementById('cookie-notice')
    var ok = document.getElementById('cookie-notice-ok')
    if (!box || !ok) return
    box.classList.remove('d-none')
    ok.addEventListener('click', function () {
      try { localStorage.setItem('cookieNoticeSeen', '1') } catch (_) {}
      box.remove()
    })
  })()

  // Hell/Dunkel-Umschalter: Wahl in localStorage, Icon zeigt das Ziel-Theme.
  // Den Startwert setzt theme-init.js im <head>.
  ;(function () {
    var btn = document.getElementById('theme-toggle')
    if (!btn) return
    function icon() {
      btn.textContent = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? '☀️' : '🌙'
    }
    icon()
    btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-bs-theme', next)
      try { localStorage.setItem('theme', next) } catch (_) {}
      icon()
    })
  })()

  // Rückfrage vor riskanten Aktionen – Ersatz für onsubmit/onclick="return
  // confirm(...)" (Inline-Handler sind durch die CSP verboten):
  //   <form data-confirm="Wirklich?">            → beim Absenden
  //   <button data-confirm="…">, <a data-confirm> → beim Klick (preventDefault
  //   verhindert bei Submit-Buttons auch das Absenden des Formulars).
  // Zeilenumbrüche im Text als &#10; im Attribut. Delegiert am Dokument, damit
  // auch nachgeladene Zeilen/Dialoge (report-table.js) abgedeckt sind.
  document.addEventListener('submit', function (e) {
    var form = e.target
    if (!form || !form.matches || !form.matches('form[data-confirm]')) return
    if (form.dataset.confirmed) { delete form.dataset.confirmed; return }
    e.preventDefault()
    var submitter = e.submitter
    OWIA.ask(form.dataset.confirm, { danger: /lösch|verwerf|entwert|Konto schließen/i.test(form.dataset.confirm) }).then(function (ok) {
      if (!ok) return
      form.dataset.confirmed = '1'
      form.requestSubmit(submitter && submitter.form === form ? submitter : undefined)
    })
  })
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('button[data-confirm], a[data-confirm]')
    if (!el) return
    if (el.dataset.confirmed) { delete el.dataset.confirmed; return }
    e.preventDefault()
    OWIA.ask(el.dataset.confirm, { danger: /lösch|verwerf|entwert|Konto schließen/i.test(el.dataset.confirm) }).then(function (ok) {
      if (ok) { el.dataset.confirmed = '1'; el.click() }
    })
  })
  // Ladebalken beim Seitenwechsel: Ohne ihn wirkt ein Tipp auf dem Handy bei
  // langsamer Verbindung, als wäre nichts passiert. Erscheint erst nach kurzer
  // Verzögerung (schnelle Seiten blitzen nicht) und verschwindet spätestens
  // nach 10 s – Downloads (PDF, Export) verlassen die Seite ja nie.
  ;(function () {
    var bar = document.createElement('div')
    bar.className = 'nav-progress'
    bar.setAttribute('aria-hidden', 'true')
    document.body.appendChild(bar)
    var timer = null, stop = null
    function start() {
      clearTimeout(timer); clearTimeout(stop)
      timer = setTimeout(function () { bar.classList.add('is-on') }, 150)
      stop = setTimeout(done, 10000)
    }
    function done() {
      clearTimeout(timer); clearTimeout(stop)
      bar.classList.remove('is-on')
    }
    window.addEventListener('pageshow', done)
    document.addEventListener('visibilitychange', function () { if (document.hidden) done() })
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]')
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      if (a.target && a.target !== '_self') return
      if (a.hasAttribute('download') || a.hasAttribute('data-bs-toggle')) return
      var url = new URL(a.href, location.href)
      if (url.origin !== location.origin) return
      if (url.pathname === location.pathname && url.search === location.search) return // Anker/gleiche Seite
      if (/\/(pdf|export)(\b|$)|attachment|original=1|\.(pdf|zip|jpg|png)$/.test(url.pathname + url.search)) return
      // Erst nach den übrigen Klick-Handlern entscheiden (Modal, Rückfrage …).
      setTimeout(function () { if (!e.defaultPrevented) start() }, 0)
    })
    document.addEventListener('submit', function (e) {
      var f = e.target
      if (f.target && f.target !== '_self') return
      setTimeout(function () { if (!e.defaultPrevented) start() }, 0)
    })
  })()

  // Ziehen zum Aktualisieren – nur in der installierten App (PWA/native
  // Hülle), wo der Browser das nicht selbst anbietet. Ganz oben auf der Seite
  // nach unten ziehen; nicht in Dialogen, Sheets, Karten oder Eingabefeldern.
  ;(function () {
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone
    if (!standalone && !document.body.classList.contains('is-app')) return
    if (document.body.classList.contains('is-embed')) return
    var THRESHOLD = 70
    var ind = document.createElement('div')
    ind.className = 'ptr'
    ind.setAttribute('aria-hidden', 'true')
    ind.innerHTML = '<span class="ptr-icon">↻</span>'
    document.body.appendChild(ind)
    var startY = null, pull = 0
    document.addEventListener('touchstart', function (e) {
      startY = null
      if (window.scrollY > 0 || e.touches.length !== 1) return
      var t = e.target
      if (t.closest && t.closest('dialog, .offcanvas, .modal, .leaflet-container, input, textarea, select, [contenteditable], .photo-edit-dialog, [data-no-ptr]')) return
      if (document.querySelector('dialog[open], .offcanvas.show, .modal.show')) return
      startY = e.touches[0].clientY
      pull = 0
    }, { passive: true })
    document.addEventListener('touchmove', function (e) {
      if (startY === null) return
      var dy = e.touches[0].clientY - startY
      if (dy <= 0 || window.scrollY > 0) { pull = 0; ind.classList.remove('is-pulling', 'is-ready'); return }
      pull = Math.min(120, dy * 0.5)
      ind.classList.add('is-pulling')
      ind.classList.toggle('is-ready', pull >= THRESHOLD)
      ind.style.setProperty('--ptr', pull + 'px')
    }, { passive: true })
    document.addEventListener('touchend', function () {
      if (startY === null) return
      startY = null
      if (pull >= THRESHOLD) {
        ind.classList.add('is-loading')
        location.reload()
        return
      }
      ind.classList.remove('is-pulling', 'is-ready')
      ind.style.removeProperty('--ptr')
    })
  })()

  // „Mehr"-Sheet (layout.ejs #app-mehr): nach unten wischen schließt es –
  // wie ein natives Bottom-Sheet. Nur am Griff/Kopf oder wenn der Inhalt
  // ganz oben steht, sonst würde Scrollen im Sheet es schließen.
  ;(function () {
    var sheet = document.getElementById('app-mehr')
    if (!sheet) return
    var body = sheet.querySelector('.offcanvas-body')
    var startY = null, dy = 0
    sheet.addEventListener('touchstart', function (e) {
      var onHead = !body || !body.contains(e.target) || body.scrollTop <= 0
      startY = onHead && e.touches.length === 1 ? e.touches[0].clientY : null
      dy = 0
    }, { passive: true })
    sheet.addEventListener('touchmove', function (e) {
      if (startY === null) return
      dy = e.touches[0].clientY - startY
      if (dy <= 0) { sheet.style.transform = ''; return }
      sheet.style.transition = 'none'
      sheet.style.transform = 'translateY(' + dy + 'px)'
    }, { passive: true })
    sheet.addEventListener('touchend', function () {
      if (startY === null) return
      startY = null
      sheet.style.transition = ''
      if (dy > 90 && window.bootstrap) {
        // Aus der aktuellen Position weiter nach unten gleiten lassen; das
        // Inline-transform räumt erst „hidden" ab (sonst springt es zurück).
        sheet.style.transform = 'translateY(100%)'
        window.bootstrap.Offcanvas.getOrCreateInstance(sheet).hide()
      } else {
        sheet.style.transform = ''
      }
    })
    sheet.addEventListener('hidden.bs.offcanvas', function () { sheet.style.transform = '' })
  })()

  // Sticky-Header: Höhe als --owia-nav-h, damit andere sticky-Elemente
  // darunter ankleben. "Nach oben"-Button erscheint nach etwas Scrollen.
  ;(function () {
    var nav = document.getElementById('site-nav')
    if (nav) {
      var setH = function () { document.documentElement.style.setProperty('--owia-nav-h', nav.offsetHeight + 'px') }
      setH()
      window.addEventListener('resize', setH)
      nav.addEventListener('shown.bs.collapse', setH)
      nav.addEventListener('hidden.bs.collapse', setH)
    }
    // Handy-App-Modus: Seitentitel in der Leiste wie bei iOS erst einblenden,
    // wenn die große Überschrift der Seite unter der Leiste verschwunden ist –
    // vorher stünde derselbe Titel doppelt untereinander. Bis dahin zeigt die
    // Leiste den Produktnamen (app.css .title-off).
    var navTitle = document.querySelector('.site-page-title')
    if (nav && navTitle && 'IntersectionObserver' in window) {
      var heads = document.querySelectorAll('main h1, main h2')
      var head = null
      for (var i = 0; i < heads.length && !head; i++) {
        var r = heads[i].getBoundingClientRect()
        if (r.height && r.top < 360) head = heads[i]
      }
      if (head) {
        var brand = navTitle.closest('.site-brand')
        brand.classList.add('title-off')
        new IntersectionObserver(function (entries) {
          brand.classList.toggle('title-off', entries[0].isIntersecting)
        }, { rootMargin: '-' + nav.offsetHeight + 'px 0px 0px 0px' }).observe(head)
      }
    }
    // Tab-Leiste: Tippen auf den aktiven Tab (oder die obere Leiste außerhalb
    // der Knöpfe) scrollt nach oben – wie in nativen Apps.
    var toTop = function () {
      var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    }
    document.addEventListener('click', function (e) {
      var tab = e.target.closest && e.target.closest('.app-tab.active[href]')
      if (tab && tab.getAttribute('href') === location.pathname && !location.search && window.scrollY > 0) {
        e.preventDefault()
        toTop()
      }
    })
    if (nav) nav.addEventListener('click', function (e) {
      if (e.target === nav || e.target === nav.firstElementChild) toTop()
    })
    var btn = document.getElementById('back-to-top')
    if (!btn) return
    var update = function () { btn.hidden = window.scrollY < 400 }
    window.addEventListener('scroll', update, { passive: true })
    update()
    btn.addEventListener('click', toTop)
  })()
})()
