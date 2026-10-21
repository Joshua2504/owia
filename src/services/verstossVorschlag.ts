// Verstoß-Vorschlag nach Ort: Was hat derselbe Nutzer früher an dieser Stelle
// angezeigt? Viele Anzeigen entstehen immer wieder an denselben Ecken, dort
// ist es fast immer derselbe Tatbestand. Ergebnis ist nur eine Gruppe oben in
// der Verstoß-Auswahl (verstoss-select.js), nie eine Vorbefüllung – der
// Tatbestand ist eine Aussage der meldenden Person.
//
// Gemessen 10/2026 an 298 Prod-Anzeigen, streng zeitlich (jede Anzeige nur
// mit früheren bewertet): Platz 1 stimmte in 74 % aller Fälle, gegenüber 58 %
// für den global häufigsten Tatbestand. Wo es Nachbarn gibt (91 %), stand der
// richtige in 90 % unter den ersten drei. Radius/Abklingen sind daran gewählt;
// das Alter der Nachbarn half nicht und bleibt deshalb unberücksichtigt.
//
// Nur eigene Anzeigen: Fremde Anzeigen an einem Ort sollen sich über den
// Vorschlag nicht erschließen lassen.
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { VERSTOSS_ARTEN } from '../config/verstoss'

/** Nachbarn weiter weg als das zählen nicht (Meter). */
export const VORSCHLAG_RADIUS_M = 100
/** Abklingen des Gewichts exp(-d/s): Ein Nachbar in 10 m zählt 1/e so viel
 *  wie einer am selben Punkt – die eigene Straßenseite dominiert. */
export const VORSCHLAG_SKALA_M = 10
export const VORSCHLAG_MAX = 3

export interface VerstossVorschlag {
  /** Label wie in reports.verstoss_art („TBNR – Text"). */
  text: string
  /** Wie oft dieser Tatbestand im Umkreis angezeigt wurde. */
  anzahl: number
}

/** Abstand in Metern (flache Näherung – auf 100 m genauer als nötig). */
export function distanzM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180) * 111320
  const y = (lat2 - lat1) * 111320
  return Math.hypot(x, y)
}

/** Abstandsgewichtete Mehrheit der Nachbarn, beste zuerst. */
export function rankeVerstoesse(
  nachbarn: { verstoss: string; distM: number }[],
  max = VORSCHLAG_MAX
): VerstossVorschlag[] {
  const summe = new Map<string, { w: number; n: number }>()
  for (const { verstoss, distM } of nachbarn) {
    if (!verstoss || !(distM <= VORSCHLAG_RADIUS_M)) continue
    const s = summe.get(verstoss) ?? { w: 0, n: 0 }
    s.w += Math.exp(-distM / VORSCHLAG_SKALA_M)
    s.n += 1
    summe.set(verstoss, s)
  }
  return [...summe.entries()]
    .sort((a, b) => b[1].w - a[1].w || b[1].n - a[1].n)
    .slice(0, max)
    .map(([text, s]) => ({ text, anzahl: s.n }))
}

const katalog = new Set(VERSTOSS_ARTEN)

/** Vorschläge für einen Tatort aus den eigenen Anzeigen des Nutzers (ohne die
 *  Anzeige selbst und ohne Papierkorb). Ohne Koordinaten oder bei DB-Fehler
 *  leer – der Vorschlag ist Komfort, nie Voraussetzung. */
export async function verstossVorschlaege(
  userId: number,
  lat: number | string | null | undefined,
  lon: number | string | null | undefined,
  ohneReportId?: number
): Promise<VerstossVorschlag[]> {
  const la = Number(lat)
  const lo = Number(lon)
  if (lat == null || lon == null || !Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return []
  // Grobe Box (Index-freundlich), genau gerechnet wird danach in JS.
  const dLat = VORSCHLAG_RADIUS_M / 111320
  const dLon = dLat / Math.max(0.1, Math.cos((la * Math.PI) / 180))
  try {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT verstoss_art, tatort_lat, tatort_lon FROM reports
        WHERE user_id = ? AND id <> ? AND status <> 'papierkorb'
          AND verstoss_art IS NOT NULL AND verstoss_art <> ''
          AND tatort_lat BETWEEN ? AND ? AND tatort_lon BETWEEN ? AND ?`,
      [userId, ohneReportId ?? 0, la - dLat, la + dLat, lo - dLon, lo + dLon]
    )
    return rankeVerstoesse(
      rows
        // Nur, was noch im aktuellen Katalog steht (sonst nicht wählbar).
        .filter((r) => katalog.has(String(r.verstoss_art)))
        .map((r) => ({
          verstoss: String(r.verstoss_art),
          distM: distanzM(la, lo, Number(r.tatort_lat), Number(r.tatort_lon)),
        }))
    )
  } catch {
    return []
  }
}
