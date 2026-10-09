// Hamburg: „Ordnungswidrigkeit im Straßenverkehr anzeigen" im Serviceportal
// (IntelliForm auf am.hamburg.de, Bußgeldstelle der Behörde für Inneres und
// Sport). Die Bußgeldstelle bittet in ihrer automatischen Antwort auf Mail-
// Anzeigen ausdrücklich um den Online-Dienst („schneller geprüft und verfolgt");
// seit 2026-10-09 geht Hamburg deshalb über das Formular (Nutzerentscheidung).
// Erkundet 2026-10-09 bis zur Zusammenfassung, nie abgesendet:
// - ohne Anmeldung, kein Captcha; Seiten: Optionale Anmeldung → Datenschutz →
//   Rechtliche Hinweise (ein Häkchen, u.a. „persönlich betroffen") →
//   Persönliche Angaben (Meldeanschrift, wird gegen ein Adressregister geprüft –
//   auch auswärtige Anschriften, Vorschlag bei Abweichung) → Tatzeit und Tatort
//   (Straße nur aus der Vorschlagsliste, Hausnummer ODER kreuzende Straße,
//   PLZ optional, nur 2xxxx) → Fahrzeug und Tatbestand (Typ-Liste, 5 häufige
//   Tatvorwürfe als Radio, sonst Liste mit 19 weiteren + „keiner", Freitext
//   „Kurze Schilderung des Sachverhalts") → Beweisfotos (höchstens 3, JPG/PNG,
//   je 5 MB, Häkchen „keine Dritten") → Zusammenfassung mit Amts-PDF und
//   optionaler Sendebestätigung per Mail → „Weiter" reicht ein.
// Formular-Profil im Portal-Dienst: docker/portal/hamburg.mjs.

import mysql from 'mysql2/promise'
import { fahrzeugTyp } from '../config/fahrzeug'
import { verstossText, portalTatzeit, ddmmyyyy, PortalDatenFehler, photoRoles } from './portalFfm'
import { tatortTeile, mzFotos } from './portalMz'

/** Tatvorwürfe des Formulars (Stand 10/2026): 1–5 sind Radio-Buttons, 6–24 die
 *  Liste hinter „Keinen dieser Tatvorwürfe", 25 = „keiner der aufgeführten".
 *  Texte wie im Formular, nur ohne spitze Klammern (wie der Katalog nach
 *  cleanTatbestand). Verglichen wird nach normalisieren() – Dauerzusätze
 *  („länger als 1 Stunde") und Folgen („und behinderten dadurch Andere") fallen
 *  weg, die Behinderung geht als Häkchen mit. */
export const HH_TATVORWUERFE: { wert: string; text: string }[] = [
  { wert: '1', text: 'Sie parkten verbotswidrig auf dem Gehweg' },
  { wert: '2', text: 'Sie parkten auf einem Straßenteil, der weder durch Zeichen 315 noch durch eine Parkflächenmarkierung zum Parken freigegeben war' },
  { wert: '3', text: 'Sie parkten im absoluten Haltverbot (Zeichen 283)' },
  { wert: '4', text: 'Sie parkten weniger als 5 Meter vor der Kreuzung/Einmündung' },
  { wert: '5', text: 'Sie benutzten die Sperrfläche (Zeichen 298) zum Parken' },
  { wert: '6', text: 'Sie parkten auf einem Radweg/Radfahrstreifen (Zeichen 237)' },
  { wert: '7', text: 'Sie parkten in einem verkehrsberuhigten Bereich (Zeichen 325.1, 325.2) verbotswidrig außerhalb der zum Parken gekennzeichneten Flächen' },
  { wert: '8', text: 'Sie parkten vor einer Bordsteinabsenkung' },
  { wert: '9', text: 'Sie parkten auf einem unbeschilderten Radweg' },
  { wert: '10', text: 'Sie hielten auf einem Radweg/Radfahrstreifen (Zeichen 237)' },
  { wert: '11', text: 'Sie parkten vor oder in einer amtlich gekennzeichneten Feuerwehrzufahrt' },
  { wert: '12', text: 'Sie parkten unzulässig im eingeschränkten Haltverbot (Zeichen 286)' },
  { wert: '13', text: 'Sie parkten innerhalb einer Grenzmarkierung (Zeichen 299) für ein Haltverbot' },
  { wert: '14', text: 'Sie parkten im Bereich einer Grundstücksein- bzw. -ausfahrt' },
  { wert: '15', text: 'Sie parkten verbotswidrig auf der linken Fahrbahnseite/dem linken Seitenstreifen' },
  { wert: '16', text: 'Sie parkten in einem Abstand von weniger als 5 Metern vor einem Fußgängerüberweg' },
  { wert: '17', text: 'Sie parkten unberechtigt auf einem Parkplatz für elektrisch betriebene Fahrzeuge (Zeichen 314/315) mit Zusatzzeichen' },
  { wert: '18', text: 'Sie parkten unzulässig in der zweiten Reihe' },
  { wert: '19', text: 'Sie parkten in einem Abstand von weniger als 15 Metern von einem Haltestellenschild (Zeichen 224)' },
  { wert: '20', text: 'Sie parkten auf einem Sonderparkplatz für Schwerbehinderte mit außergewöhnlicher Gehbehinderung, beidseitiger Amelie oder Phokomelie, mit vergleichbaren Funktionseinschränkungen sowie für blinde Menschen (Zeichen 314/315 und Zusatzzeichen mit Rollstuhlfahrersinnbild). Ein besonderer Parkausweis lag nicht gut lesbar aus' },
  { wert: '21', text: 'Sie parkten innerhalb einer Grenzmarkierung (Zeichen 299) für ein Parkverbot' },
  { wert: '22', text: 'Sie hielten verbotswidrig auf einem Schutzstreifen für den Radverkehr (Zeichen 340)' },
  { wert: '23', text: 'Sie parkten unzulässig teilweise im absoluten Haltverbot (Zeichen 283) und teilweise auf dem Gehweg, auf dem es weder durch Zeichen 315 noch durch eine Parkflächenmarkierung erlaubt war' },
  { wert: '24', text: 'Sie parkten weniger als 5 Meter hinter der Kreuzung/Einmündung' },
]
export const HH_KEINER = '25'
const RADIOS = new Set(['1', '2', '3', '4', '5'])

