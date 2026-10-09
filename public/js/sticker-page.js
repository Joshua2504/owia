// Sticker-Seite (/sticker, src/views/sticker/index.ejs): Formular zum
// Erzeugen eines Sticker-Batches – Felder je nach Auswahl ein-/ausblenden,
// Vorschau der Textvorlage (/sticker/vorschau.svg) nachladen.
;(function () {
  'use strict'

  var form = document.getElementById('sticker-form')
  var vorlage = document.getElementById('vorlage')
  var felder = document.getElementById('eigen-felder')
  var entwurf = document.getElementById('entwurf')
  var tbnr = document.getElementById('tbnr')
  var aufdruckFeld = document.getElementById('aufdruck-feld')
  var aufdruck = document.getElementById('aufdruck')
  var vorschau = document.getElementById('sticker-vorschau')
  var klassisch = document.getElementById('sticker-vorschau-klassisch')
  var hinweis = document.getElementById('verstoss-hinweis')
  var fest = document.getElementById('verstoss-fest')
  if (!form) return

  function gewaehlt() {
    return entwurf && entwurf.selectedIndex >= 0 ? entwurf.options[entwurf.selectedIndex] : null
  }

  // Vorschau-URL aus den Formularfeldern, die das Etikett bestimmen.
  var timer = null
  function vorschauLaden() {
    if (!vorschau) return
    var opt = gewaehlt()
    var mitVorlage = !!(opt && opt.value)
    vorschau.classList.toggle('d-none', !mitVorlage)
    if (klassisch) klassisch.classList.toggle('d-none', mitVorlage)
    if (!mitVorlage) return
    clearTimeout(timer)
    timer = setTimeout(function () {
      var data = new FormData(form)
      var q = new URLSearchParams()
      ;['vorlage', 'entwurf', 'tbnr', 'cols', 'rows', 'labelW', 'labelH', 'marginLeft', 'marginTop', 'gapX', 'gapY'].forEach(function (k) {
        if (data.has(k)) q.set(k, data.get(k))
      })
      // Gesperrtes Verstoß-Feld fehlt in FormData – der Server nimmt dann
      // ohnehin den festen Tatbestand der Vorlage.
      vorschau.src = '/sticker/vorschau.svg?' + q.toString()
    }, 250)
  }
  if (vorschau) {
    vorschau.addEventListener('error', function () {
      // z. B. Etikett zu klein für Textvorlagen: Vorschau ausblenden statt Bild-Platzhalter.
      vorschau.classList.add('d-none')
    })
    vorschau.addEventListener('load', function () {
      var opt = gewaehlt()
      if (opt && opt.value) vorschau.classList.remove('d-none')
    })
  }

  // Textvorlage: fester Tatbestand sperrt den Verstoß, ein Betrag macht ihn
  // zur Pflicht; der Aufdruck gilt nur für den klassischen Text.
  function vorlageAnwenden() {
    var opt = gewaehlt()
    var slug = opt ? opt.value : ''
    var festTbnr = opt ? opt.getAttribute('data-fest') : ''
    var betrag = opt ? opt.getAttribute('data-betrag') === '1' : false
    if (tbnr) {
      if (festTbnr) tbnr.value = festTbnr
      tbnr.disabled = !!festTbnr
      tbnr.required = !!slug && betrag
      if (slug && betrag && !tbnr.value) tbnr.value = '112454' // Parken auf dem Gehweg, am häufigsten
    }
    if (hinweis) hinweis.classList.toggle('d-none', !!festTbnr)
    if (fest) fest.classList.toggle('d-none', !festTbnr)
    if (aufdruckFeld) aufdruckFeld.classList.toggle('d-none', !!slug || !(tbnr && tbnr.value))
    vorschauLaden()
  }

  if (vorlage && felder) {
    vorlage.addEventListener('change', function () {
      felder.classList.toggle('d-none', vorlage.value !== 'eigen')
      vorschauLaden()
    })
  }
  if (felder) felder.addEventListener('input', vorschauLaden)
  if (entwurf) entwurf.addEventListener('change', vorlageAnwenden)

  // Verstoß gewählt: beim klassischen Text das Aufdruck-Feld zeigen und mit
  // dem Katalogtext (data-text der Option) vorbelegen.
  if (tbnr) {
    tbnr.addEventListener('change', function () {
      var opt = tbnr.options[tbnr.selectedIndex]
      var slug = entwurf ? entwurf.value : ''
      if (aufdruckFeld) aufdruckFeld.classList.toggle('d-none', !!slug || !tbnr.value)
      if (aufdruck && !slug) aufdruck.value = tbnr.value ? opt.getAttribute('data-text') : ''
      vorschauLaden()
    })
  }

  // Gesperrte Felder werden nicht mitgeschickt – kurz vor dem Absenden
  // freigeben (der Server setzt den festen Tatbestand ohnehin selbst).
  form.addEventListener('submit', function () { if (tbnr) tbnr.disabled = false })

  vorlageAnwenden()
})()
