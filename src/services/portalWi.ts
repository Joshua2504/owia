// Wiesbaden: ekom21-Formular (gleiche Vorlage wie Frankfurt, oe=00.00.PA.WIOrdA),
// aber anders konfiguriert (Erkundung 10/2026: /root/owia/work/wiesbaden/BERICHT.md):
// - nur EINE Ebene unter der Rubrik, Optionen sind ganze Sätze und nur „parkte"
//   (kein Halten, kein „länger als 1 Stunde", keine Ja/Nein-Fragen)
// - „Sonstiges" mit Pflichtbeschreibung des Tatvorwurfs – dorthin geht alles,
//   was sich nicht eindeutig zuordnen lässt (auch jedes Halten)
// - Feld „Ergänzende Angaben" (≤ 1000 Zeichen), Tatort-Feld ≤ 200 Zeichen
// - Tattag höchstens 2 Monate zurück, heute erlaubt; E-Mail Pflicht.

import mysql from 'mysql2/promise'
import { portalAnrede } from '../config/person'
import { fahrzeugTyp, portalMarke, KENNZEICHEN_LAENDER } from '../config/fahrzeug'
import { verstossText, portalTatzeit, ddmmyyyy, isoOf, PortalDatenFehler, berlinHeute, verstossVarianten } from './portalFfm'

type Ziel = { gruppe: string; satz: string[] }

const SB =
  'Das Fahrzeug parkte auf einem Sonderparkplatz für Schwerbehindert mit außergewöhnlicher Gehbehinderung, beidseitiger Amelie oder Phokomelie, mit vergleichbaren Funktionseinschränkungen sowie für blinde Menschen; mit Zeichen '

const R = {
  rad: 'Radweg/Radfahrstreifen',
  geh: 'Gehweg/Fußgängerüberweg/Fußgängerfurt',
  halt: 'Haltverbot',
  sb: 'Schwerbehindertenparkfläche/Elektrofahrzeuge',
  zufahrt: 'Grundstückszufahrt/Feuerwehrzufahrt',
  flaeche: 'Sperrfläche/verkehrsberuhigter Bereich',
  taxi: 'Taxi/Haltestelle/zweite Reihe',
  sonst: 'Sonstiges',
}

/** Zuordnung Katalogtext (+ Variante) → Rubrik + Satz; null = „Sonstiges".
 *  Nur Parken: Halte-Tatbestände gehen über „Sonstiges" mit dem Katalogtext. */
function zielFuer(text: string, variante: string | null): Ziel | null {
  if (/^Sie hielten\b/.test(text) && !/parkten/.test(text)) return null
  const z = (gruppe: string, ...satz: string[]): Ziel => ({ gruppe, satz })
  if (/Radweg\/Radfahrstreifen \(Zeichen 237\)/.test(text)) return z(R.rad, 'Das Fahrzeug parkte auf einem Radweg (Zeichen 237)')
  if (/(Geh- und Radweg \(Zeichen 240\/241\)|Zeichen 239\/240\/241\/242\.1)/.test(text) && /240/.test(variante || '')) {
    return z(R.rad, 'Das Fahrzeug parkte auf dem gemeinsamen Geh- und Radweg (Zeichen 240)')
  }
  if (/Fußgängerfurt/.test(text)) return z(R.geh, 'Das Fahrzeug parkte auf einer Fußgängerfurt')
  if (/^Sie parkten (länger als 1 Stunde )?auf einem Fußgängerüberweg/.test(text)) return z(R.geh, 'Das Fahrzeug parkte auf dem Fußgängerüberweg')
  if (/parkten (länger als 1 Stunde )?verbotswidrig auf dem Gehweg/.test(text) || (/Zeichen 239\/240\/241\/242\.1/.test(text) && /239/.test(variante || ''))) {
    return z(R.geh, 'Das Fahrzeug parkte verbotswidrig auf dem Gehweg')
  }
  if (/eingeschränkten Haltverbot \(Zeichen 286\)\.?( und|$)/.test(text) && !/Bewohner/.test(text)) return z(R.halt, 'Das Fahrzeug parkte unzulässig im eingeschränkten Haltverbot (Zeichen 286)')
  if (/absoluten Haltverbot \(Zeichen 283\)/.test(text)) return z(R.halt, 'Das Fahrzeug parkte im absoluten Haltverbot (Zeichen 283)')
  if (/Sonderparkplatz für Schwerbehinderte/.test(text)) {
    // Beide Optionen unterscheiden sich erst am Ende – voller Präfix bis zur Zeichennummer.
    if (/314/.test(variante || '')) return z(R.sb, SB + '314')
    if (/315/.test(variante || '')) return z(R.sb, SB + '315')
    return null
  }
  if (/Parkplatz für elektrisch betriebene Fahrzeuge/.test(text) && /314/.test(variante || '')) {
    return z(R.sb, 'Das Fahrzeug parkte auf einem Parkplatz (Zeichen 314), obwohl dies durch Zusatzzeichen "Elektrofahrzeuge')
  }
  if (/parkten (verbotswidrig )?vor oder in einer amtlich gekennzeichneten Feuerwehrzufahrt/.test(text)) return z(R.zufahrt, 'Das Fahrzeug parkte vor oder in einer amtlich gekennzeichneten Feuerwehrzufahrt')
  if (/im Bereich einer Grundstücksein- bzw\. -ausfahrt/.test(text)) return z(R.zufahrt, 'Das Fahrzeug parkte im Bereich einer Grundstücksein')
  // Tippfehler im Portal („Fahrzeugt") – beide Schreibweisen zulassen.
  if (/Sperrfläche \(Zeichen 298\)/.test(text)) return z(R.flaeche, 'Das Fahrzeugt parkte auf einer Sperrfläche', 'Das Fahrzeug parkte auf einer Sperrfläche')
  if (/verkehrsberuhigten Bereich/.test(text)) return z(R.flaeche, 'Das Fahrzeug parkte in einem verkehrsberuhigten Bereich')
  if (/Taxenstandes/.test(text)) return z(R.taxi, 'Das Fahrzeug parkte auf einem Sonderparkplatz für Taxen')
  if (/Haltestellenschild \(Zeichen 224\)/.test(text)) return z(R.taxi, 'Das Fahrzeug parkte im Bereich einer Haltestelle')
  if (/parkten (länger als 15 Minuten )?unzulässig in der zweiten Reihe/.test(text)) return z(R.taxi, 'Parken in der zweiten Reihe')
  return null
}

