// Frankfurt: Abbildung einer Anzeige auf das ekom21-Portal „Anzeige einer
// Verkehrsordnungswidrigkeit" (docker/portal/ekom21.mjs füllt es aus).
//
// Der Tatbestand wird im Portal nicht per TBNR gewählt, sondern über einen
// Auswahlbaum: Rubrik → (Halten/Parken/Parken länger als 1 Stunde) → Stelle →
// ggf. „Wurden Sie behindert?". Die Regeln unten leiten diesen Pfad aus dem
// Katalogtext (resources/verstoesse.csv) ab. Wo der Katalog Alternativen offen
// lässt („Kreuzung/Einmündung", „Zeichen 240/241"), wählt der Nutzer eine
// Variante (reports.verstoss_variante) – ohne sie fragt der Versand live nach.
//
// Pfad-Elemente (Optionen werden im Portal per Präfix verglichen):
//   { pick: [a, b] }  erste vorhandene Option wählen (Rangfolge)
//   { ask: [a, b] }   eindeutig nur mit Variante, sonst fragt der Lauf live
//   optional          fehlt die Frage im Portal, überspringen
// Stand des Portal-Baums: 10/2026 (alle 8 Rubriken durchgespielt).

import mysql from 'mysql2/promise'
import { tbnrAusLabel, VERSTOESSE } from '../config/verstoss'
import { portalAnrede } from '../config/person'
import { fahrzeugTyp, portalMarke, KENNZEICHEN_LAENDER } from '../config/fahrzeug'

export type PathEl = { pick?: string[]; ask?: string[]; optional?: boolean; hint?: string; manual?: boolean }

export interface PortalTatbestand {
  gruppe: string
  pfad: PathEl[]
  /** Frage „Wurde ein Rettungsfahrzeug im Einsatz behindert?" (Feuerwehrzufahrt). */
  rettung?: boolean
}

export interface Variante {
  /** Gespeicherter Wert in reports.verstoss_variante (auch im PDF lesbar). */
  value: string
  /** Optionstext im Portal. */
  portal: string
}

export const RUBRIK = {
  radweg: 'Radweg/Radfahrstreifen',
  gehweg: 'Gehweg/Fußgängerüberweg/Fußgängerfurt',
  haltverbot: 'Haltverbot/gesperrter Bereich/Sonderparkplätze',
  links: 'Einbahnstraße/linke Fahrbahnseite/linker Seitenstreifen',
  flaechen: 'Grünstreifen/Verkehrsinsel/Sperrfläche/Grenzmarkierung/verkehrsberuhigter Bereich',
  feuerwehr: 'Feuerwehrzufahrt',
  taxi: 'Taxi/Haltestellen/zweite Reihe',
  bordstein: 'Bordsteinabsenkung/Grundstückszufahrten/Kreuzungen und Einmündungen',
} as const

interface Regel {
  re: RegExp
  gruppe: string
  /** Pfad; `aktion` wird durch Halten/Parken/länger als 1 Stunde ersetzt. */
  pfad: (aktion: PathEl) => PathEl[]
  varianten?: Variante[]
  rettung?: (text: string) => boolean
}

const v = (value: string, portal: string): Variante => ({ value, portal })

/** Halten / Parken / Parken länger als 1 Stunde – aus dem Katalogtext. Fehlt im
 *  Portal die Stufe „länger als 1 Stunde", wird „Parken" genommen. */
function aktionAus(text: string): PathEl {
  if (/länger als 1 Stunde/.test(text)) return { pick: ['Parken länger als 1 Stunde', 'Parken'] }
  if (/^Sie hielten\b/.test(text) && !/parkten/.test(text)) return { pick: ['Halten'] }
  return { pick: ['Parken'] }
}

