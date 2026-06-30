import { FastifyInstance } from 'fastify'

// OSM-Raster-Tileserver (intern im Docker-Netz, siehe docker-compose.yml).
// Wir proxen die Kacheln same-origin über /tiles/..., damit kein zusätzlicher
// Port nach außen offen sein muss und es keine CORS-/Mixed-Content-Probleme gibt
// – analog zum Photon-Proxy in geo.ts.
//
// Bewusst ohne Auth: Die öffentliche Übersichtskarte (Startseite) braucht die
// Kacheln auch für nicht eingeloggte Nutzer. Es handelt sich um öffentliche
// OSM-Kartendaten; nur ganzzahlige Kachelkoordinaten werden weitergereicht.
const TILESERVER_URL = (process.env.TILESERVER_URL || 'http://tileserver:80').replace(/\/$/, '')

export default async function tilesRoutes(app: FastifyInstance) {
  app.get('/tiles/:z/:x/:y.png', async (request, reply) => {
    const { z, x, y } = request.params as { z: string; x: string; y: string }
    const zN = Number(z)
    const xN = Number(x)
    const yN = Number(y)
    // Nur ganzzahlige Kachelkoordinaten an den Tileserver weiterreichen.
    if (![zN, xN, yN].every(Number.isInteger) || zN < 0 || zN > 20) {
      return reply.code(400).send()
    }

    const url = `${TILESERVER_URL}/tile/${zN}/${xN}/${yN}.png`
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!res.ok) {
        request.log.warn({ status: res.status }, 'Tileserver-Antwort fehlerhaft')
        return reply.code(502).send()
      }

      const buffer = Buffer.from(await res.arrayBuffer())
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'public, max-age=86400')
        .send(buffer)
    } catch (err) {
      // Tileserver noch im Import oder nicht erreichbar – Browser zeigt leere Kachel.
      request.log.warn({ err }, 'Tileserver nicht erreichbar')
      return reply.code(502).send()
    }
  })
}
