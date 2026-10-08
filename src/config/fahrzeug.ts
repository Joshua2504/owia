// Fahrzeugangaben einer Anzeige: Typ, Marke, Modell, Farbe getrennt (seit
// Migration 0039). Die Listen entsprechen den Auswahllisten im ekom21-Portal
// der Stadt Frankfurt (Stand 10/2026, docker/portal/ekom21.mjs) – der Portal-
// Versand wählt dort genau diese Texte aus. Eingabe in der App bleibt bei Marke
// und Farbe frei (Vorschlagsliste), der Typ ist eine feste Auswahl.

/** Fahrzeugtypen wie im Portal. NULL in der DB bedeutet PKW. */
export const FAHRZEUG_TYPEN = [
  'PKW',
  'PKW mit Anhänger',
  'LKW',
  'LKW mit Anhänger',
  'Wohnmobil',
  'Wohnmobil mit Anhänger',
  'Kraftrad',
  'Kraftrad mit Anhänger',
  'Kraftroller',
  'Leichtkraftrad',
  'Leichtkraftfahrzeug',
  'Mofa',
  'Elektrokleinstfahrzeug',
  'Kraftomnibus',
  'Kraftomnibus mit Anhänger',
  'Kraftomnibus mit Fahrgästen',
  'Anhänger',
  'Sattelzugmaschine',
  'Sattelzuganhänger',
] as const

export const DEFAULT_FAHRZEUG_TYP = 'PKW'

/** Marken der Portal-Auswahl. */
export const FAHRZEUG_MARKEN = [
  'Alfa Lancia', 'Alfa Romeo', 'Aston Martin', 'Audi', 'Austin', 'BMW', 'Bugatti', 'Chevrolet', 'Chrysler',
  'Citroën', 'Dacia', 'Daewoo', 'DAF', 'Daihatsu', 'Delta Motor', 'Ferrari', 'Fiat', 'Ford', 'General Motors',
  'Harley-Davidson', 'Honda', 'Husqvarna', 'Hyundai', 'Isuzu', 'Iveco', 'Jaguar', 'Jeep', 'Kässbohrer',
  'Kawasaki', 'Kia', 'Lamborghini', 'Lancia', 'MAN', 'Maserati', 'Mazda', 'mbk', 'Mercedes-Benz', 'MG',
  'Mitsubishi', 'Moto Guzzi', 'Nissan', 'Opel', 'Peugeot', 'Piaggio', 'Pontiac', 'Porsche', 'Renault',
  'Rolls-Royce', 'Rover', 'Saab', 'Samsung', 'Scania', 'Seat', 'Skoda', 'Smart', 'Subaru', 'Suzuki', 'Tesla',
  'Toyota', 'Vespa', 'Volvo', 'Volkswagen', 'Yamaha',
]

/** Gängige Kurzformen → Portal-Marke. Schlüssel kleingeschrieben, ohne Sonderzeichen. */
const MARKEN_ALIASE: Record<string, string> = {
  vw: 'Volkswagen',
  volkswagen: 'Volkswagen',
  mercedes: 'Mercedes-Benz',
  mercedesbenz: 'Mercedes-Benz',
  benz: 'Mercedes-Benz',
  mb: 'Mercedes-Benz',
  citroen: 'Citroën',
  skoda: 'Skoda',
  škoda: 'Skoda',
  seat: 'Seat',
  cupra: 'Seat',
  alfa: 'Alfa Romeo',
  harley: 'Harley-Davidson',
  rollsroyce: 'Rolls-Royce',
  landrover: 'Rover',
  gm: 'General Motors',
}

const key = (s: string) => s.toLowerCase().normalize('NFC').replace(/[^a-z0-9äöüßéëš]/g, '')

/** Freitext-Marke auf einen Eintrag der Portal-Liste abbilden; `null`, wenn
 *  sie dort nicht vorkommt (der Versand nimmt dann „Sonstiges" + Text als Modell). */
export function portalMarke(marke: string | null | undefined): string | null {
  const m = String(marke ?? '').trim()
  if (!m) return null
  const k = key(m)
  if (MARKEN_ALIASE[k]) return MARKEN_ALIASE[k]
  const exact = FAHRZEUG_MARKEN.find((x) => key(x) === k)
  if (exact) return exact
  // „VW Golf" → erstes Wort als Marke
  const first = key(m.split(/\s+/)[0])
  return MARKEN_ALIASE[first] || FAHRZEUG_MARKEN.find((x) => key(x) === first) || null
}

/** Vorschläge fürs Farbfeld (frei editierbar). */
export const FAHRZEUG_FARBEN = [
  'schwarz', 'weiß', 'silber', 'grau', 'blau', 'rot', 'grün', 'gelb', 'orange', 'braun', 'beige', 'gold', 'violett',
]

/** Länderkennzeichen (Unterscheidungszeichen, wie reports.kennzeichen_land) →
 *  Länderliste des Portals. Fehlt ein Land, kann es im Portal nicht gewählt werden. */
export const KENNZEICHEN_LAENDER: Record<string, string> = {
  D: 'Deutschland', B: 'Belgien', BG: 'Bulgarien', DK: 'Dänemark', EST: 'Estland', FIN: 'Finnland',
  F: 'Frankreich', GR: 'Griechenland', IRL: 'Irland', IS: 'Island', I: 'Italien', HR: 'Kroatien', LV: 'Lettland',
  FL: 'Liechtenstein', LT: 'Litauen', L: 'Luxemburg', M: 'Malta', NL: 'Niederlande', N: 'Norwegen',
  A: 'Österreich', PL: 'Polen', P: 'Portugal', RO: 'Rumänien', S: 'Schweden', CH: 'Schweiz',
  SK: 'Slowakische Republik', SLO: 'Slowenien', E: 'Spanien', CZ: 'Tschechien', H: 'Ungarn', CY: 'Zypern',
}

/** Typ zum Anzeigen/Versenden (NULL/unbekannt ⇒ PKW). */
export function fahrzeugTyp(typ: string | null | undefined): string {
  return typ && (FAHRZEUG_TYPEN as readonly string[]).includes(typ) ? typ : DEFAULT_FAHRZEUG_TYP
}

/** Eine Zeile für PDF, Mails und Ansichten: „PKW, VW Golf, schwarz". Der Typ
 *  steht nur da, wenn er ausdrücklich gesetzt ist (Bestand hat keinen). */
// Parameter bewusst lose typisiert: Aufrufer reichen mysql2-RowDataPackets durch.
export function fahrzeugBeschreibung(r: Record<string, any>): string {
  const markeModell = [r.fahrzeug_marke, r.fahrzeug_modell].map((x) => (x || '').trim()).filter(Boolean).join(' ')
  return [r.fahrzeug_typ || '', markeModell, (r.fahrzeug_farbe || '').trim()].filter(Boolean).join(', ')
}
