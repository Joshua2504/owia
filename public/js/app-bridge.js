// Nur in der nativen App (Capacitor-Hülle unter mobile/) eingebunden, siehe
// layout.ejs und config/mobileApp.ts. Die Website selbst bleibt dieselbe; hier
// stehen nur die Stellen, an denen die App etwas anders tun muss als der
// Browser. Die Capacitor-Brücke (window.Capacitor) spritzt die App selbst ein
// (iOS: WKUserScript, Android: addDocumentStartJavaScript) – die CSP
// script-src 'self' betrifft sie nicht.
;(function () {
  'use strict'

  var cap = window.Capacitor
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return
  var App = cap.Plugins && cap.Plugins.App
  if (!App) return

  // Universal Links / App Links (Anmeldelink aus der Login-Mail, Sticker-QR,
  // /anzeige/…): Das System startet die App mit der URL, die WebView steht
  // aber noch auf der vorherigen Seite. Nur eigene Pfade übernehmen – fremde
  // Hosts öffnet Capacitor ohnehin im System-Browser.
  function oeffnen(href) {
    try {
      var url = new URL(href)
      if (url.host !== location.host) return
      var ziel = url.pathname + url.search + url.hash
      if (ziel !== location.pathname + location.search + location.hash) location.assign(ziel)
    } catch (_) { /* ungültige URL: ignorieren */ }
  }
  App.addListener('appUrlOpen', function (event) { oeffnen(event.url) })

  // Kaltstart über einen Link: Android meldet ihn nur über getLaunchUrl, und das
  // bei jedem Seitenaufruf erneut (dieses Skript läuft auf jeder Seite) – daher
  // nur einmal je App-Sitzung übernehmen.
  App.getLaunchUrl().then(function (res) {
    if (!res || !res.url) return
    try {
      if (sessionStorage.getItem('owia-launch-url') === res.url) return
      sessionStorage.setItem('owia-launch-url', res.url)
    } catch (_) { return }
    oeffnen(res.url)
  }).catch(function () {})

  // Zurück aus dem Hintergrund nach längerer Pause: Listen und Versandstatus
  // sind dann veraltet. Seiten mit offenem Formular (Editor, Kamera) nicht
  // neu laden – dort könnten ungespeicherte Eingaben verloren gehen.
  var hiddenAt = 0
  App.addListener('appStateChange', function (state) {
    if (!state.isActive) { hiddenAt = Date.now(); return }
    if (!hiddenAt || Date.now() - hiddenAt < 10 * 60 * 1000) return
    hiddenAt = 0
    if (/^\/(anzeigen|papierkorb)\/?$/.test(location.pathname)) location.reload()
  })
})()
