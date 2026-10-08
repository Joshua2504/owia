// Admin-Prüfung (/admin/anzeigen, src/views/admin/anzeigen.ejs): Sammel-
// Verwerfen nicht zugeordneter Amts-Antworten – Filter, Auswahl, Zähler und
// Rückfrage vor dem Absenden. Der Block existiert nur, wenn es solche
// Antworten gibt, daher die Guard am Anfang.
;(function () {
  'use strict'
  var form = document.getElementById('reply-bulk-form')
  if (!form) return

  var checks = function () { return Array.prototype.slice.call(document.querySelectorAll('.reply-check')) }
  var visible = function () { return checks().filter(function (c) { return !c.closest('tr').hidden }) }
  var update = function () {
    var n = checks().filter(function (c) { return c.checked }).length
    document.getElementById('reply-count').textContent = n
    document.getElementById('reply-bulk-btn').disabled = n === 0
  }
  // Rückfrage mit Anzahl – deshalb hier statt über data-confirm (layout.js).
  form.addEventListener('submit', function (e) {
    var n = checks().filter(function (c) { return c.checked }).length
    if (!n || !confirm(n + ' Antwort(en) endgültig verwerfen? Text und Anhänge werden gelöscht.')) e.preventDefault()
  })
  document.addEventListener('change', function (e) { if (e.target.classList.contains('reply-check')) update() })
  document.getElementById('reply-all').addEventListener('change', function (e) {
    visible().forEach(function (c) { c.checked = e.target.checked })
    update()
  })
  document.getElementById('reply-select-visible').addEventListener('click', function () {
    visible().forEach(function (c) { c.checked = true })
    update()
  })
  document.getElementById('reply-select-none').addEventListener('click', function () {
    checks().forEach(function (c) { c.checked = false })
    document.getElementById('reply-all').checked = false
    update()
  })
  // Filter nach Absender/Betreff (data-search der Zeile); ausgeblendete Zeilen
  // klappen ihre Detailzeile zu, damit nichts „verwaist" sichtbar bleibt.
  document.getElementById('reply-filter').addEventListener('input', function (e) {
    var q = e.target.value.trim().toLowerCase()
    document.querySelectorAll('.reply-row').forEach(function (tr) {
      tr.hidden = !!q && !tr.dataset.search.includes(q)
      if (tr.hidden) tr.nextElementSibling.classList.remove('show')
    })
  })
})()
