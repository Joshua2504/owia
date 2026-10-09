// Kleine, reine Formatierungs-/Eingabe-Helfer ohne Abhängigkeiten (auch aus
// Scripts und Portal-Payloads nutzbar). Verhalten 1:1 wie die früheren lokalen
// Kopien – Portal-Payloads hängen byte-genau daran.

/** "14:30:00" / "14:30" → "14:30"; leer/null → ''. */
export function hhmm(time: unknown): string {
  return time ? String(time).slice(0, 5) : ''
}

/** Date → "YYYY-MM-DD" in LOKALER Zeit. mysql2 liefert DATE-Spalten als lokale
 *  Mitternacht; toISOString() (UTC) würde den Tag in der Server-Zeitzone
 *  verrutschen. Ungültige Dates prüft der Aufrufer. */
export function localIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Positive Ganzzahl aus Query/Body (z.B. ?queue=12), sonst null. */
export function positiveInt(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Freitext aus Formularen: Whitespace (auch Zeilenumbrüche) zu einem
 *  Leerzeichen, getrimmt, auf max Zeichen gekürzt; leer → null. */
export function cleanText(v: unknown, max: number): string | null {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null
}
