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
  // wird als klarer Hinweis gemeldet statt als Parser-Fehler. Ein Body, der
  // kein JSON ist (Proxy-Fehlerseite, leere 204), gilt als {} – entscheidend
  // ist dann der Status.
  // opts: wie bei fetch, zusätzlich
  //   json     – Objekt als JSON-Body (setzt Content-Type; Methode ohne
  //              Angabe POST),
  //   fallback – Fehlertext, wenn der Server kein { error } liefert.
  // Der Error trägt .status (HTTP-Status) und .data (geparster Body), bei der
  // Weiterleitung .redirected – Aufrufer lesen daraus Zusatzfelder (warten,
  // doppelt, redirect). Netzwerkfehler kommen unverändert von fetch (ohne
  // .status).
  function fetchJson(url, opts) {
    opts = opts || {}
    var fallback = opts.fallback || 'Anfrage fehlgeschlagen.'
    var init = {}
    for (var k in opts) if (k !== 'fallback' && k !== 'headers' && k !== 'json') init[k] = opts[k]
    init.headers = { Accept: 'application/json' }
    if (opts.json !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.json)
      if (!init.method) init.method = 'POST'
    }
    if (opts.headers) for (var h in opts.headers) init.headers[h] = opts.headers[h]
    return fetch(url, init).then(function (r) {
      if (r.redirected) throw httpError('Bitte neu anmelden.', r, {}, true)
      return r.json().catch(function () { return {} }).then(function (d) {
        if (!r.ok) throw httpError((d && d.error) || fallback, r, d || {})
        return d
      })
    })
  }
  function httpError(message, r, data, redirected) {
    var e = new Error(message)
    e.status = r.status
    e.data = data
    if (redirected) e.redirected = true
    return e
  }

  // Wie fetchJson, aber jeder Fehler (HTTP, Weiterleitung, Netz) ergibt null –
  // für Polling und optionale Zusatzdaten, bei denen „gerade nicht da" kein
  // Fehlerfall ist.
  function tryJson(url, opts) {
    return fetchJson(url, opts).catch(function () { return null })
  }

  // Adresse zu Koordinaten (Photon über /api/geo/reverse, der Browser spricht
  // nie selbst mit Photon). Ergebnis { label, postcode, city, … } oder null
  // (kein Treffer, HTTP-Fehler). Netzwerkfehler lehnen ab – report-form.js
  // unterscheidet „nicht erreichbar" von „keine Adresse gefunden".
  function reverseGeocode(lat, lon) {
    return fetchJson('/api/geo/reverse?lat=' + lat + '&lon=' + lon).then(
      function (d) { return (d && d.result) || null },
      function (e) { if (e.status) return null; throw e }
    )
  }

  // ---- Zeit/Datum ----------------------------------------------------------
  // Foto-Zeitstempel sind Strings ('YYYY-MM-DD HH:MM:SS') und gehen nie durch
  // ein Date (Zeitzonen) – die Helfer hier formatieren nur Strings bzw. Dates,
  // die ohnehin schon lokale Gerätezeit sind (Kamera-Uhr, exifr-Ergebnis).
  function pad2(n) {
    return String(n).padStart(2, '0')
  }
  // Lokale Zeit eines Date als 'YYYY-MM-DD HH:MM:SS' (Format der Foto-
  // Zeitstempel; slice(0, 10) = Datum, slice(11, 16) = HH:MM).
  function dateStamp(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
  }
  // 'YYYY-MM-DD' → 'DD.MM.YYYY' per Zerlegen (ohne Date, damit keine Zeitzone
  // den Tag verschiebt); alles andere → null (Aufrufer wählen den Rückfall).
  function dateDe(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso))
    return m ? m[3] + '.' + m[2] + '.' + m[1] : null
  }
  // Sekunden als Countdown 'M:SS' (padMinutes: 'MM:SS').
  function mmss(sec, padMinutes) {
    var m = Math.floor(sec / 60)
    return (padMinutes ? pad2(m) : m) + ':' + pad2(sec % 60)
  }

  // Kennzeichenfeld beim Tippen in Großbuchstaben wandeln, Cursor bleibt
  // stehen. Bewusst KEIN Formatzwang: ausländische, Roller-Versicherungs- und
  // Sonderkennzeichen folgen keinem gemeinsamen Muster. Aufruf im input-Handler
  // (report-form.js, report-inline.js).
  function upperCaseInput(el) {
    var up = el.value.toLocaleUpperCase('de-DE')
    if (up === el.value) return
    var pos = el.selectionStart
    el.value = up
    try { el.setSelectionRange(pos, pos) } catch (_) { /* nicht unterstützt */ }
  }

  // Verstoß-/Fahrzeug-Katalog (/anzeigen/bearbeitungsoptionen, ~55 KB) einmal
  // je Seite laden und als Promise teilen – report-inline.js, photo-edit.js und
  // report-bulk.js fragen ihn unabhängig voneinander an. Nach einem
  // Fehlschlag (z.B. während eines App-Neustarts) wird der Cache geleert,
  // damit der nächste Versuch erneut lädt.
  // Ergebnis: { alle, haeufig, gesperrt, standardStadt, fahrzeugTypen, marken,
  // farben, laender } – alle/haeufig/gesperrt ist das Format, das verstoss-select.js erwartet.
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
            laender: d.laender,
          }
        })
        .catch(function () { catalog = null; throw new Error('Verstoß-Katalog nicht ladbar.') })
    }
    return catalog
  }

  // Dialoge statt window.confirm/alert/prompt: natives <dialog> im Top-Layer
  // (liegt damit auch über Bootstrap-Modals und dem Foto-Dialog), im
  // Seiten-Design, Esc/Klick daneben = Abbrechen. Text darf \n enthalten.
  // opts: title, text, ok (Knopftext), cancel (false = kein Abbrechen-Knopf),
  // danger (roter OK-Knopf), icon, input (true = Textfeld, value = Vorgabe).
  // Liefert Promise: bei input den Text bzw. null, sonst true/false.
  function dialog(opts) {
    return new Promise(function (resolve) {
      var d = document.createElement('dialog')
      d.className = 'owia-confirm'
      var icon = opts.icon || (opts.danger ? '!' : opts.cancel === false ? 'i' : '?')
      d.innerHTML =
        '<form method="dialog">' +
        '<div class="owia-confirm-icon' + (opts.danger ? ' is-danger' : '') + '" aria-hidden="true">' + escapeHtml(icon) + '</div>' +
        (opts.title ? '<h2 class="owia-confirm-title">' + escapeHtml(opts.title) + '</h2>' : '') +
        (opts.text ? '<p class="owia-confirm-text">' + escapeHtml(opts.text) + '</p>' : '') +
        (opts.input ? '<input class="form-control mb-3" data-input>' : '') +
        '<div class="owia-confirm-actions">' +
        (opts.cancel === false ? '' : '<button type="submit" value="cancel" class="btn btn-outline-secondary">' + escapeHtml(opts.cancel || 'Abbrechen') + '</button>') +
        '<button type="submit" value="ok" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-ok>' + escapeHtml(opts.ok || 'OK') + '</button>' +
        '</div></form>'
      var input = d.querySelector('[data-input]')
      if (input) input.value = opts.value || ''
      d.addEventListener('click', function (e) { if (e.target === d) d.close('cancel') })
      d.addEventListener('close', function () {
        var ok = d.returnValue === 'ok'
        d.remove()
        resolve(input ? (ok ? input.value : null) : ok)
      })
      document.body.appendChild(d)
      d.showModal()
      ;(input || d.querySelector('[data-ok]')).focus()
    })
  }
  // Ja/Nein-Rückfrage: ask('Text?', { danger: true, ok: 'Löschen' }).then(ok => …)
  function ask(text, opts) {
    var o = { text: text }
    for (var k in opts || {}) o[k] = opts[k]
    return dialog(o)
  }
  function confirmDialog(opts) { return dialog(opts || {}) }
  function alertDialog(text, opts) {
    var o = { text: String(text == null ? '' : text), cancel: false }
    for (var k in opts || {}) o[k] = opts[k]
    return dialog(o)
  }
  function promptDialog(text, value, opts) {
    var o = { text: text, input: true, value: value }
    for (var k in opts || {}) o[k] = opts[k]
    return dialog(o)
  }

  // Gemeinsame Rückfrage vor dem Admin-Sofortversand (report-submit.js,
  // photo-edit.js).
  function confirmSofort() {
    return confirmDialog({
      icon: '⚡',
      title: 'Direkt versenden?',
      text: 'Die Anzeige geht ohne weitere Prüfung sofort ans Ordnungsamt. Das lässt sich nicht rückgängig machen.',
      ok: 'Jetzt versenden',
    })
  }

  window.OWIA = {
    escapeHtml: escapeHtml,
    debounce: debounce,
    loadCatalog: loadCatalog,
    normalizePlate: normalizePlate,
    fetchJson: fetchJson,
    tryJson: tryJson,
    reverseGeocode: reverseGeocode,
    pad2: pad2,
    dateStamp: dateStamp,
    dateDe: dateDe,
    mmss: mmss,
    upperCaseInput: upperCaseInput,
    confirmDialog: confirmDialog,
    ask: ask,
    alert: alertDialog,
    prompt: promptDialog,
    confirmSofort: confirmSofort,
  }
})()
