// Verstoßart-Katalog: der amtliche Tatbestandskatalog (TBNR) aus
// resources/verstoesse.csv. Wird beim Start eingelesen und für die durchsuchbare
// Verstoß-Auswahl im Formular bereitgestellt. Gespeichert wird in
// reports.verstoss_art der gewählte Tatbestand-TEXT; er wird unverändert in
// PDF/E-Mail/Anzeige-Ansicht weiterverwendet (daher keine Änderungen dort nötig).
import fs from 'fs'
import path from 'path'

export interface Verstoss {
  /** Amtliche Tatbestandsnummer (TBNR), z.B. "112454". */
  tbnr: string
  /** Aufbereiteter Tatbestandstext (Fußnotenmarker/Platzhalter geglättet). */
  text: string
}

const CSV_PATH = path.join(process.cwd(), 'resources', 'verstoesse.csv')

/** Amtstext lesbar machen: Fußnotenmarker „+)" entfernen, <a/b/c>-Alternativen
 *  ohne spitze Klammern zeigen, doppelte Leerzeichen glätten. */
function cleanTatbestand(s: string): string {
  return s
    .replace(/\s*\+\)/g, '')
    .replace(/<([^>]*)>/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Jede Zeile: "Nr","TBNR","Tatbestand" (alle Felder gequotet). */
function parse(content: string): Verstoss[] {
  const out: Verstoss[] = []
  const rowRe = /^"([^"]*)","([^"]*)","(.*)"\s*$/
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue
    const m = rowRe.exec(line)
    if (!m) continue
    const [, nr, tbnr, text] = m
    if (nr === 'Nr' || !tbnr || !text.trim()) continue // Kopfzeile / leer überspringen
    out.push({ tbnr: tbnr.trim(), text: cleanTatbestand(text) })
  }
  return out
}

let verstoesse: Verstoss[]
try {
  verstoesse = parse(fs.readFileSync(CSV_PATH, 'utf8'))
} catch {
  // Fehlt die Datei, bleibt die Auswahl leer (Formular zeigt keine Optionen).
  verstoesse = []
}

/** Vollständiger Tatbestandskatalog (Reihenfolge wie in der CSV). */
export const VERSTOESSE: Verstoss[] = verstoesse

/** Anzeige-/Speicher-Label eines Tatbestands: „TBNR – Text". Die generische
 *  Sammelnummer „000000" (Sonstige Vergehen) bekommt kein Nummern-Präfix. */
export function verstossLabel(v: Verstoss): string {
  return v.tbnr && v.tbnr !== '000000' ? `${v.tbnr} – ${v.text}` : v.text
}

/** Alle wählbaren Verstöße als Label „TBNR – Text" (dedupliziert) – Quelle der
 *  Formular-Auswahl. Genau dieser String wird in reports.verstoss_art gespeichert
 *  und unverändert in PDF/E-Mail/Anzeige-Ansicht weiterverwendet (TBNR inklusive). */
export const VERSTOSS_ARTEN: string[] = Array.from(new Set(verstoesse.map(verstossLabel)))

// Kuratierte „häufig verwendete" Verstöße als Cold-Start-Reihenfolge oben in der
// Auswahl (per TBNR, damit unabhängig von Textänderungen). Die tatsächliche
// Nutzung aus der DB hat Vorrang – siehe routes/reports.ts (mostUsedVerstoesse).
const HAEUFIG_TBNR = [
  '112454', // Parken auf dem Gehweg
  '141312', // Parken im absoluten Haltverbot (Zeichen 283)
  '141322', // Parken im eingeschränkten Haltverbot (Zeichen 286)
  '141174', // Parken auf einem Radweg/Radfahrstreifen (Zeichen 237)
  '112464', // Parken in zweiter Reihe
  '112216', // Parken vor/in einer Feuerwehrzufahrt
  '112292', // Parken im Bereich einer Grundstücksein-/-ausfahrt
  '112262', // Parken weniger als 5 m vor einer Kreuzung/Einmündung
  '141245', // Parken auf einer Sperrfläche (Zeichen 298)
  '142284', // Parken auf einem Parkplatz für E-Fahrzeuge
  '113140', // Parken ohne gültigen Parkschein
  '141292', // Parken auf einem Fußgängerüberweg
]

/** Kuratierte häufige Verstöße als Label „TBNR – Text" (nur die tatsächlich im
 *  Katalog gefundenen), in obiger Reihenfolge. */
export const VERSTOSS_HAEUFIG: string[] = HAEUFIG_TBNR.map((tbnr) => {
  const v = verstoesse.find((x) => x.tbnr === tbnr)
  return v ? verstossLabel(v) : undefined
}).filter((t): t is string => !!t)

// ---------------------------------------------------------------------------
// Regelsätze (Bußgeld in Euro je TBNR) für die öffentliche Statistik.
// Quelle: Bundeseinheitlicher Tatbestandskatalog des KBA, Stand 22.08.2024
// (bkat_owi_22_08_2024.pdf, Spalte „Euro"), abgeglichen gegen verstoesse.csv –
// jede TBNR dort außer der Sammelnummer „000000" hat einen Eintrag. Bei einem
// neuen Katalogstand beide CSVs gemeinsam aktualisieren.
// Es ist der Regelsatz laut BKat, nicht das tatsächlich verhängte Bußgeld
// (Einstellung, Verwarnung, Gebühren/Auslagen kennt die App nicht).
// ---------------------------------------------------------------------------

const BUSSGELD_CSV_PATH = path.join(process.cwd(), 'resources', 'bussgelder.csv')

/** Jede Zeile: "TBNR","Euro" (Euro mit Dezimalpunkt, z.B. "55.00"). */
function parseBussgelder(content: string): Map<string, number> {
  const out = new Map<string, number>()
  const rowRe = /^"(\d{6})","(\d+(?:\.\d+)?)"\s*$/
  for (const line of content.split(/\r?\n/)) {
    const m = rowRe.exec(line)
    if (m) out.set(m[1], Number(m[2]))
  }
  return out
}

let bussgelder: Map<string, number>
try {
  bussgelder = parseBussgelder(fs.readFileSync(BUSSGELD_CSV_PATH, 'utf8'))
} catch {
  bussgelder = new Map()
}

/** Regelsatz in Euro für eine TBNR, `null` wenn unbekannt (z.B. „000000"). */
export function regelsatzEuro(tbnr: string | null | undefined): number | null {
  return tbnr ? bussgelder.get(tbnr) ?? null : null
}

/** TBNR aus einem gespeicherten reports.verstoss_art-Label („TBNR – Text", siehe
 *  verstossLabel). Freitext/Altbestand ohne Nummer ⇒ `null`. */
export function tbnrAusLabel(label: string | null | undefined): string | null {
  const m = /^(\d{6}) – /.exec(label || '')
  return m ? m[1] : null
}

/** Katalogtext zu einer TBNR (für Tabellen, die nur die Nummer kennen). */
export function verstossText(tbnr: string): string | null {
  return verstoesse.find((v) => v.tbnr === tbnr)?.text ?? null
}
