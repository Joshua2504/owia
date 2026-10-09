// Versand-Bestätigung an den Erstatter: nach jedem erfolgreichen Versand (Mail
// ans Amt oder Online-Portal) bekommt der Nutzer eine Mail mit allen Angaben,
// Empfänger, Zeitpunkt, dem übermittelten Text und – beim Portal – dem Beleg.
// Läuft als Job, damit ein Mailfehler den Versand selbst nie berührt.
import path from 'path'
import fs from 'fs/promises'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { enqueueJob, registerJob } from './jobs'
import { MailService } from './mail'
import { repliesDir } from './mailInbox'

export async function versandBestaetigungEinreihen(reportId: number): Promise<void> {
  await enqueueJob('mail.versand-bestaetigung', { reportId }, { key: `versand-bestaetigung:${reportId}` })
}

registerJob('mail.versand-bestaetigung', async ({ reportId }) => {
  const [reports] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM reports WHERE id=? AND status='versendet'", [reportId]
  )
  const report = reports[0]
  if (!report) return
  const [users] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM users WHERE id=?', [report.user_id])
  const user = users[0]
  if (!user?.email) return
  // Die ausgehende Nachricht (Mailtext ans Amt bzw. Portal-Protokoll) samt Anhängen.
  const [sent] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, subject, body_text, received_at FROM report_replies
      WHERE report_id=? AND direction='out' AND message_id=? LIMIT 1`,
    [reportId, report.sent_message_id]
  )
  const [images] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT DATE_FORMAT(captured_at, '%d.%m.%Y, %H:%i') AS captured_at
       FROM report_images WHERE report_id=? ORDER BY sort_order, id`,
    [reportId]
  )
  const belege: { filename: string; content: Buffer; contentType: string }[] = []
  if (sent[0]) {
    const [atts] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT filename, original_filename, mimetype FROM report_reply_attachments WHERE reply_id=?', [sent[0].id]
    )
    for (const a of atts) {
      try {
        belege.push({
          filename: a.original_filename,
          content: await fs.readFile(path.join(repliesDir(Number(sent[0].id)), a.filename)),
          contentType: a.mimetype,
        })
      } catch {
        /* Beleg fehlt auf Platte – Bestätigung trotzdem senden */
      }
    }
  }
  await MailService.sendVersandBestaetigung(user, report, {
    gesendetAm: sent[0]?.received_at ? new Date(sent[0].received_at) : new Date(),
    betreff: sent[0]?.subject ?? null,
    text: sent[0]?.body_text ?? null,
    fotoZeiten: images.map((i) => i.captured_at as string | null),
    belege,
  })
})
