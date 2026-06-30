// Zentrale Stadt-/Behörden-Registry. Single Source of Truth für alle
// stadtspezifischen Eigenschaften (Empfänger-Adresse, amtliches PDF-Formular,
// Geocoding-Eingrenzung, zuständiges Ordnungsamt).
//
// Eine weitere Stadt zu unterstützen heißt: hier einen Eintrag ergänzen, das
// passende PDF-Formular unter resources/ ablegen und (falls nötig) die
// Empfänger-Adresse per Umgebungsvariable MAIL_TO_<CITYID> setzen. Der restliche
// Code liest ausschließlich über getCity()/CITIES und bleibt unverändert.

export interface CityGeo {
  /** Photon-Scope-Kennung; entspricht data-geo-scope im Formular. */
  scope: string
  /** Bounding-Box "minLon,minLat,maxLon,maxLat" zur Vorfilterung. */
  bbox: string
  /** Ortsname (lowercase) zum Aussortieren von Nachbarorten in der Box. */
  cityMatch: string
  /** Kartenschwerpunkt der Suche. */
  biasLat: number
  biasLon: number
  /** Default-Mittelpunkt der Tatort-Karte im Formular, solange kein Marker gesetzt ist. */
  mapLat: number
  mapLon: number
}

export interface City {
  id: string
  /** Anzeigename der Stadt, z.B. "Frankfurt am Main". */
  name: string
  /** Zuständige Behörde, wird dem Nutzer angezeigt. */
  ordnungsamt: string
  /** Empfänger-Adresse der Anzeige-E-Mail. */
  email: string
  /** Dateiname des amtlichen Formulars in resources/. */
  pdfForm: string
  geo: CityGeo
}

/** Empfänger-Adresse: per MAIL_TO_<CITYID> überschreibbar, sonst Default. */
function recipient(cityId: string, fallback: string): string {
  return process.env[`MAIL_TO_${cityId.toUpperCase()}`] || fallback
}

export const DEFAULT_CITY_ID = 'frankfurt'

export const CITIES: Record<string, City> = {
  frankfurt: {
    id: 'frankfurt',
    name: 'Frankfurt am Main',
    ordnungsamt: 'Ordnungsamt der Stadt Frankfurt am Main',
    email: recipient('frankfurt', 'ordnungsamt@stadt-frankfurt.de'),
    pdfForm: 'formular.pdf',
    geo: {
      scope: 'ffm',
      bbox: '8.45,50.00,8.81,50.24',
      cityMatch: 'frankfurt am main',
      biasLat: 50.1109,
      biasLon: 8.6821,
      // Frankfurt (Main) Hauptbahnhof – Default-Kartenmittelpunkt im Formular.
      mapLat: 50.1072,
      mapLon: 8.6638,
    },
  },
}

/** Stadt zu einer ID; fällt bei unbekannter/leerer ID auf die Default-Stadt zurück. */
export function getCity(id?: string | null): City {
  return (id && CITIES[id]) || CITIES[DEFAULT_CITY_ID]
}

/** Stadt anhand einer Geo-Scope-Kennung (data-geo-scope) finden. */
export function getCityByScope(scope?: string | null): City | undefined {
  if (!scope) return undefined
  return Object.values(CITIES).find((c) => c.geo.scope === scope)
}
