import { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth'
import { City, getCityByScope, unlockedCities } from '../config/cities'
import { detectCityByPlz } from '../services/districts'
import {
  PHOTON_URL,
  PhotonFeature,
  AddressSuggestion,
  toSuggestion,
  reverseGeocode,
} from '../services/geocode'

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

/** Eine Photon-Adresssuche ausführen; bei Fehler/Timeout leeres Feature-Array. */
async function photonSearch(
  q: string,
  opts: { biasLat: number; biasLon: number; bbox?: string | null; limit: number }
): Promise<PhotonFeature[]> {
  const url =
    `${PHOTON_URL}/api?q=${encodeURIComponent(q)}&lang=de&limit=${opts.limit}` +
    `&lat=${opts.biasLat}&lon=${opts.biasLon}&location_bias_scale=0.3` +
    (opts.bbox ? `&bbox=${opts.bbox}` : '')
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return []
    const data = (await res.json()) as { features?: PhotonFeature[] }
    return data.features || []
  } catch {
    return []
  }
}

/** Adressen einer Stadt suchen: eng auf die Stadt gescopt (Bias + Bbox), gefiltert
 *  über die PLZ des Treffers (districts.csv -> genau diese freigeschaltete Stadt).
 *  Die PLZ ist robuster als der Ortsname: Photon liefert für Bad Soden-Salmünster
 *  je nach Stadtteil "Bad Soden", "Salmünster" o.Ä. – alle mit PLZ 63628. */
async function searchCity(q: string, city: City, limit: number): Promise<AddressSuggestion[]> {
  const features = await photonSearch(q, {
    biasLat: city.geo.biasLat,
    biasLon: city.geo.biasLon,
    bbox: city.geo.bbox,
    limit: 25,
  })
  return features
    .filter((f) => isAddress(f.properties))
    .filter((f) => {
      const det = detectCityByPlz(f.properties.postcode)
      return det.status === 'unlocked' && det.city.id === city.id
    })
    .map(toSuggestion)
    .filter((s) => s.label.length > 0)
    .slice(0, limit)
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

    if (cities.length) {
      // Pro Stadt eine eigene, eng gescopte Suche und dann mergen: eine gemeinsame
      // Bias-Stadt würde die Treffer der weiter entfernten Stadt sonst verdrängen
      // (bei häufigen Straßennamen käme Bad Soden nie in die Top-Treffer).
      const perCity = await Promise.all(cities.map((c) => searchCity(q.trim(), c, 6)))
      // Im Round-Robin mischen, damit beide Städte in der Liste vertreten sind.
      const seen = new Set<string>()
      const merged: AddressSuggestion[] = []
      const maxLen = Math.max(0, ...perCity.map((a) => a.length))
      for (let i = 0; i < maxLen; i++) {
        for (const arr of perCity) {
          const s = arr[i]
          if (s && !seen.has(s.label)) {
            seen.add(s.label)
            merged.push(s)
          }
        }
      }
      return reply.send({ results: merged.slice(0, 8) })
    }

    // Ohne Scope: bundesweite Suche (Deutschland-Mitte als Bias), keine Stadt-Filter.
    const features = await photonSearch(q.trim(), {
      biasLat: DEFAULT_BIAS_LAT,
      biasLon: DEFAULT_BIAS_LON,
      limit: 15,
    })
    const results = features
      .filter((f) => isAddress(f.properties))
      .map(toSuggestion)
      .filter((s) => s.label.length > 0)
      .slice(0, 6)
    return reply.send({ results })
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
