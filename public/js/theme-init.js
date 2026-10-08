// Theme VOR dem ersten Rendern setzen (kein Aufblitzen): gespeicherte Wahl,
// sonst Systemeinstellung. Deshalb synchron (ohne defer/async) als erstes
// Script im <head> von layout.ejs – alles andere wartet. Der Umschalter in der
// Navbar steckt in layout.js.
;(function () {
  var theme
  try { theme = localStorage.getItem('theme') } catch (_) {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  document.documentElement.setAttribute('data-bs-theme', theme)
})()
