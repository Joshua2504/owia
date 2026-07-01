// Zeigt das verfügbare Guthaben (bezahlt + gratis) in der Navbar an. Läuft nur, wenn der
// Platzhalter #nav-balance existiert (also für angemeldete Nutzer).
;(function () {
  var el = document.getElementById('nav-balance')
  if (!el) return
  fetch('/api/konto/summary', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(function (d) {
      if (d && typeof d.formatted === 'string') el.textContent = d.formatted
    })
    .catch(function () {
      /* Navbar-Guthaben ist nur informativ */
    })
})()
