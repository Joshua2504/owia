import { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth'
import { getCity, getCityByScope } from '../config/cities'

const PHOTON_URL = (process.env.PHOTON_URL || 'http://photon:2322').replace(/\/$/, '')

// Allgemeiner Kartenschwerpunkt (Deutschland-Mitte), falls kein Stadt-Scope greift.
const DEFAULT_BIAS_LAT = 51.16
const DEFAULT_BIAS_LON = 10.45

type PhotonFeature = {
  properties: {
    name?: string
    housenumber?: string
    street?: string
    postcode?: string
    city?: string
    district?: string
    town?: string
    village?: string
    county?: string
    state?: string
    osm_value?: string
    type?: string
  }
  geometry?: { coordinates?: [number, number] }
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

type AddressSuggestion = {
  label: string
  street: string
  housenumber: string
  postcode: string
  city: string
  lat: number | null
  lon: number | null
}

function toSuggestion(f: PhotonFeature): AddressSuggestion {
  const p = f.properties || {}
  const city = p.city || p.town || p.village || p.district || ''
  // Bei Straßen/Adressen steht der Straßenname in `name`, bei Hausnummern in `street`.
  const street = p.street || p.name || ''
  const coords = f.geometry?.coordinates

  // Reine Adresszeile: "Straße Hausnr., PLZ Ort" – ohne POI-/Firmennamen.
  const label = [
    [street, p.housenumber].filter(Boolean).join(' '),
    [p.postcode, city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ')

  return {
    label,
    street,
    housenumber: p.housenumber || '',
    postcode: p.postcode || '',
    city,
    lat: coords ? coords[1] : null,
    lon: coords ? coords[0] : null,
  }
}

export default async function geoRoutes(app: FastifyInstance) {
  app.get('/api/geo/search', { preHandler: requireAuth }, async (request, reply) => {
    const { q, scope } = request.query as { q?: string; scope?: string }
    if (!q || q.trim().length < 3) {
      return reply.send({ results: [] })
    }
    // Scope grenzt die Suche auf eine konkrete Stadt ein (z.B. "ffm").
    const city = getCityByScope(scope)
    const biasLat = city ? city.geo.biasLat : DEFAULT_BIAS_LAT
    const biasLon = city ? city.geo.biasLon : DEFAULT_BIAS_LON

    // Mehr Treffer anfragen, da der Adress- (und ggf. Stadt-)Filter
    // anschließend noch POIs/Nachbarorte herausnimmt.
    const limit = city ? 25 : 15
    let url =
      `${PHOTON_URL}/api?q=${encodeURIComponent(q.trim())}` +
      `&lang=de&limit=${limit}&lat=${biasLat}&lon=${biasLon}&location_bias_scale=0.3`
    if (city) {
      url += `&bbox=${city.geo.bbox}`
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
      if (city) {
        features = features.filter((f) => matchesCity(f.properties, city.geo.cityMatch))
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

    const url = `${PHOTON_URL}/reverse?lat=${latN}&lon=${lonN}&lang=de`
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)

      if (!res.ok) {
        request.log.warn({ status: res.status }, 'Photon-Reverse fehlgeschlagen')
        return reply.send({ result: null })
      }

      const data = (await res.json()) as { features?: PhotonFeature[] }
      const feature = (data.features || [])[0]
      const result = feature ? toSuggestion(feature) : null
      return reply.send({ result: result && result.label ? result : null })
    } catch (err) {
      request.log.warn({ err }, 'Photon-Reverse nicht erreichbar')
      return reply.send({ result: null })
    }
  })
}
