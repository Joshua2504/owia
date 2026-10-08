// Gemeinsame Frontend-Helfer für alle Seiten-Skripte unter public/js/.
// Wird in layout.ejs synchron im <head> geladen – VOR allen Seiten-Skripten,
// auch vor solchen, die Views ohne defer mitten im Body einbinden (z.B.
// reports/edit.ejs → report-form.js). Kein ES-Modul (buildlos, CSP ohne
// 'unsafe-inline'): alles hängt an window.OWIA.
;(function () {
  'use strict'

  // HTML-Sonderzeichen für innerHTML/Attribute maskieren. null/undefined → ''
  // (Felder aus JSON-Antworten sind oft null). Maskiert auch ' und ", damit
  // Werte in Attributen mit beiden Anführungszeichen sicher sind.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  // Aufruf von fn erst, wenn ms lang kein neuer Aufruf kam (Autosave, Suche).
  // this/arguments werden durchgereicht.
  function debounce(fn, ms) {
    var t
    return function () {
      var self = this
      var args = arguments
      clearTimeout(t)
      t = setTimeout(function () { fn.apply(self, args) }, ms)
    }
  }

  // Gleiche Normalisierung wie normalizePlate() in src/routes/reports.ts:
  // Großschreibung (de-DE wegen ß/Umlauten), Leerraum zusammenfassen, trimmen,
  // max. 20 Zeichen. Beide Seiten beim Ändern nachziehen, sonst hält der
  // Client Werte für „geändert", die der Server identisch zurückgibt.
  function normalizePlate(v) {
    return String(v || '').toLocaleUpperCase('de-DE').replace(/\s+/g, ' ').trim().slice(0, 20)
  }

  // fetch für JSON-Endpunkte: Accept: application/json, Antwort als JSON;
  // HTTP-Fehler mit { error } werden zum Error mit dieser Meldung. Eine
  // Weiterleitung (abgelaufene Sitzung → Login-Seite) kann nie JSON sein und
  // wird als klarer Hinweis gemeldet statt als Parser-Fehler.
  // opts: wie bei fetch, zusätzlich
  //   fallback – Fehlertext, wenn der Server kein { error } liefert.
  function fetchJson(url, opts) {
    opts = opts || {}
    var fallback = opts.fallback || 'Anfrage fehlgeschlagen.'
    var init = {}
    for (var k in opts) if (k !== 'fallback' && k !== 'headers') init[k] = opts[k]
    init.headers = { Accept: 'application/json' }
    if (opts.headers) for (var h in opts.headers) init.headers[h] = opts.headers[h]
    return fetch(url, init).then(function (r) {
      if (r.redirected) throw new Error('Bitte neu anmelden.')
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error) || fallback)
        return d
      })
    })
  }

  // Verstoß-/Fahrzeug-Katalog (/anzeigen/bearbeitungsoptionen, ~55 KB) einmal
  // je Seite laden und als Promise teilen – report-inline.js, photo-edit.js und
  // report-bulk.js fragen ihn unabhängig voneinander an. Nach einem
  // Fehlschlag (z.B. während eines App-Neustarts) wird der Cache geleert,
  // damit der nächste Versuch erneut lädt.
  // Ergebnis: { alle, haeufig, gesperrt, standardStadt, fahrzeugTypen, marken,
  // farben } – alle/haeufig/gesperrt ist das Format, das verstoss-select.js erwartet.
  var catalog = null
  function loadCatalog() {
    if (!catalog) {
      catalog = fetchJson('/anzeigen/bearbeitungsoptionen')
        .then(function (d) {
          return {
            alle: d.offenses || [],
            haeufig: d.frequent || [],
            gesperrt: d.gesperrt || {},
            standardStadt: d.standardStadt,
            fahrzeugTypen: d.fahrzeugTypen,
            marken: d.marken,
            farben: d.farben,
          }
        })
        .catch(function () { catalog = null; throw new Error('Verstoß-Katalog nicht ladbar.') })
    }
    return catalog
  }

  window.OWIA = {
    escapeHtml: escapeHtml,
    debounce: debounce,
    loadCatalog: loadCatalog,
    normalizePlate: normalizePlate,
    fetchJson: fetchJson,
  }
})()