/** Katalog- und Formulartext auf einen gemeinsamen Nenner bringen. */
function normalisieren(text: string): string {
  return text
    .replace(/<([^>]*)>/g, '$1')
    .replace(/\s*\+\)/g, '')
    .replace(/\s*länger als \d+ (Stunden?|Minuten)\s*/g, ' ')
    .replace(/\s*und (behinderten|gefährdeten) dadurch (Andere|ein Rettungsfahrzeug im Einsatz)/g, '')
    .replace(/\.\s*Es kam zum Unfall/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim()
    .toLowerCase()
}

export interface HhTatbestand {
  /** Radio „input.tatbestand_1": '1'–'5' oder 'keine'. */
  radio: string
  /** Liste „input.tatbestand_2" (nur bei radio='keine'): '6'–'25'. */
  liste: string | null
  /** Formulartext des gewählten Tatvorwurfs (null = „keiner", Sachverhalt trägt). */
  text: string | null
}

/** Katalogtext → Tatvorwurf des Formulars; ohne Treffer „keiner der aufgeführten
 *  Tatvorwürfe" – der Katalogtext steht dann im Sachverhalt. */
export function hhTatbestand(label: string | null | undefined): HhTatbestand {
  const text = normalisieren(verstossText(label || ''))
  const treffer = text ? HH_TATVORWUERFE.find((o) => normalisieren(o.text) === text) : undefined
  if (!treffer) return { radio: 'keine', liste: HH_KEINER, text: null }
  return RADIOS.has(treffer.wert)
    ? { radio: treffer.wert, liste: null, text: treffer.text }
    : { radio: 'keine', liste: treffer.wert, text: treffer.text }
}

/** Kennzeichen wie der Platzhalter des Formulars („XY-BB 123"); was nicht ins
 *  deutsche Schema passt (Ausland, Sonderkennzeichen), bleibt wie eingegeben. */
export function hhKennzeichen(kz: string | null | undefined): string {
  const s = String(kz || '').toUpperCase().replace(/\s+/g, ' ').trim()
  // Ohne Trenner zwischen Kreis und Buchstaben wäre die Zerlegung mehrdeutig
  // („HHAB123") – dann unverändert lassen.
  const m = /^([A-ZÄÖÜ]{1,3})[- ]+([A-Z]{1,2})[- ]?(\d{1,4}) ?([EH])?$/.exec(s)
  return m ? `${m[1]}-${m[2]} ${m[3]}${m[4] || ''}` : s
}

/** Hamburger Postleitzahlen laut Feldmuster des Formulars (20xxx–22xxx, Neuwerk 27499). */
export function hhPlz(plz: string | null | undefined): string {
  const p = String(plz || '').trim()
  return /^(2[012]\d{3}|27499)$/.test(p) ? p : ''
}

export interface HhTatort {
  strasse: string
  /** Hausnummer oder kreuzende Straße („Hausnummer oder kreuzende Straße"). */
  hausnummer: string
  plz: string
  /** „Zusätzliche Angaben zum Tatort": alles, was in Straße/Nummer nicht passt. */
  angaben: string
}

/** Tatort „Straße Nr, PLZ Ort" zerlegen. Ohne Hausnummer bleibt das Feld leer
 *  und die ursprüngliche Angabe wandert in die Zusatzangaben; „Ecke …"/„/" wird
 *  als kreuzende Straße eingetragen. */
