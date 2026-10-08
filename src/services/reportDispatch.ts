import crypto from 'crypto'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { prewarmPublicImages } from './publicImages'

export type PreparedReportMail = {
  messageId: string
  subject: string
  text: string
  from: string | null
  send: () => Promise<void>
}
export class ReportPreparationError extends Error {}

export type DispatchResult = 'sent' | 'busy' | 'uncertain' | 'not-pending'

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
  prepare: (messageId: string) => Promise<PreparedReportMail>
): Promise<DispatchResult> {
  const [claim] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE reports SET versand_status='vorbereitung'
      WHERE id=? AND status='eingereicht' AND versand_status IS NULL`,
    [reportId]
  )
  if (!claim.affectedRows) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT status, versand_status FROM reports WHERE id=?', [reportId]
    )
    if (rows[0]?.status === 'versendet') return 'sent'
    if (rows[0]?.versand_status === 'angenommen') {
      await finishDispatch(reportId)
      return 'sent'
    }
    if (rows[0]?.versand_status === 'versand') return 'uncertain'
    return rows[0]?.versand_status ? 'busy' : 'not-pending'
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