// Reihenfolge zählt: spezifische Regeln vor allgemeinen.
const REGELN: Regel[] = [
  // --- Radweg -----------------------------------------------------------------
  { re: /Radweg\/Radfahrstreifen \(Zeichen 237\)/, gruppe: RUBRIK.radweg, pfad: (a) => [a, { pick: ['auf einem Radweg (Zeichen 237)'] }] },
  {
    re: /Geh- und Radweg \(Zeichen 240\/241\)/,
    gruppe: RUBRIK.radweg,
    pfad: (a) => [a, { ask: ['auf einem gemeinsamen Geh- und Radweg (Zeichen 240)', 'auf einem getrennten Geh- und Radweg (Zeichen 241)'] }],
    varianten: [
      v('gemeinsamer Geh- und Radweg (Zeichen 240)', 'auf einem gemeinsamen Geh- und Radweg (Zeichen 240)'),
      v('getrennter Geh- und Radweg (Zeichen 241)', 'auf einem getrennten Geh- und Radweg (Zeichen 241)'),
    ],
  },
  { re: /Fahrradstraße/, gruppe: RUBRIK.radweg, pfad: (a) => [a, { pick: ['auf einer Fahrradstraße'] }] },
  { re: /Schutzstreifen/, gruppe: RUBRIK.radweg, pfad: (a) => [a, { pick: ['verbotswidrig auf einem Schutzstreifen'] }] },

  // --- Gehweg / Fußgänger -----------------------------------------------------
  {
    re: /durch Zeichen 239\/240\/241\/242\.1 gesperrt/,
    gruppe: RUBRIK.gehweg,
    pfad: (a) => [a, { ask: ['auf dem Gehweg (Zeichen 239)', 'auf einem gemeinsamen Geh- und Radweg (Zeichen 240)', 'auf einem getrennten Geh- und Radweg (Zeichen 241)', 'im Bereich einer Fußgängerzone (Zeichen 242.1)'] }],
    varianten: [
      v('Gehweg (Zeichen 239)', 'auf dem Gehweg (Zeichen 239)'),
      v('gemeinsamer Geh- und Radweg (Zeichen 240)', 'auf einem gemeinsamen Geh- und Radweg (Zeichen 240)'),
      v('getrennter Geh- und Radweg (Zeichen 241)', 'auf einem getrennten Geh- und Radweg (Zeichen 241)'),
      v('Fußgängerzone (Zeichen 242.1)', 'im Bereich einer Fußgängerzone (Zeichen 242.1)'),
    ],
  },
  { re: /Gehwegparken \(Zeichen 315\)/, gruppe: RUBRIK.gehweg, pfad: (a) => [a, { pick: ['auf einem Gehweg entgegen der durch Zeichen 315'] }] },
  { re: /Fußgängerfurt/, gruppe: RUBRIK.gehweg, pfad: () => [{ pick: ['Parken'] }, { pick: ['auf einer Fußgängerfurt'] }] },
  { re: /weniger als 5 Metern vor einem Fußgängerüberweg/, gruppe: RUBRIK.gehweg, pfad: (a) => [a, { pick: ['Abstand von weniger als 5 Metern vor einem Fußgängerüberweg'] }] },
  { re: /Fußgängerüberweg/, gruppe: RUBRIK.gehweg, pfad: (a) => [a, { pick: ['auf dem Fußgängerüberweg'] }] },
  // „Parken länger als 1 Stunde" ist im Portal schon die vollständige Option
  // („… verbotswidrig auf dem Gehweg"), daher die Stelle optional.
  { re: /(verbotswidrig )?auf dem Gehweg\b(?!,)/, gruppe: RUBRIK.gehweg, pfad: (a) => [a, { pick: ['verbotswidrig auf dem Gehweg'], optional: true }] },

  // --- Haltverbot / gesperrt / Sonderparkplätze ------------------------------
  {
    re: /Bewohner mit Parkausweis frei/,
    gruppe: RUBRIK.haltverbot,
    pfad: () => [{ pick: ['auf einem Sonderparkplatz für Bewohner'] }, { ask: ['(Zeichen 286) mit Zusatzzeichen', '(Zeichen 290) mit Zusatzzeichen'] }],
    varianten: [v('eingeschränktes Haltverbot (Zeichen 286)', '(Zeichen 286) mit Zusatzzeichen'), v('Zonenhaltverbot (Zeichen 290)', '(Zeichen 290) mit Zusatzzeichen')],
  },
  { re: /absoluten Haltverbot \(Zeichen 283\)/, gruppe: RUBRIK.haltverbot, pfad: (a) => [{ pick: ['im Haltverbot'] }, { pick: ['im absoluten Haltverbot (Zeichen 283)'] }, a] },
  { re: /eingeschränkten Haltverbot \(Zeichen 286\)/, gruppe: RUBRIK.haltverbot, pfad: (a) => [{ pick: ['im Haltverbot'] }, { pick: ['unzulässig im eingeschränkten Haltverbot (Zeichen 286)'] }, a] },
  { re: /Haltverbot für eine Zone/, gruppe: RUBRIK.haltverbot, pfad: (a) => [{ pick: ['im Haltverbot'] }, { pick: ['im eingeschränkten Haltverbot für eine Zone (Zeichen 290)'] }, a] },
  {
    re: /durch Zeichen 250\/251\/253\/255\/260 gesperrt/,
    gruppe: RUBRIK.haltverbot,
    pfad: () => [{ pick: ['in einem gesperrten Verkehrsbereich'] }, { ask: ['der durch Zeichen 250', 'der durch Zeichen 251', 'der durch Zeichen 253', 'der durch Zeichen 255', 'der durch Zeichen 260'] }],
    varianten: ['250', '251', '253', '255', '260'].map((z) => v(`Zeichen ${z}`, `der durch Zeichen ${z}`)),
  },

  ...(['Elektrofahrzeuge', 'Carsharing', 'Schwerbehinderte'] as const).map((art): Regel => ({
    re: { Elektrofahrzeuge: /Parkplatz für elektrisch betriebene Fahrzeuge/, Carsharing: /Parkplatz für Carsharingfahrzeuge/, Schwerbehinderte: /Sonderparkplatz für Schwerbehinderte/ }[art],
    gruppe: RUBRIK.haltverbot,
    pfad: () => [{ pick: [`auf einem Sonderparkplatz für ${art}`] }, { ask: ['unberechtigt auf einem Parkplatz bei Zeichen 314', 'unberechtigt auf einem Parkplatz bei Zeichen 315'] }],
    varianten: [v('Parkplatz (Zeichen 314)', 'unberechtigt auf einem Parkplatz bei Zeichen 314'), v('Parken auf Gehwegen (Zeichen 315)', 'unberechtigt auf einem Parkplatz bei Zeichen 315')],
  })),
  {
    re: /Parkplatz \(Zeichen 314\), obwohl dies durch Zusatzzeichen/,
    gruppe: RUBRIK.haltverbot,
    pfad: () => [{ pick: ['auf einem Parkplatz (Zeichen 314), obwohl'] }, { ask: ['nur PKW', 'nur Wohmobile', 'nur LKW'] }],
    varianten: [v('Zusatzzeichen nur PKW', 'nur PKW'), v('Zusatzzeichen nur Wohnmobile', 'nur Wohmobile'), v('Zusatzzeichen nur LKW', 'nur LKW')],
  },

  // --- Einbahnstraße / links --------------------------------------------------
  { re: /Einbahnstraße entgegen der Fahrtrichtung/, gruppe: RUBRIK.links, pfad: () => [{ pick: ['in der Einbahnstraße entgegen der Fahrtrichtung'] }] },
  {
    re: /linken Fahrbahnseite\/dem linken Seitenstreifen/,
    gruppe: RUBRIK.links,
    pfad: () => [{ ask: ['verbotswidrig auf der linken Fahrbahnseite', 'verbotswidrig auf dem linken Seitenstreifen'] }],
    varianten: [v('linke Fahrbahnseite', 'verbotswidrig auf der linken Fahrbahnseite'), v('linker Seitenstreifen', 'verbotswidrig auf dem linken Seitenstreifen')],
  },

  // --- Flächen / Markierungen -------------------------------------------------
  {
    re: /Verkehrsinsel\/dem Grünstreifen/,
    gruppe: RUBRIK.flaechen,
    pfad: () => [{ ask: ['dem Grünstreifen', 'einer Verkehrsinsel'] }],
    varianten: [v('Grünstreifen', 'dem Grünstreifen'), v('Verkehrsinsel', 'einer Verkehrsinsel')],
  },
  { re: /Sperrfläche \(Zeichen 298\)/, gruppe: RUBRIK.flaechen, pfad: () => [{ pick: ['benutzten die Sperrfläche'] }] },
  { re: /Grenzmarkierung \(Zeichen 299\) für ein Haltverbot\.?( und|$)/, gruppe: RUBRIK.flaechen, pfad: () => [{ pick: ['innerhalb einer Grenzmarkierung (Zeichen 299)'] }] },
  { re: /verkehrsberuhigten Bereich/, gruppe: RUBRIK.flaechen, pfad: () => [{ pick: ['in einem verkehrsberuhigten Bereich'] }] },

  // --- Feuerwehr --------------------------------------------------------------
  // Das Portal kennt nur „parkte"; Halten in der Feuerwehrzufahrt hat keinen
  // Eintrag (fällt unten durch → Tatbestand live wählen oder per Mail).
  {
    re: /parkten (verbotswidrig )?(vor oder in einer amtlich gekennzeichneten Feuerwehrzufahrt|im Bereich einer Feuerwehranfahrtszone\/einer Feuerwehrzufahrt)/,
    gruppe: RUBRIK.feuerwehr,
    pfad: () => [{ pick: ['Das Fahrzeug parkte vor oder in einer amtlich gekennzeichneten Feuerwehrzufahrt'] }],
    rettung: (t) => /Rettungsfahrzeug im Einsatz/.test(t),
  },

  // --- Taxi / Haltestelle / Bus / zweite Reihe -------------------------------
  { re: /Taxenstandes/, gruppe: RUBRIK.taxi, pfad: (a) => [a, { pick: ['auf einem Sonderparkplatz für Taxen'] }] },
  { re: /Haltestellenschild \(Zeichen 224\)/, gruppe: RUBRIK.taxi, pfad: () => [{ pick: ['Parken'] }, { pick: ['im Bereich einer Haltestelle'] }] },
  { re: /^Sie (hielten|parkten) auf einem Bussonderfahrstreifen \(Zeichen 245\)/, gruppe: RUBRIK.taxi, pfad: (a) => [a, { pick: ['auf einem Busfahrstreifen'] }] },
  { re: /in der zweiten Reihe/, gruppe: RUBRIK.taxi, pfad: (a) => [a, { pick: ['in der zweiten Reihe'] }] },

  // --- Bordstein / Zufahrten / Kreuzungen ------------------------------------
  { re: /Bordsteinabsenkung/, gruppe: RUBRIK.bordstein, pfad: () => [{ pick: ['im Bereich einer Bordsteinabsenkung'] }] },
  { re: /gegenüber einer Grundstücksein/, gruppe: RUBRIK.bordstein, pfad: () => [{ pick: ['gegenüber der Grundstückszufahrt'] }] },
  { re: /Grundstücksein- bzw\. -ausfahrt/, gruppe: RUBRIK.bordstein, pfad: () => [{ pick: ['im Bereich einer Grundstückszufahrt'] }] },
  {
    re: /weniger als [58] Meter vor der Kreuzung\/Einmündung/,
    gruppe: RUBRIK.bordstein,
    pfad: () => [{ ask: ['weniger als 5 Meter VOR der Kreuzung', 'weniger als 5 Meter VOR einer Einmündung'] }],
    varianten: [v('Kreuzung', 'weniger als 5 Meter VOR der Kreuzung'), v('Einmündung', 'weniger als 5 Meter VOR einer Einmündung')],
  },
  {
    re: /weniger als 5 Meter hinter der Kreuzung\/Einmündung/,
    gruppe: RUBRIK.bordstein,
    pfad: () => [{ ask: ['weniger als 5 Meter HINTER der Kreuzung', 'weniger als 5 Meter HINTER der Einmündung'] }],
    varianten: [v('Kreuzung', 'weniger als 5 Meter HINTER der Kreuzung'), v('Einmündung', 'weniger als 5 Meter HINTER der Einmündung')],
  },
]

