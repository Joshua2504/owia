// Zentrale Registry der FREIGESCHALTETEN Städte. Single Source of Truth für alle
// stadtspezifischen Eigenschaften (Empfänger-Adresse, amtliches PDF-Formular,
// Geocoding-Eingrenzung, zuständiges Ordnungsamt).
//
// „Freigeschaltet" heißt: nur Städte mit einem Eintrag hier können Anzeigen
// erstatten. Die bundesweite PLZ->Ordnungsamt-Tabelle (resources/districts.csv,
// services/districts.ts) dient allein der Erkennung; ist der erkannte Ort NICHT
// hier hinterlegt, wird die Anzeige als „noch nicht freigeschaltet" abgewiesen.
//
// Städte OHNE pdfForm werden als rohe E-Mail versendet (Sachverhalt im Text,
// Beweisfotos + Tatort-Karte als Anhang) – für Ämter ohne eigenes Formular.
// Städte MIT pdfForm bekommen das amtliche Formular als PDF-Anhang (Frankfurt).
//
// Eine weitere Stadt freischalten: hier einen Eintrag ergänzen und den Ortsnamen
// exakt wie in districts.csv schreiben (damit PLZ-Erkennung und Empfänger-Adresse
// greifen), optional ein PDF-Formular unter resources/ ablegen. Die Empfänger-
// Adresse wird nicht hier gepflegt, sondern aus districts.csv gelesen.
//
// Außerdem die Stadtgrenze als resources/boundaries/<id>.geojson ablegen (ein
// GeoJSON-Feature mit der OSM-Verwaltungsgrenze; Bezug z.B. über Nominatim:
// /lookup?osm_ids=R<relation-id>&format=jsonv2&polygon_geojson=1). Die Karten
// zeichnen daraus den Umriss der freigeschalteten Gebiete (/api/geo/boundaries);
// fehlt die Datei, erscheint die Stadt schlicht ohne Umriss.

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
  /** Dateiname des amtlichen Formulars in resources/. Fehlt es, wird die Anzeige
   *  als rohe E-Mail (Sachverhalt + Fotos/Karte im Anhang) versendet. */
  pdfForm?: string
  geo: CityGeo
}

// Empfänger-Adressen werden NICHT hier gepflegt, sondern immer aus der bundes-
// weiten Tabelle resources/districts.csv (per PLZ des Tatorts) ermittelt –
// siehe services/districts.ts (recipientEmailForReport / cityEmail).

export const DEFAULT_CITY_ID = 'frankfurt'

export const CITIES: Record<string, City> = {
  frankfurt: {
    id: 'frankfurt',
    name: 'Frankfurt am Main',
    ordnungsamt: 'Ordnungsamt der Stadt Frankfurt am Main',
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
  // Bad Soden-Salmünster (Main-Kinzig-Kreis, Hessen). Kein amtliches PDF-Formular
  // -> Versand als rohe E-Mail. Empfänger-Adresse kommt (wie bei allen Städten)
  // aus districts.csv (PLZ 63628).
  badsoden: {
    id: 'badsoden',
    // Exakt wie in districts.csv, damit die PLZ-Erkennung (63628) greift.
    name: 'Bad Soden-Salmünster',
    ordnungsamt: 'Ordnungsamt der Stadt Bad Soden-Salmünster',
    // kein pdfForm -> rohe E-Mail
    geo: {
      scope: 'bss',
      // Gesamtes Stadtgebiet inkl. Stadtteile (Salmünster, Ahl, Mernes …).
      bbox: '9.28,50.21,9.49,50.36',
      // Distinktives Teilstück des Namens: matcht „Bad Soden-Salmünster" und den
      // Stadtteil „Salmünster", nicht aber das ferne „Bad Soden am Taunus".
      cityMatch: 'salmünster',
      biasLat: 50.2772,
      biasLon: 9.3669,
      // Kurpark/Zentrum Bad Soden – Default-Kartenmittelpunkt im Formular.
      mapLat: 50.2772,
      mapLon: 9.3669,
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

/** Freigeschaltete Stadt zu einem Ortsnamen (wie in districts.csv), case-insensitiv.
 *  Grundlage der PLZ-Erkennung: districts.csv liefert den Ortsnamen, hier prüfen
 *  wir, ob dieser Ort freigeschaltet ist. */
export function getCityByName(name?: string | null): City | undefined {
  if (!name) return undefined
  const needle = name.trim().toLowerCase()
  return Object.values(CITIES).find((c) => c.name.toLowerCase() === needle)
}

/** Alle freigeschalteten Städte (für Auswahl-Dropdown und Multi-Stadt-Suche). */
export function unlockedCities(): City[] {
  return Object.values(CITIES)
}

/** Hat die Stadt ein amtliches PDF-Formular? Wenn nein -> Versand als rohe E-Mail. */
export function hasPdfForm(city: City): boolean {
  return !!city.pdfForm
}
