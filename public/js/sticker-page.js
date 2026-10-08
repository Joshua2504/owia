// Sticker-Seite (/sticker, src/views/sticker/index.ejs): Formular zum
// Erzeugen eines Sticker-Batches – Felder je nach Auswahl ein-/ausblenden.
;(function () {
  'use strict'

  // „Eigenes Format": Maßfelder nur dann zeigen.
  var vorlage = document.getElementById('vorlage')
  var felder = document.getElementById('eigen-felder')
  if (vorlage && felder) {
    vorlage.addEventListener('change', function () { felder.classList.toggle('d-none', vorlage.value !== 'eigen') })
  }

  // Verstoß gewählt: Aufdruck-Feld zeigen und mit dem Katalogtext (data-text
  // der Option) vorbelegen.
  var tbnr = document.getElementById('tbnr')
  var feld = document.getElementById('aufdruck-feld')
  var text = document.getElementById('aufdruck')
  if (tbnr && feld && text) {
    tbnr.addEventListener('change', function () {
      var opt = tbnr.options[tbnr.selectedIndex]
      feld.classList.toggle('d-none', !tbnr.value)
      text.value = tbnr.value ? opt.getAttribute('data-text') : ''
    })
  }
})()
