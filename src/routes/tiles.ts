import { FastifyInstance } from 'fastify'
import { getTile, MAX_TILE_ZOOM, tileInDeutschland } from '../services/tiles'

// Karten-Kacheln same-origin unter /tiles/... (Quelle: basemap.de, Cache und
// Fallback in services/tiles.ts). Der Proxy hält Nutzer-IPs von Dritten fern
// und erspart CORS-/CSP-Ausnahmen – analog zum Photon-Proxy in geo.ts.
//
// Bewusst ohne Auth: Die öffentliche Übersichtskarte (Startseite) braucht die
// Kacheln auch für nicht eingeloggte Nutzer. Es handelt sich um öffentliche
// Kartendaten; nur ganzzahlige Kachelkoordinaten werden weitergereicht.

// Transparente 1×1-PNG für Kacheln außerhalb von Deutschland: Leaflet wertet sie
// als erfolgreich geladene (leere) Kachel – ein 204/404 würde `tileerror`
// auslösen und das „Karte nicht verfügbar"-Banner (map-common.js) einblenden.
const LEERE_KACHEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==',
  'base64',
)

// Log-Drosselung: bei einem basemap.de-Ausfall käme sonst pro Kachel eine
// Warnung (Dutzende pro Kartenaufruf). Höchstens eine pro Minute, mit Zähler.
const LOG_INTERVALL_MS = 60 * 1000
let letzteWarnung = 0
let unterdrueckt = 0

export default async function tilesRoutes(app: FastifyInstance) {
  // Eigenes Limit: eine Kartenansicht lädt je nach Displaygröße 20–60 Kacheln,
  // Schwenken/Zoomen weitere. 600/min/IP trägt das, hält aber Abgraser ab
  // (das globale Limit von 2000/min gilt für alles zusammen).
  app.get('/tiles/:z/:x/:y.png', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { z, x, y } = request.params as { z: string; x: string; y: string }
    const zN = Number(z)
    const xN = Number(x)
    const yN = Number(y)
    const max = 2 ** zN
    if (
      ![zN, xN, yN].every(Number.isInteger) ||
      zN < 0 || zN > MAX_TILE_ZOOM ||
      xN < 0 || yN < 0 || xN >= max || yN >= max
    ) {
      return reply.code(400).send()
    }

    if (!tileInDeutschland(zN, xN, yN)) {
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'public, max-age=86400')
        .send(LEERE_KACHEL)
    }

    const buffer = await getTile(zN, xN, yN, 5000, true)
    if (!buffer) {
      // Quelle nicht erreichbar – Browser zeigt leere Kachel, Karte zeigt Hinweis.
      const jetzt = Date.now()
      if (jetzt - letzteWarnung >= LOG_INTERVALL_MS) {
        request.log.warn({ z: zN, x: xN, y: yN, weitere: unterdrueckt }, 'Kartenkachel nicht verfügbar')
        letzteWarnung = jetzt
        unterdrueckt = 0
      } else {
        unterdrueckt++
      }
      return reply.code(502).send()
    }
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=86400')
      .send(buffer)
  })
}