export function wiTatbestand(label: string | null | undefined, variante?: string | null) {
  const text = verstossText(label || '')
  return zielFuer(text, variante ?? null)
}

export function wiProblem(r: Record<string, any>): string | null {
  // Wiesbaden nimmt nur Taten der letzten zwei Monate an.
  const tag = isoOf(r.tattag)
  if (tag) {
    const grenze = new Date(berlinHeute())
    grenze.setMonth(grenze.getMonth() - 2)
    if (tag < grenze.toISOString().slice(0, 10)) return 'Wiesbaden nimmt nur Taten der letzten zwei Monate an.'
  }
  if (r.kennzeichen_land && !KENNZEICHEN_LAENDER[String(r.kennzeichen_land).toUpperCase()]) {
    return `Das Länderkennzeichen „${r.kennzeichen_land}" kennt das Portal der Stadt nicht.`
  }
  return null
}

export function buildWiPayload(r: mysql.RowDataPacket, u: mysql.RowDataPacket, letztesFoto?: string | null) {
  const ziel = wiTatbestand(r.verstoss_art, r.verstoss_variante)
  const land = KENNZEICHEN_LAENDER[String(r.kennzeichen_land || 'D').toUpperCase()]
  if (!land) throw new PortalDatenFehler(`Das Länderkennzeichen „${r.kennzeichen_land}" kennt das Portal nicht.`)
  if (!u.hausnummer) throw new PortalDatenFehler('Im Profil fehlt die Hausnummer.')
  if (!u.email) throw new PortalDatenFehler('Wiesbaden verlangt eine E-Mail-Adresse.')
  const zeit = portalTatzeit(r, letztesFoto)
  const katalog = String(r.verstoss_art || '').trim()
  const variante = r.verstoss_variante ? ` (genauer: ${r.verstoss_variante})` : ''
  const behindert = r.behinderung === 1 || /behinderten|behindert wurden/.test(katalog)
  const behinderungText = String(r.behinderung_text || '').trim()
  const pfad = ziel ? [{ pick: ziel.satz }] : []
  const ergaenzend = [
    `Tatbestand laut Katalog: ${katalog}${variante}.`,
    behindert ? `Behinderung: ${behinderungText || 'Andere Verkehrsteilnehmer wurden behindert (siehe Beweisfotos).'}` : '',
    r.fahrzeug_verlassen === 1 ? 'Das Fahrzeug war verlassen.' : '',
    zeit.zusatz ? `${zeit.zusatz}.` : '',
    String(r.beschreibung || '').replace(/\s+/g, ' ').trim(),
  ].filter(Boolean).join(' ')
  return {
    portal: 'ekom21-wi',
    person: {
      anrede: portalAnrede(u.anrede),
      name: u.nachname || '', vorname: u.vorname || '', plz: u.plz || '', ort: u.ort || '',
      strasse: u.strasse || '', nr: u.hausnummer || '', telefon: u.telefon || '',
    },
    gruppe: ziel ? ziel.gruppe : R.sonst,
    pfad,
    tatvorwurf: ziel ? '' : `${katalog}${variante}`.slice(0, 1600),
    behinderung: { ja: behindert, rettung: false, text: behinderungText },
    fahrzeug: {
      typ: fahrzeugTyp(r.fahrzeug_typ), land, kennzeichen: r.kennzeichen || '',
      marke: portalMarke(r.fahrzeug_marke) ?? (r.fahrzeug_marke ? String(r.fahrzeug_marke) : null),
      modell: String(r.fahrzeug_modell || '').trim(), farbe: String(r.fahrzeug_farbe || '').trim(),
    },
    // Tatort ohne PLZ/Ort (Ort/Gemarkung ist mit „Wiesbaden" vorbelegt), ≤ 200 Zeichen.
    tat: { ort: String(r.tatort || '').replace(/,\s*\d{5}\s+[^,]+$/, '').trim().slice(0, 200), tattag: ddmmyyyy(r.tattag), von: zeit.von, bis: zeit.bis },
    email: u.email,
    ergaenzend: ergaenzend.slice(0, 1000),
  }
}

export { verstossVarianten }
