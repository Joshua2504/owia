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
    if (!confirm(form.dataset.confirm)) e.preventDefault()
  })
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('button[data-confirm], a[data-confirm]')
    if (!el) return
    if (!confirm(el.dataset.confirm)) e.preventDefault()
  })
})()
