import crypto from 'crypto'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { prewarmPublicImages } from './publicImages'
import { versandBestaetigungEinreihen } from './versandBestaetigung'

export type PreparedReportMail = {
  messageId: string
  subject: string
  text: string
  from: string | null
  send: () => Promise<void>
}
export class ReportPreparationError extends Error {}

export type DispatchResult = 'sent' | 'busy' | 'uncertain' | 'not-pending' | 'stale'

// Freigabe-Marke (reports.freigabe_token, Migration 0050): Die Admin-Freigabe
// gilt nur für den Stand, den der Admin gesehen hat. Zwischen Freigabe und
// Versand kann der Job lange warten (Versand-Takt, Portal belegt, „ab morgen“);
// zieht der Nutzer in der Zeit zurück, ändert und reicht neu ein, darf der alte
// Job nichts versenden. Daher: Freigabe setzt eine neue Marke und gibt sie dem
// Job mit; Zurückziehen/Ablehnen/Einreichen löschen sie (routes/reports/submit.ts,
// routes/admin.ts); der Claim (dispatchReport, portalDispatch.startPortalRun)
// verlangt die passende Marke. Jobs ohne Marke (vor Migration 0050 eingereiht
// und dort nicht zuordenbar) versenden nichts.

const VERSAND_JOBS = "('report.dispatch', 'portal.start')"

/** Wartende Versand-Jobs einer Anzeige löschen (laufende nicht – die scheitern
 *  an der Marke). Die Zuordnung geht über payload.reportId, weil ein schon
 *  einmal gelaufener Job (JobRetryLater) keinen pending_key mehr hat. */
export async function wartendeVersandJobsLoeschen(reportId: number): Promise<void> {
  await pool.execute(
    `DELETE FROM jobs WHERE status = 'queued' AND type IN ${VERSAND_JOBS}
        AND CAST(JSON_VALUE(payload, '$.reportId') AS UNSIGNED) = ?`,
    [reportId]
  )
}

/** Freigabe erteilen: neue Marke setzen (nur eingereicht und nicht im Versand)
 *  und ältere wartende Versand-Jobs verwerfen – sonst verschluckte enqueueJob
 *  den neuen Job als Schlüssel-Duplikat und der alte liefe mit veralteter
 *  Marke ins Leere. null = nicht (mehr) freigebbar. */
export async function freigabeErteilen(reportId: number): Promise<string | null> {
  const token = crypto.randomUUID()
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    "UPDATE reports SET freigabe_token=? WHERE id=? AND status='eingereicht' AND versand_status IS NULL",
    [token, reportId]
  )
  if (!res.affectedRows) return null
  await wartendeVersandJobsLoeschen(reportId)
  return token
}

/** SMTP-Annahme ist keine Zustellbestätigung. Das gespeicherte Ergebnis erlaubt
 *  aber, nach SQL-Fehlern ausschließlich den lokalen Abschluss zu wiederholen. */
async function finishDispatch(reportId: number): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM reports WHERE id=? FOR UPDATE', [reportId]
    )
    const report = rows[0]
    if (report?.status === 'versendet') {
      await conn.commit()
      return
    }
    if (report?.versand_status !== 'angenommen' || !report.versand_ergebnis) {
      throw new Error('Kein bestätigtes Versandergebnis vorhanden.')
    }
    const mail = JSON.parse(report.versand_ergebnis) as Omit<PreparedReportMail, 'send'>
    await conn.execute(
      `INSERT INTO report_replies
         (report_id, direction, message_id, from_address, subject, body_text, received_at, read_at)
       VALUES (?, 'out', ?, ?, ?, ?, NOW(), NOW())`,
      [reportId, mail.messageId, mail.from, mail.subject.slice(0, 500), mail.text]
    )
    await conn.execute(
      `UPDATE reports SET status='versendet', versand_art='system_email', sent_message_id=?,
         versand_status=NULL, versand_ergebnis=NULL WHERE id=?`,
      [mail.messageId, reportId]
    )
    await conn.commit()
    void prewarmPublicImages(reportId)
    await versandBestaetigungEinreihen(reportId).catch(() => {})
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Atomarer Claim vor jeder Vorbereitung. Eine verlorene Verbindung nach SMTP
 *  hinterlässt 'versand': nur manuelle Klärung darf diese Sperre auflösen.
 *  Auch nach einem Prozessabbruch wird kein zweiter Versand gestartet. */
export async function dispatchReport(
  reportId: number,
  prepare: (messageId: string) => Promise<PreparedReportMail>,
  freigabe?: string
): Promise<DispatchResult> {
  // Claim nur mit der Marke der Freigabe (siehe oben, freigabeErteilen). Ohne
  // Marke (nur Tests/Einmal-Skripte) keine Prüfung – der Job 'report.dispatch'
  // (routes/admin.ts) gibt sie immer mit.
  const [claim] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE reports SET versand_status='vorbereitung'
      WHERE id=? AND status='eingereicht' AND versand_status IS NULL AND (? IS NULL OR freigabe_token=?)`,
    [reportId, freigabe ?? null, freigabe ?? null]
  )
  if (!claim.affectedRows) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT status, versand_status, freigabe_token FROM reports WHERE id=?', [reportId]
    )
    if (rows[0]?.status === 'versendet') return 'sent'
    if (rows[0]?.versand_status === 'angenommen') {
      await finishDispatch(reportId)
      return 'sent'
    }
    if (rows[0]?.versand_status === 'versand') return 'uncertain'
    if (rows[0]?.versand_status) return 'busy'
    return freigabe && rows[0]?.status === 'eingereicht' && rows[0]?.freigabe_token !== freigabe ? 'stale' : 'not-pending'
  }

  let smtpStarted = false
  try {
    // Schon vor SMTP festlegen und persistieren: bei unklarem Ausgang lässt
    // sich genau dieser Versuch anhand seiner Message-ID im Mailserver prüfen.
    const messageId = `<${crypto.randomUUID()}@owia.local>`
    const prepared = await prepare(messageId)
    const { send, ...mail } = prepared
    if (mail.messageId !== messageId) throw new Error('Message-ID der Versandvorbereitung stimmt nicht überein.')
    await pool.execute(
      "UPDATE reports SET versand_status='versand', versand_ergebnis=? WHERE id=?",
      [JSON.stringify(mail), reportId]
    )
    smtpStarted = true
    await send()
    await pool.execute("UPDATE reports SET versand_status='angenommen' WHERE id=?", [reportId])
    await finishDispatch(reportId)
    return 'sent'
  } catch (err) {
    // Nur vor SMTP darf eine Wiederholung freigegeben werden. Schlägt bereits
    // dieser Reset fehl, bleibt die Sperre sicherheitshalber erhalten.
    if (!smtpStarted) {
      await pool.execute(
        "UPDATE reports SET versand_status=NULL, versand_ergebnis=NULL WHERE id=? AND versand_status IN ('vorbereitung','versand')",
        [reportId]
      )
    }
    throw err
  }
}
