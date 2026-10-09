// Erzeugt mobile/www/ vor `cap sync`: die lokale Fehlerseite (server.errorPath)
// und ein Rückfall-index.html. Die Server-URL steht in beiden fest drin, damit
// „Erneut versuchen“ auch bei Testbuilds (OWIA_APP_URL) zum richtigen Server führt.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const www = join(here, '..', 'www')
const server = (process.env.OWIA_APP_URL || 'https://owia.net').replace(/\/$/, '')
const start = `${server}/`

const page = (title, body) => `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #212529; color: #f8f9fa;
         padding: env(safe-area-inset-top) 1.5rem env(safe-area-inset-bottom); }
  .box { max-width: 22rem; }
  .icon { font-size: 3rem; }
  h1 { font-size: 1.3rem; margin: .5rem 0; }
  p { color: #adb5bd; margin: 0 0 1.5rem; }
  a.btn { display: block; padding: .8rem 1rem; border-radius: .6rem; text-decoration: none; font-weight: 600; margin-bottom: .6rem; }
  .primary { background: #0d6efd; color: #fff; }
  .secondary { border: 1px solid #495057; color: #f8f9fa; }
</style>
</head>
<body><div class="box">${body}</div></body>
</html>
`

mkdirSync(www, { recursive: true })
writeFileSync(join(www, 'offline.html'), page('Keine Verbindung', `
  <div class="icon">📡</div>
  <h1>Seite nicht erreichbar</h1>
  <p>Bitte die Internetverbindung prüfen. Fotos, die schon hochgeladen sind, bleiben erhalten.</p>
  <a class="btn primary" href="${start}">Erneut versuchen</a>
`))
// Wird nur geladen, wenn server.url fehlt – dann direkt weiter zum Server.
writeFileSync(join(www, 'index.html'), page('OWiA', `
  <div class="icon">🚗</div>
  <h1>OWiA-Anzeiger</h1>
  <p>Wird geladen …</p>
  <a class="btn primary" href="${start}">Öffnen</a>
`))
console.log(`www/ erzeugt (Server: ${server})`)
