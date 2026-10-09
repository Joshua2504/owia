import mysql from 'mysql2/promise'
import { pool } from '../db/connection'

// Portal-Versand drosseln: höchstens ein Portal-Start ('portal.start', ekom21-
// Formulare) je VERSAND_ABSTAND, damit die Portale nicht in kurzer Zeit viele
// Anzeigen auf einmal bekommen. Der Mail-Versand ist nicht getaktet.
// Manuelle Starts auf /versand zählen mit, werden aber nicht aufgehalten –
// außer beim „nacheinander senden" (takt: true, routes/portal.ts).
// Tabelle: migrations/0044_versand_takt.sql.

// Abstand ist auf /versand einstellbar (versand_takt.abstand_sek, Migration
// 0046); ohne Eintrag gilt VERSAND_ABSTAND_SEK.
export const VERSAND_ABSTAND_SEK = Number(process.env.VERSAND_ABSTAND_SEK || 60)
export const ABSTAND_MIN_SEK = 0
export const ABSTAND_MAX_SEK = 24 * 3600

/** Aktueller Abstand zwischen zwei Portal-Anzeigen in Sekunden. */
export async function versandAbstand(): Promise<number> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT abstand_sek FROM versand_takt WHERE id = 1')
  const v = rows[0]?.abstand_sek
  return v === null || v === undefined ? VERSAND_ABSTAND_SEK : Number(v)
}

export async function versandAbstandSetzen(sek: number): Promise<void> {
  await pool.execute('UPDATE versand_takt SET abstand_sek = ? WHERE id = 1', [sek])
}

/** Versandplatz belegen. null = belegt; sonst die Wartezeit in Sekunden bis
 *  zum nächsten freien Platz. */
export async function versandPlatzBelegen(): Promise<number | null> {
  const abstand = await versandAbstand()
  // SET wird von links nach rechts ausgewertet: vorher erhält den alten Wert.
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE versand_takt SET vorher = letzter, letzter = NOW()
      WHERE id = 1 AND letzter <= DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [abstand]
  )
  if (res.affectedRows) return null
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT TIMESTAMPDIFF(SECOND, letzter, NOW()) AS seit FROM versand_takt WHERE id = 1'
  )
  return Math.max(5, abstand - Number(rows[0]?.seit ?? 0))
}

/** Belegten Platz zurückgeben, wenn doch nichts verschickt wurde (Anzeige
 *  nicht versandbereit, Portal belegt, Vorbereitung gescheitert). */
export async function versandPlatzFreigeben(): Promise<void> {
  await pool.execute('UPDATE versand_takt SET letzter = vorher WHERE id = 1').catch(() => undefined)
}

/** Versand außerhalb der Warteschlange (Klick auf /versand): Platz belegen,
 *  ohne zu warten – die nächste Anzeige aus der Warteschlange folgt im Abstand. */
export async function versandMerken(): Promise<void> {
  await pool.execute('UPDATE versand_takt SET vorher = letzter, letzter = NOW() WHERE id = 1').catch(() => undefined)
}
