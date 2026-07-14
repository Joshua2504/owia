// Photon-Geocoding (selbst gehostet). Hier liegt der Teil, den sowohl die
// Geo-API-Routen (src/routes/geo.ts) als auch der Sammel-Import (Tatort aus
// Foto-GPS) brauchen: Feature -> Adressvorschlag sowie Reverse-Geocoding.
export const PHOTON_URL = (process.env.PHOTON_URL || 'http://photon:2322').replace(/\/$/, '')

export type PhotonFeature = {
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

export type AddressSuggestion = {
  label: string
  street: string
  housenumber: string
  postcode: string
  city: string
  lat: number | null
  lon: number | null
}

export function toSuggestion(f: PhotonFeature): AddressSuggestion {
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

/** Koordinaten -> nächstgelegene Adresse; null bei Fehler/Timeout (Photon
 *  darf z.B. die Entwurfs-Erzeugung im Sammel-Import nie blockieren). */
export async function reverseGeocode(lat: number, lon: number): Promise<AddressSuggestion | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const url = `${PHOTON_URL}/reverse?lat=${lat}&lon=${lon}&lang=de`
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null

    const data = (await res.json()) as { features?: PhotonFeature[] }
    const feature = (data.features || [])[0]
    const result = feature ? toSuggestion(feature) : null
    return result && result.label ? result : null
  } catch {
    return null
  }
}
