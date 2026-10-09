import { FastifyInstance } from 'fastify'
import { getTile, MAX_TILE_ZOOM } from '../services/tiles'

// Karten-Kacheln same-origin unter /tiles/... (Quelle: basemap.de, Cache und
// Fallback in services/tiles.ts). Der Proxy hält Nutzer-IPs von Dritten fern
// und erspart CORS-/CSP-Ausnahmen – analog zum Photon-Proxy in geo.ts.
//
// Bewusst ohne Auth: Die öffentliche Übersichtskarte (Startseite) braucht die
// Kacheln auch für nicht eingeloggte Nutzer. Es handelt sich um öffentliche
// Kartendaten; nur ganzzahlige Kachelkoordinaten werden weitergereicht.
export default async function tilesRoutes(app: FastifyInstance) {
  app.get('/tiles/:z/:x/:y.png', async (request, reply) => {
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

    const buffer = await getTile(zN, xN, yN)
    if (!buffer) {
      // Quelle nicht erreichbar – Browser zeigt leere Kachel, Karte zeigt Hinweis.
      request.log.warn({ z: zN, x: xN, y: yN }, 'Kartenkachel nicht verfügbar')
      return reply.code(502).send()
    }
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=86400')
      .send(buffer)
  })
}
