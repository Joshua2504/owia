import mysql from 'mysql2/promise'
import { pool } from '../db/connection'

// Portal-Versand drosseln: höchstens ein Portal-Start ('portal.start', ekom21-
// Formulare) je VERSAND_ABSTAND, damit die Portale nicht in kurzer Zeit viele
// Anzeigen auf einmal bekommen. Der Mail-Versand ist nicht getaktet.
// Manuelle Starts auf /versand zählen mit, werden aber nicht aufgehalten –
// außer beim „nacheinander senden" (takt: true, routes/portal.ts).
// Tabelle: migrations/0044_versand_takt.sql.

export const VERSAND_ABSTAND_SEK = Number(process.env.VERSAND_ABSTAND_SEK || 300)

/** Versandplatz belegen. null = belegt; sonst die Wartezeit in Sekunden bis
 *  zum nächsten freien Platz. */
export async function versandPlatzBelegen(): Promise<number | null> {
  // SET wird von links nach rechts ausgewertet: vorher erhält den alten Wert.
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE versand_takt SET vorher = letzter, letzter = NOW()
      WHERE id = 1 AND letzter <= DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [VERSAND_ABSTAND_SEK]
  )
  if (res.affectedRows) return null
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT TIMESTAMPDIFF(SECOND, letzter, NOW()) AS seit FROM versand_takt WHERE id = 1'
  )
  return Math.max(5, VERSAND_ABSTAND_SEK - Number(rows[0]?.seit ?? 0))
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
