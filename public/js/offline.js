// Offline-Ersatzseite (public/offline.html): neu laden, sobald das Netz zurück ist.
;(function () {
  'use strict'
  window.addEventListener('online', function () { location.reload() })
})()
