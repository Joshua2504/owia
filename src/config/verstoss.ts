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

/** Alle wählbaren Tatbestand-Texte (dedupliziert) – Quelle der Formular-Auswahl. */
export const VERSTOSS_ARTEN: string[] = Array.from(new Set(verstoesse.map((v) => v.text)))

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

/** Kuratierte häufige Verstöße als Texte (nur die tatsächlich im Katalog
 *  gefundenen), in obiger Reihenfolge. */
export const VERSTOSS_HAEUFIG: string[] = HAEUFIG_TBNR.map(
  (tbnr) => verstoesse.find((v) => v.tbnr === tbnr)?.text
).filter((t): t is string => !!t)