/** Alle gültigen Werte für reports.verstoss_variante. */
export const ALLE_VARIANTEN = new Set(REGELN.flatMap((r) => r.varianten ?? []).map((x) => x.value))

/** Katalogtext ohne „TBNR – ". */
function verstossText(label: string): string {
  return label.replace(/^\d{6} – /, '').trim()
}

function regelFuer(label: string | null | undefined): Regel | null {
  if (!label) return null
  const text = verstossText(label)
  return REGELN.find((r) => r.re.test(text)) ?? null
}

/** Varianten, zwischen denen der Nutzer für diesen Verstoß wählen muss (leer = keine). */
export function verstossVarianten(label: string | null | undefined): Variante[] {
  return regelFuer(label)?.varianten ?? []
}

/** Gibt es für den Verstoß einen Eintrag im Portal? */
export function imPortal(label: string | null | undefined): boolean {
  return !!regelFuer(label)
}

/** Portal-Pfad für einen Verstoß (+ gewählte Variante). `null` = kein passender
 *  Tatbestand im Portal (Auswahl dann live im Browser). */
export function portalTatbestand(label: string | null | undefined, variante?: string | null): PortalTatbestand | null {
  const regel = regelFuer(label)
  if (!regel) return null
  const text = verstossText(label!)
  const varianteEl = regel.varianten?.find((x) => x.value === variante)
  const pfad = regel.pfad(aktionAus(text)).map((el) =>
    el.ask && varianteEl && el.ask.includes(varianteEl.portal) ? { pick: [varianteEl.portal] } : el
  )
  return { gruppe: regel.gruppe, pfad, rettung: regel.rettung?.(text) ?? false }
}

