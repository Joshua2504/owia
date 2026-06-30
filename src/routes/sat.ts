import { FastifyInstance } from 'fastify'

// Luftbild-/Satelliten-Kacheln (amtliche Orthophotos des Landes Hessen).
//
// Der OSM-Tileserver kann nur Straßenkarten rendern – echte Luftbilder kommen
// vom WMS-Dienst der Hessischen Verwaltung für Bodenmanagement und Geoinformation
// (HVBG). Quelle ist Open Data unter Datenlizenz Deutschland – Zero 2.0, ohne
// API-Key; Abdeckung: ganz Hessen (= unser Einsatzgebiet).
//
// Wir proxen die Kacheln same-origin über /sat/..., analog zum OSM-Proxy in
// tiles.ts: kein zusätzlicher Port nach außen, keine CORS-/Mixed-Content- oder
// Drittanbieter-Requests aus dem Browser. Der WMS liefert nur ganze Bilder zu
// einer Bounding-Box, also rechnen wir die XYZ-Kachelkoordinate in eine
// Web-Mercator-BBox um und holen ein 256×256-JPEG (JPEG ist für Fotos deutlich
// kleiner als PNG).
const WMS_URL = (
  process.env.SATELLITE_WMS_URL ||
  'https://www.gds-srv.hessen.de/cgi-bin/lika-services/de-viewer/access/ogc-free-images.ows'
).replace(/\?.*$/, '')
const WMS_LAYER = process.env.SATELLITE_WMS_LAYER || 'he_dop_rgb'

// Halber Erdumfang in Web-Mercator-Metern (EPSG:3857-Grenze).
const MERC_MAX = 20037508.342789244

// XYZ-Kachel (Slippy-Map) → BBox in EPSG:3857.
function tileBBox(z: number, x: number, y: number) {
  const span = (2 * MERC_MAX) / 2 ** z
  const minX = -MERC_MAX + x * span
  const maxY = MERC_MAX - y * span
  return { minX, minY: maxY - span, maxX: minX + span, maxY }
}

export default async function satRoutes(app: FastifyInstance) {
  app.get('/sat/:z/:x/:y.jpg', async (request, reply) => {
    const { z, x, y } = request.params as { z: string; x: string; y: string }
    const zN = Number(z)
    const xN = Number(x)
    const yN = Number(y)
    if (![zN, xN, yN].every(Number.isInteger) || zN < 0 || zN > 21) {
      return reply.code(400).send()
    }
    const max = 2 ** zN
    if (xN < 0 || xN >= max || yN < 0 || yN >= max) {
      return reply.code(400).send()
    }

    const { minX, minY, maxX, maxY } = tileBBox(zN, xN, yN)
    // WMS 1.3.0, EPSG:3857: Achsenreihenfolge X,Y → minX,minY,maxX,maxY.
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetMap',
      LAYERS: WMS_LAYER,
      STYLES: '',
      CRS: 'EPSG:3857',
      BBOX: `${minX},${minY},${maxX},${maxY}`,
      WIDTH: '256',
      HEIGHT: '256',
      FORMAT: 'image/jpeg',
    })
    const url = `${WMS_URL}?${params.toString()}`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!res.ok) {
        request.log.warn({ status: res.status }, 'Luftbild-WMS-Antwort fehlerhaft')
        return reply.code(502).send()
      }

      // Bei Fehlern liefert ein WMS gern eine XML-ServiceException statt eines
      // Bildes – nicht als Kachel durchreichen, sonst zeigt Leaflet Müll.
      const type = res.headers.get('content-type') || ''
      if (!type.startsWith('image/')) {
        request.log.warn({ type }, 'Luftbild-WMS lieferte kein Bild')
        return reply.code(502).send()
      }

      const buffer = Buffer.from(await res.arrayBuffer())
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=86400')
        .send(buffer)
    } catch (err) {
      request.log.warn({ err }, 'Luftbild-WMS nicht erreichbar')
      return reply.code(502).send()
    }
  })
}