export function hhTatort(tatort: string | null | undefined): HhTatort | null {
  const roh = String(tatort || '').replace(/\s+/g, ' ').trim()
  if (!roh) return null
  const teile = tatortTeile(roh)
  let strasse = teile ? teile.strasse : roh.split(',')[0].trim()
  let hausnummer = teile?.hausnummer || ''
  const plz = hhPlz(teile?.plz)
  if (!hausnummer) {
    // „Hammer Straße / Ecke Hammer Landstraße", „A-Straße Ecke B-Straße"
    const ecke = /^(.*?)\s*(?:\/|\bEcke\b)\s*(.+)$/i.exec(strasse)
    if (ecke && ecke[1].trim() && ecke[2].trim()) {
      strasse = ecke[1].trim()
      hausnummer = ecke[2].replace(/^Ecke\s+/i, '').trim()
    }
  }
  const angaben = hausnummer && teile ? '' : `Angabe laut Anzeige: ${roh}`
  return { strasse, hausnummer, plz, angaben }
}

// Typen der App (config/fahrzeug.ts, Frankfurter Liste) → Hamburger Liste.
const HH_TYP: Record<string, string> = { Elektrokleinstfahrzeug: 'Elektrokleinstfahrzeuge' }

export function hhProblem(r: Record<string, any>, u?: Record<string, any> | null): string | null {
  if (!hhTatort(r.tatort)?.strasse) return 'Der Tatort braucht mindestens die Straße (Adresse aus der Vorschlagsliste wählen).'
  if (u && !String(u.email || '').trim()) return 'Hamburg verlangt eine E-Mail-Adresse.'
  return null
}

export function buildHhPayload(r: mysql.RowDataPacket, u: mysql.RowDataPacket, letztesFoto?: string | null) {
  const tatort = hhTatort(r.tatort)
  if (!tatort) throw new PortalDatenFehler('Der Tatort fehlt.')
  if (!u.hausnummer) throw new PortalDatenFehler('Im Profil fehlt die Hausnummer.')
  const zeit = portalTatzeit(r, letztesFoto)
  const katalog = String(r.verstoss_art || '').trim()
  const tb = hhTatbestand(katalog)
  const behindert = r.behinderung === 1 || /behinderten|behindert wurden|gefährdeten/.test(katalog)
  const behinderungText = String(r.behinderung_text || '').trim()
  const sachverhalt = [
    `Tatbestand laut Bußgeldkatalog: ${katalog}${r.verstoss_variante ? ` (genauer: ${r.verstoss_variante})` : ''}.`,
    r.fahrzeug_verlassen === 1 ? 'Das Fahrzeug war verlassen.' : '',
    zeit.zusatz ? `${zeit.zusatz}.` : '',
    behindert ? `Behinderung: ${behinderungText || 'Andere Verkehrsteilnehmer wurden behindert (siehe Beweisfotos).'}` : '',
    String(r.beschreibung || '').replace(/\s+/g, ' ').trim(),
  ].filter(Boolean).join(' ').replace(/\.\./g, '.')
  const typ = fahrzeugTyp(r.fahrzeug_typ)
  return {
    portal: 'intelliform-hh',
    person: {
      vorname: u.vorname || '', nachname: u.nachname || '',
      strasse: u.strasse || '', hausnummer: u.hausnummer || '', plz: u.plz || '', ort: u.ort || '',
      email: String(u.email || '').trim(),
    },
    tat: {
      datum: ddmmyyyy(r.tattag), von: zeit.von, bis: zeit.bis && zeit.bis !== zeit.von ? zeit.bis : '',
      strasse: tatort.strasse, hausnummer: tatort.hausnummer, plz: tatort.plz, angaben: tatort.angaben,
    },
    fahrzeug: {
      typ: HH_TYP[typ] ?? typ,
      kennzeichen: hhKennzeichen(r.kennzeichen),
      marke: [r.fahrzeug_marke, r.fahrzeug_modell].map((x) => String(x || '').trim()).filter(Boolean).join(' '),
      farbe: String(r.fahrzeug_farbe || '').trim(),
    },
    tatbestand: { radio: tb.radio, liste: tb.liste, behinderung: behindert, sachverhalt: sachverhalt.slice(0, 2000) },
    // Sendebestätigung des Portals an die anzeigende Person (optional im Formular).
    bestaetigungEmail: String(u.email || '').trim(),
  }
}

/** Höchstens 3 Fotos, Fahrzeugfoto zuerst (Kennzeichen), dann Übersicht. */
export function hhFotos<T>(imgs: T[]): { uebersicht: T[]; fahrzeug: T[] } {
  return { uebersicht: mzFotos(photoRoles(imgs)), fahrzeug: [] }
}
