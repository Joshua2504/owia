import mysql from 'mysql2/promise'
import { pool } from '../db/connection'

// Versand-Stand eingereichter Anzeigen für die Liste (report-row.ejs): wann
// startet der Versand-Job (Mail 'report.dispatch' bzw. Portal 'portal.start')?
// Durch den Versand-Takt (versandTakt.ts) wartet ein Job oft Minuten –
// run_after ist dann der geplante Start. Ein laufender Job hat pending_key NULL,
// daher die Zuordnung über payload.reportId.

export type VersandWarte = { sek: number | null; laeuft: boolean }

export async function versandWartezeiten(reportIds: number[]): Promise<Map<number, VersandWarte>> {
  const out = new Map<number, VersandWarte>()
  if (!reportIds.length) return out
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT CAST(JSON_VALUE(payload, '$.reportId') AS UNSIGNED) AS report_id,
            MAX(status = 'running') AS laeuft,
            GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), MIN(CASE WHEN status = 'queued' THEN run_after END))) AS sek
       FROM jobs
      WHERE status IN ('queued', 'running') AND type IN ('report.dispatch', 'portal.start')
      GROUP BY report_id
     HAVING report_id IN (?)`,
    [reportIds]
  )
  for (const r of rows) {
    out.set(Number(r.report_id), { sek: r.sek === null ? null : Number(r.sek), laeuft: Number(r.laeuft) === 1 })
  }
  return out
}
