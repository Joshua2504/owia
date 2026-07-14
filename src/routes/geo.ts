import { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth'
import { City, getCityByScope, unlockedCities } from '../config/cities'
import { detectCityByPlz } from '../services/districts'
import { PHOTON_URL, PhotonFeature, toSuggestion, reverseGeocode } from '../services/geocode'

// Allgemeiner Kartenschwerpunkt (Deutschland-Mitte), falls kein Stadt-Scope greift.
const DEFAULT_BIAS_LAT = 51.16
const DEFAULT_BIAS_LON = 10.45

/** Die vom Scope betroffenen Städte. "unlocked" = alle freigeschalteten Städte
 *  (Tatort-Suche im Formular), sonst die eine Stadt der Scope-Kennung. */
function scopeCities(scope?: string | null): City[] {
  if (scope === 'unlocked') return unlockedCities()
  const city = getCityByScope(scope)
  return city ? [city] : []
}

/** Hüllen-Bounding-Box "minLon,minLat,maxLon,maxLat" über mehrere Städte. */
function unionBbox(cities: City[]): string | null {
  if (!cities.length) return null
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const c of cities) {
    const [a, b, cc, d] = c.geo.bbox.split(',').map(Number)
    if ([a, b, cc, d].some((n) => !Number.isFinite(n))) continue
    minLon = Math.min(minLon, a); minLat = Math.min(minLat, b)
    maxLon = Math.max(maxLon, cc); maxLat = Math.max(maxLat, d)
  }
  return Number.isFinite(minLon) ? `${minLon},${minLat},${maxLon},${maxLat}` : null
}

// Nur Adressen anzeigen (Straßen + Hausnummern), keine Firmen/POIs.
// Photon liefert den Treffertyp in `properties.type`. Firmen/benannte Gebäude
// tauchen als type "house" mit einem eigenen `name` auf (z.B. "Commerzbank
// Tower") – reine Hausnummern-Adressen haben keinen solchen Namen.
function isAddress(p: PhotonFeature['properties']): boolean {
  const type = p.type || ''
  if (type === 'street') return true
  if (type === 'house') {
    const name = (p.name || '').trim()
    return name === '' || name === (p.street || '')
  }
  return false
}

function matchesCity(p: PhotonFeature['properties'], cityMatch: string): boolean {
  return [p.city, p.town, p.village, p.district, p.county].some((v) =>
    (v || '').toLowerCase().includes(cityMatch)
  )
}

export default async function geoRoutes(app: FastifyInstance) {
  app.get('/api/geo/search', { preHandler: requireAuth }, async (request, reply) => {
    const { q, scope } = request.query as { q?: string; scope?: string }
    if (!q || q.trim().length < 3) {
      return reply.send({ results: [] })
    }
    // Scope grenzt die Suche auf eine ("ffm") oder alle freigeschalteten Städte
    // ("unlocked") ein. So findet die Tatort-Suche Adressen in Frankfurt UND Bad
    // Soden-Salmünster, aber keine Orte, die (noch) nicht unterstützt werden.
    const cities = scopeCities(scope)
    const primary = cities[0]
    const biasLat = primary ? primary.geo.biasLat : DEFAULT_BIAS_LAT
    const biasLon = primary ? primary.geo.biasLon : DEFAULT_BIAS_LON
    const bbox = unionBbox(cities)

    // Mehr Treffer anfragen, da der Adress- (und ggf. Stadt-)Filter
    // anschließend noch POIs/Nachbarorte herausnimmt.
    const limit = cities.length ? 25 : 15
    let url =
      `${PHOTON_URL}/api?q=${encodeURIComponent(q.trim())}` +
      `&lang=de&limit=${limit}&lat=${biasLat}&lon=${biasLon}&location_bias_scale=0.3`
    if (bbox) {
      url += `&bbox=${bbox}`
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!res.ok) {
        request.log.warn({ status: res.status }, 'Photon-Suche fehlgeschlagen')
        return reply.send({ results: [] })
      }

      const data = (await res.json()) as { features?: PhotonFeature[] }
      let features = (data.features || []).filter((f) => isAddress(f.properties))
      if (cities.length) {
        // Nur Treffer in einer der freigeschalteten Städte behalten.
        features = features.filter((f) =>
          cities.some((c) => matchesCity(f.properties, c.geo.cityMatch))
        )
      }
      const results = features
        .map(toSuggestion)
        .filter((s) => s.label.length > 0)
        .slice(0, 6)
      return reply.send({ results })
    } catch (err) {
      // Photon noch nicht bereit (Index-Import) oder nicht erreichbar – leer liefern.
      request.log.warn({ err }, 'Photon nicht erreichbar')
      return reply.send({ results: [] })
    }
  })

  // Reverse-Geocoding: Koordinaten -> nächstgelegene Adresse. Wird für
  // "aktueller Standort" und "Standort aus Foto" auf der Anzeige-Seite genutzt.
  app.get('/api/geo/reverse', { preHandler: requireAuth }, async (request, reply) => {
    const { lat, lon } = request.query as { lat?: string; lon?: string }
    const latN = Number(lat)
    const lonN = Number(lon)
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
      return reply.send({ result: null })
    }

    const result = await reverseGeocode(latN, lonN)
    if (!result) request.log.warn({ lat: latN, lon: lonN }, 'Photon-Reverse ohne Ergebnis/nicht erreichbar')
    return reply.send({ result })
  })

  // Zuständiges Ordnungsamt zu einer Postleitzahl (bundesweite Tabelle) inkl. der
  // Info, ob dieser Ort in OWiA freigeschaltet ist. Das Formular fragt das nach der
  // Tatort-Auswahl ab, um die Stadt-Auswahl automatisch zu setzen bzw. zu warnen.
  app.get('/api/geo/authority', { preHandler: requireAuth }, async (request, reply) => {
    const plz = String((request.query as { plz?: string }).plz || '').trim()
    const det = detectCityByPlz(plz)
    if (det.status === 'unlocked') {
      return reply.send({
        status: 'unlocked',
        cityId: det.city.id,
        name: det.city.name,
        ordnungsamt: det.city.ordnungsamt,
        email: det.district.email, // Empfänger immer aus districts.csv
      })
    }
    if (det.status === 'locked') {
      return reply.send({
        status: 'locked',
        name: det.district.name,
        ordnungsamt: det.district.email,
        email: det.district.email,
      })
    }
    return reply.send({ status: 'unknown' })
  })
}
