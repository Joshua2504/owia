// Admin-Prüfung: Nutzer reichen Anzeigen ein (status 'eingereicht'), ein Admin
// gibt sie hier frei (Versand ans Ordnungsamt per E-Mail, Nutzer in Kopie) oder
// lehnt sie mit Begründung ab (zurück in den Entwurf + Info-Mail an den Nutzer).
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { requireAdmin, viewData, setFlash } from '../middleware/auth'
import { MailService } from '../services/mail'
import { replyAttachmentPath } from '../services/mailInbox'
import { regeneratePdf, isProfileComplete } from './reports'

const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')

/** Eingereichte/versendete Anzeige inkl. Nutzer laden (Admin-Sicht, nutzerübergreifend). */
async function loadReportWithUser(
  id: string
): Promise<{ report: mysql.RowDataPacket; user: mysql.RowDataPacket } | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM reports WHERE id = ?',
    [id]
  )
  const report = rows[0]
  if (!report) return null
  const [users] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM users WHERE id = ?', [
    report.user_id,
  ])
  if (!users[0]) return null
  return { report, user: users[0] }
}

export default async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/anzeigen', { preHandler: requireAdmin }, async (request, reply) => {
    const [pending] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.id, r.aktenzeichen, r.kennzeichen, r.kennzeichen_land, r.tattag,
              r.tatzeit_von, r.tatzeit_bis, r.tatort, r.verstoss_art, r.beschreibung,
              r.behinderung, r.behinderung_text, r.fahrzeug_verlassen,
              DATE_FORMAT(r.eingereicht_at, '%d.%m.%Y %H:%i') AS eingereicht_fmt,
              u.email AS user_email, u.vorname, u.nachname, u.strasse, u.plz, u.ort,
              (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = r.id) AS image_count
         FROM reports r
         JOIN users u ON u.id = r.user_id
        WHERE r.status = 'eingereicht'
        ORDER BY r.eingereicht_at, r.id`
    )
    const [recent] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.id, r.aktenzeichen, r.kennzeichen, r.tatort, u.email AS user_email
         FROM reports r
         JOIN users u ON u.id = r.user_id
        WHERE r.status = 'versendet' AND r.versand_art = 'system_email'
        ORDER BY r.id DESC
        LIMIT 15`
    )
    // Antworten des Ordnungsamts ohne Zuordnung (weder Message-ID noch
    // Aktenzeichen im Betreff/Body gefunden) – manuell zuordnen.
    const [unmatched] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT rr.id, rr.from_address, rr.subject, rr.body_text, rr.received_at,
              (SELECT COUNT(*) FROM report_reply_attachments a WHERE a.reply_id = rr.id) AS attachment_count
         FROM report_replies rr
        WHERE rr.report_id IS NULL
        ORDER BY rr.received_at DESC, rr.id DESC
        LIMIT 50`
    )

    return reply.view('/admin/anzeigen.ejs', viewData(request, {
      title: 'Prüfung',
      pending,
      recent,
      unmatched,
    }))
  })

  // Nicht zugeordnete Antwort einer Anzeige zuordnen (per Aktenzeichen).
  app.post('/admin/replies/:id/assign', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const az = String((request.body as { aktenzeichen?: string })?.aktenzeichen || '').trim()

    const [reports] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM reports WHERE aktenzeichen = ?',
      [az]
    )
    if (!reports[0]) {
      setFlash(reply, 'error', `Keine Anzeige mit Aktenzeichen „${az}" gefunden.`)
      return reply.redirect('/admin/anzeigen')
    }

    const [result] = await pool.execute<mysql.ResultSetHeader>(
      'UPDATE report_replies SET report_id = ? WHERE id = ? AND report_id IS NULL',
      [reports[0].id, id]
    )
    if (result.affectedRows === 1) {
      try {
        const [users] = await pool.execute<mysql.RowDataPacket[]>(
          'SELECT * FROM users WHERE id = ?',
          [reports[0].user_id]
        )
        if (users[0]) await MailService.sendReplyNotification(users[0], reports[0])
      } catch (err) {
        app.log.error({ err }, 'Hinweis-Mail nach Zuordnung fehlgeschlagen')
      }
    }
    setFlash(reply, 'success', `Antwort der Anzeige ${az} zugeordnet.`)
    return reply.redirect('/admin/anzeigen')
  })

  // Anhang einer (auch nicht zugeordneten) Antwort ansehen (Admin).
  app.get('/admin/replies/:replyId/attachment/:attId', { preHandler: requireAdmin }, async (request, reply) => {
    const { replyId, attId } = request.params as { replyId: string; attId: string }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT filename, original_filename, mimetype FROM report_reply_attachments WHERE id = ? AND reply_id = ?',
      [attId, replyId]
    )
    const att = rows[0]
    if (!att) return reply.status(404).send('Anhang nicht gefunden.')
    try {
      const buffer = await fs.readFile(replyAttachmentPath(Number(replyId), att.filename))
      return reply
        .header('Content-Type', att.mimetype || 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${att.original_filename || att.filename}"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('Anhang-Datei nicht gefunden.')
    }
  })

  // PDF einer beliebigen Anzeige (Admin-Sicht) inline anzeigen.
  app.get('/admin/anzeigen/:id/pdf', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = await loadReportWithUser(id)
    if (!loaded?.report.pdf_filename) return reply.status(404).send('PDF nicht verfügbar.')

    try {
      const buffer = await fs.readFile(
        path.join(PDF_DIR, String(loaded.report.user_id), loaded.report.pdf_filename)
      )
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="${loaded.report.pdf_filename}"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('PDF-Datei nicht gefunden.')
    }
  })

  // Freigeben: Anzeige ans Ordnungsamt verschicken (Nutzer in Kopie).
  app.post('/admin/anzeigen/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = await loadReportWithUser(id)
    if (!loaded) return reply.status(404).send('Anzeige nicht gefunden.')
    if (loaded.report.status !== 'eingereicht') return reply.redirect('/admin/anzeigen')

    // Zwischen Einreichung und Freigabe kann sich das Profil geändert haben:
    // erneut prüfen und das PDF frisch erzeugen, damit Mail und PDF konsistent
    // den aktuellen Stand tragen.
    if (!(await isProfileComplete(loaded.report.user_id))) {
      setFlash(reply, 'error', `Profil von ${loaded.user.email} ist unvollständig – Anzeige nicht versendet (ggf. ablehnen).`)
      return reply.redirect('/admin/anzeigen')
    }

    try {
      await regeneratePdf(loaded.report.id, loaded.report.user_id)
      const fresh = await loadReportWithUser(id)
      if (fresh) loaded.report = fresh.report

      const sent = await MailService.sendReport(loaded.report, loaded.user)
      await pool.execute(
        "UPDATE reports SET status='versendet', versand_art='system_email', sent_message_id=? WHERE id=?",
        [sent.messageId.slice(0, 255) || null, loaded.report.id]
      )
      // Die Anzeige-Mail als erste Nachricht des Verlaufs festhalten.
      await pool.execute(
        `INSERT INTO report_replies (report_id, direction, message_id, from_address, subject, body_text, received_at, read_at)
         VALUES (?, 'out', ?, ?, ?, ?, NOW(), NOW())`,
        [
          loaded.report.id,
          sent.messageId.slice(0, 255) || `out:${loaded.report.id}:${Date.now()}`,
          (process.env.MAIL_FROM || '').slice(0, 255) || null,
          sent.subject.slice(0, 500),
          sent.text,
        ]
      )
      setFlash(reply, 'success', `Anzeige ${loaded.report.aktenzeichen} freigegeben und ans Ordnungsamt verschickt.`)
    } catch (err) {
      app.log.error({ err }, 'Versand nach Freigabe fehlgeschlagen')
      setFlash(reply, 'error', `Versand von ${loaded.report.aktenzeichen} fehlgeschlagen – Anzeige bleibt eingereicht.`)
    }
    return reply.redirect('/admin/anzeigen')
  })

  // Ablehnen: zurück in den Entwurf, Begründung speichern + Nutzer informieren.
  app.post('/admin/anzeigen/:id/reject', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const grund = String((request.body as { grund?: string })?.grund || '').trim()
    if (!grund) {
      setFlash(reply, 'error', 'Bitte eine Begründung angeben.')
      return reply.redirect('/admin/anzeigen')
    }

    const loaded = await loadReportWithUser(id)
    if (!loaded) return reply.status(404).send('Anzeige nicht gefunden.')
    if (loaded.report.status !== 'eingereicht') return reply.redirect('/admin/anzeigen')

    await pool.execute(
      "UPDATE reports SET status='entwurf', eingereicht_at=NULL, ablehnung_grund=? WHERE id=?",
      [grund, loaded.report.id]
    )
    try {
      await MailService.sendReportRejected(loaded.user, loaded.report, grund)
    } catch (err) {
      app.log.error({ err }, 'Ablehnungs-Mail fehlgeschlagen')
    }
    setFlash(reply, 'success', `Anzeige ${loaded.report.aktenzeichen} abgelehnt – der Nutzer wurde informiert.`)
    return reply.redirect('/admin/anzeigen')
  })
}
