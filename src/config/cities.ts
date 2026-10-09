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
// Städte MIT pdfForm bekommen das amtliche Formular als PDF-Anhang.
// Städte MIT portal (Frankfurt, Wiesbaden, Mainz) laufen ausschließlich über
// das Online-Formular der Stadt – dort entsteht weder PDF noch Mail
// (hasPdfForm() ist dann false, auch wenn pdfForm noch eingetragen ist).
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

/** Vorgaben eines Amts für die rohe Anzeige-Mail (nur Städte ohne PDF/Portal). */
export interface MailRegeln {
  /** Anhänge nur als JPG (Fotos werden notfalls umkodiert). */
  nurJpg?: boolean
  /** Keine Tatort-Karte anhängen (das Amt nimmt außer Fotos keine Anhänge an). */
  ohneKarte?: boolean
  /** Obergrenze aller Anhänge zusammen; Fotos werden bis dahin verkleinert. */
  maxAnhangBytes?: number
  /** Ladungsfähige Anschrift der anzeigenden Person in den Mailtext. */
  anschriftImText?: boolean
  /** Hinweise für die Einreichen-Vorschau. */
  hinweise?: string[]
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
  /** Versand über ein Online-Formular statt per Mail (services/portalDispatch.ts).
   *  Frankfurt: ekom21/civento seit 10/2026 – Mails mit PDF nimmt das Amt nur
   *  noch für Tatbestände an, die das Portal nicht kennt. */
  portal?: 'ekom21-ffm' | 'ekom21-wi' | 'civento-mz'
  /** Annahmefrist der Stadt in Monaten, wenn kürzer als die Verjährung (3) –
   *  das ekom21-Portal nimmt nur Taten der letzten zwei Monate an. */
  fristMonate?: number
  /** Weitere Ortsnamen aus districts.csv, die zu dieser Stadt gehören
   *  (Wiesbaden: „Mainz-Kastel", „Mainz-Kostheim" – rechtsrheinisch, aber Wiesbaden). */
  aliases?: string[]
  /** Vorgaben für den Mailversand (services/mail.ts, Einreichen-Vorschau). */
  mail?: MailRegeln
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
    // Das amtliche PDF-Formular (resources/formular.pdf) nimmt die Stadt seit
    // 10/2026 nicht mehr per Mail an; der Eintrag bleibt nur für den Fall, dass
    // der Mailweg zurückkommt. Solange `portal` gesetzt ist, wird kein PDF erzeugt.
    pdfForm: 'formular.pdf',
    portal: 'ekom21-ffm',
    fristMonate: 2,
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
  // Hanau (Main-Kinzig-Kreis, Hessen). Kein amtliches PDF-Formular -> Versand als
  // rohe E-Mail. Empfänger-Adresse kommt (wie bei allen Städten) aus districts.csv
  // (PLZ 63450–63457 -> verwarngeldstelle@hanau.de).
  hanau: {
    id: 'hanau',
    // Exakt wie in districts.csv, damit die PLZ-Erkennung (63450 …) greift.
    name: 'Hanau',
    ordnungsamt: 'Ordnungsamt der Stadt Hanau',
    // kein pdfForm -> rohe E-Mail
    geo: {
      scope: 'hanau',
      // Gesamtes Stadtgebiet inkl. Stadtteile (Kesselstadt, Steinheim, Großauheim,
      // Klein-Auheim, Wolfgang, Mittelbuchen, Lamboy …).
      bbox: '8.85,50.07,9.04,50.20',
      // Hanau ist als Ortsname distinktiv genug – keine gleichnamigen Nachbarorte.
      cityMatch: 'hanau',
      biasLat: 50.1329,
      biasLon: 8.9170,
      // Marktplatz/Freiheitsplatz Hanau – Default-Kartenmittelpunkt im Formular.
      mapLat: 50.1329,
      mapLon: 8.9170,
    },
  },
  // Wiesbaden (Landeshauptstadt Hessen). Seit 10/2026 offizieller Weg das
  // ekom21-Online-Formular (wiesbaden.de bietet keine Mail mehr an). Dieselbe
  // Vorlage wie Frankfurt, aber eigene Rubriken und 2-Monats-Frist
  // (services/portalWi.ts). AKK (Amöneburg, Kastel, Kostheim) gehört zu Wiesbaden –
  // in districts.csv als „Mainz-Kastel"/„Mainz-Kostheim" geführt.
  wiesbaden: {
    id: 'wiesbaden',
    name: 'Wiesbaden',
    aliases: ['Mainz-Kastel', 'Mainz-Kostheim'],
    ordnungsamt: 'Landeshauptstadt Wiesbaden, Verwarngeldstelle',
    portal: 'ekom21-wi',
    fristMonate: 2,
    geo: {
      scope: 'wi',
      // Stadtgebiet inkl. Vororte und AKK (rechtsrheinisch gegenüber Mainz).
      bbox: '8.10,49.99,8.39,50.16',
      cityMatch: 'wiesbaden',
      biasLat: 50.0826,
      biasLon: 8.2400,
      // Wiesbaden Hauptbahnhof – Default-Kartenmittelpunkt im Formular.
      mapLat: 50.0706,
      mapLon: 8.2437,
    },
  },
  // Mainz (Landeshauptstadt Rheinland-Pfalz). Seit 22.05.2025 nur noch über das
  // civento-Formular (antrag-kommunal.service.rlp.de), Mail-Anzeigen werden nicht
  // bearbeitet (services/portalMz.ts). Die Mail-Adresse in districts.csv ist tot.
  mainz: {
    id: 'mainz',
    name: 'Mainz',
    ordnungsamt: 'Landeshauptstadt Mainz, Verkehrsüberwachungsamt',
    portal: 'civento-mz',
    geo: {
      scope: 'mz',
      bbox: '8.14,49.93,8.35,50.04',
      // „mainz" träfe auch Mainz-Kastel/-Kostheim (Wiesbaden) – unkritisch, die
      // Zuständigkeit entscheidet die PLZ (districts.csv).
      cityMatch: 'mainz',
      biasLat: 49.9929,
      biasLon: 8.2473,
      // Mainz Hauptbahnhof – Default-Kartenmittelpunkt im Formular.
      mapLat: 50.0012,
      mapLon: 8.2588,
    },
  },
  // Hamburg: Bußgeldstelle der Behörde für Inneres und Sport. Versand per Mail
  // (hamburg.de „Anzeigen von Privatpersonen"): Sachverhalt im Mailtext, als
  // Anhang NUR Beweisfotos im JPG-Format, keine Sammelanzeigen; ladungsfähige
  // Anschrift ist Pflicht. 10 MB gesamt laut ADFC Hamburg. Das Online-Formular
  // im Serviceportal (max. 3 Fotos) nutzen wir bewusst nicht.
  hamburg: {
    id: 'hamburg',
    name: 'Hamburg',
    ordnungsamt: 'Bußgeldstelle Hamburg (Behörde für Inneres und Sport)',
    mail: {
      nurJpg: true,
      ohneKarte: true,
      maxAnhangBytes: 10 * 1024 * 1024,
      anschriftImText: true,
      hinweise: [
        'Hamburg nimmt als Anhang nur Beweisfotos im JPG-Format an – die Tatort-Karte geht nicht mit, große Fotos werden auf zusammen höchstens 10 MB verkleinert.',
        'Deine Anschrift steht im Mailtext (Hamburg verlangt eine ladungsfähige Anschrift). Betroffene können sie über eine Akteneinsicht sehen.',
        'Eine Rückmeldung zum Ausgang des Verfahrens gibt die Bußgeldstelle in der Regel nicht.',
      ],
    },
    geo: {
      scope: 'hh',
      // Festland-Stadtgebiet (Neuwerk liegt weit draußen in der Elbmündung).
      bbox: '9.73,53.39,10.33,53.74',
      cityMatch: 'hamburg',
      biasLat: 53.5503,
      biasLon: 9.9925,
      // Hamburg Hauptbahnhof – Default-Kartenmittelpunkt im Formular.
      mapLat: 53.5527,
      mapLon: 10.0067,
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
  return Object.values(CITIES).find(
    (c) => c.name.toLowerCase() === needle || (c.aliases || []).some((a) => a.toLowerCase() === needle)
  )
}

/** Alle freigeschalteten Städte (für Auswahl-Dropdown und Multi-Stadt-Suche). */
export function unlockedCities(): City[] {
  return Object.values(CITIES)
}

/** Wird für die Stadt ein amtliches PDF-Formular erzeugt? Nein bei Städten ohne
 *  Formular (Versand als rohe E-Mail) und bei Portal-Städten (Versand über das
 *  Online-Formular, ein PDF würde dort nur verwirren). */
export function hasPdfForm(city: City): boolean {
  return !!city.pdfForm && !city.portal
}