// ---------------------------------------------------------------------------
// „Parken länger als 1 Stunde": Der Katalog hat dafür eigene TBNR. Ist die
// Tatzeit länger als eine Stunde, schlägt die App den passenden Tatbestand vor.

const LANG_ZU_KURZ = new Map<string, string>() // Text ohne „länger als 1 Stunde" → TBNR (lang)
for (const x of VERSTOESSE) {
  if (/länger als 1 Stunde/.test(x.text)) LANG_ZU_KURZ.set(x.text.replace(/ ?länger als 1 Stunde/, '').replace(/\s+/g, ' '), x.tbnr)
}

/** Label des „länger als 1 Stunde"-Gegenstücks, falls es eins gibt. */
export function langparkerVariante(label: string | null | undefined): string | null {
  if (!label || /länger als/.test(label)) return null
  const tbnr = LANG_ZU_KURZ.get(verstossText(label).replace(/\s+/g, ' '))
  const x = tbnr ? VERSTOESSE.find((y) => y.tbnr === tbnr) : null
  return x ? `${x.tbnr} – ${x.text}` : null
}

/** Dauer der Tat in Minuten (über Mitternacht per tattag_bis), `null` ohne Bis-Zeit. */
export function tatDauerMinuten(r: Record<string, any>): number | null {
  const hm = (t: unknown) => {
    const m = /^(\d{2}):(\d{2})/.exec(String(t ?? ''))
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  const von = hm(r.tatzeit_von)
  const bis = hm(r.tatzeit_bis)
  if (von === null || bis === null) return null
  const tage = r.tattag_bis && r.tattag ? Math.round((new Date(String(r.tattag_bis)).getTime() - new Date(String(r.tattag)).getTime()) / 86400000) : 0
  return bis - von + Math.max(0, tage) * 1440
}

// ---------------------------------------------------------------------------
// Payload für den Portal-Dienst

export interface PortalPayload {
  person: { anrede: string; name: string; vorname: string; plz: string; ort: string; strasse: string; nr: string; telefon: string }
  gruppe: string | null
  pfad: PathEl[]
  behinderung: { ja: boolean; rettung: boolean; text: string }
  fahrzeug: { typ: string; land: string; kennzeichen: string; marke: string | null; modell: string; farbe: string }
  tat: { ort: string; tattag: string; von: string; bis: string }
  email: string
}

const hhmm = (t: unknown) => (t ? String(t).slice(0, 5) : '')
const ddmmyyyy = (d: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d instanceof Date ? isoDate(d) : String(d ?? ''))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}
function isoDate(d: Date): string {
  // mysql2 liefert DATE als lokale Mitternacht – lokal formatieren, nicht UTC.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Tatort für das Portalfeld „Straße und Hausnummer, eventuell Konkretisierung":
 *  Adresse ohne PLZ/Ort (das Portal gilt nur für Frankfurt), dazu die
 *  Beschreibung als Konkretisierung. */
function tatortText(r: mysql.RowDataPacket): string {
  const ort = String(r.tatort || '').replace(/,\s*\d{5}\s+[^,]+$/, '').trim()
  const extra = [r.fahrzeug_verlassen === 1 ? 'Fahrzeug war verlassen.' : '', String(r.beschreibung || '').trim()].filter(Boolean).join(' ')
  return extra ? `${ort} - ${extra}` : ort
}

export class PortalDatenFehler extends Error {}

/** Was dem Portal-Versand fehlt (Prüfliste vor dem Einreichen); `null` = passt. */
export function portalProblem(r: Record<string, any>): string | null {
  const vs = verstossVarianten(r.verstoss_art)
  if (vs.length && !vs.some((x) => x.value === r.verstoss_variante)) {
    return `Bitte beim Verstoß genauer angeben: ${vs.map((x) => x.value).join(' oder ')}.`
  }
  if (r.kennzeichen_land && !KENNZEICHEN_LAENDER[String(r.kennzeichen_land).toUpperCase()]) {
    return `Das Länderkennzeichen „${r.kennzeichen_land}" kennt das Portal der Stadt nicht.`
  }
  return null
}

export function buildPortalPayload(r: mysql.RowDataPacket, u: mysql.RowDataPacket): PortalPayload {
  const tb = portalTatbestand(r.verstoss_art, r.verstoss_variante)
  const land = KENNZEICHEN_LAENDER[String(r.kennzeichen_land || 'D').toUpperCase()]
  if (!land) throw new PortalDatenFehler(`Das Länderkennzeichen „${r.kennzeichen_land}" kennt das Portal nicht.`)
  if (!u.hausnummer) throw new PortalDatenFehler('Im Profil fehlt die Hausnummer.')
  // Ende vor Beginn = über Mitternacht. Das Portal will laut Hinweis nur die
  // Uhrzeiten eines Tages – dann bis Tagesende.
  const von = hhmm(r.tatzeit_von)
  let bis = hhmm(r.tatzeit_bis) || von
  if (bis < von || (r.tattag_bis && String(r.tattag_bis) !== String(r.tattag))) bis = '23:59'
  const behindert = r.behinderung === 1 || /behinderten|behindert wurden/.test(String(r.verstoss_art || ''))
  return {
    person: {
      anrede: portalAnrede(u.anrede),
      name: u.nachname || '',
      vorname: u.vorname || '',
      plz: u.plz || '',
      ort: u.ort || '',
      strasse: u.strasse || '',
      nr: u.hausnummer || '',
      telefon: u.telefon || '',
    },
    gruppe: tb?.gruppe ?? null,
    pfad: tb?.pfad ?? [],
    behinderung: {
      ja: behindert,
      rettung: !!tb?.rettung,
      text: String(r.behinderung_text || '').trim(),
    },
    fahrzeug: {
      typ: fahrzeugTyp(r.fahrzeug_typ),
      land,
      kennzeichen: r.kennzeichen || '',
      marke: portalMarke(r.fahrzeug_marke) ?? (r.fahrzeug_marke ? String(r.fahrzeug_marke) : null),
      modell: String(r.fahrzeug_modell || '').trim(),
      farbe: String(r.fahrzeug_farbe || '').trim(),
    },
    tat: { ort: tatortText(r), tattag: ddmmyyyy(r.tattag), von, bis },
    email: u.email || '',
  }
}

/** Fotos aufteilen: das Portal will getrennt ein Übersichtsfoto (Verstoß samt
 *  Beschilderung) und ein Fahrzeugfoto (Kennzeichen lesbar), je höchstens 5.
 *  Fotos mit erkanntem Kennzeichen gelten als Fahrzeugfotos, die übrigen als
 *  Übersicht. Fehlt eine Seite, wird aufgefüllt: das erste Foto ist Übersicht,
 *  das mit dem deutlichsten Kennzeichen Fahrzeug. */
export function photoRoles<T extends Record<string, any>>(
  imgs: T[]
): { uebersicht: T[]; fahrzeug: T[] } {
  let fahrzeug = imgs.filter((i) => i.detected_plate)
  let uebersicht = imgs.filter((i) => !i.detected_plate)
  if (!fahrzeug.length && uebersicht.length > 1) fahrzeug = [uebersicht.pop()!]
  if (!uebersicht.length && fahrzeug.length > 1) {
    const best = [...fahrzeug].sort((a, b) => Number(b.plate_confidence || 0) - Number(a.plate_confidence || 0))[0]
    uebersicht = fahrzeug.filter((i) => i !== best)
    fahrzeug = [best]
  }
  if (!fahrzeug.length) fahrzeug = uebersicht.slice(0, 1)
  if (!uebersicht.length) uebersicht = fahrzeug.slice(0, 1)
  return { uebersicht: uebersicht.slice(0, 5), fahrzeug: fahrzeug.slice(0, 5) }
}

/** Für die Formulare (Editor, Foto-Dialog): Varianten und „länger als 1 Stunde"-
 *  Gegenstücke je Katalog-Label. Einmal beim Start berechnet. */
export function formularHilfen(labels: string[]): { varianten: Record<string, string[]>; langparker: Record<string, string> } {
  const varianten: Record<string, string[]> = {}
  const langparker: Record<string, string> = {}
  for (const l of labels) {
    const vs = verstossVarianten(l)
    if (vs.length) varianten[l] = vs.map((x) => x.value)
    const lang = langparkerVariante(l)
    if (lang) langparker[l] = lang
  }
  return { varianten, langparker }
}

/** Für Tests/Diagnose: welche Katalogeinträge haben keinen Portal-Tatbestand? */
export function ohnePortalTatbestand(): string[] {
  return VERSTOESSE.filter((x) => !regelFuer(`${x.tbnr} – ${x.text}`)).map((x) => `${x.tbnr} – ${x.text}`)
}

export { tbnrAusLabel }
