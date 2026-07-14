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
              u.email AS user_email,
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
    return reply.view('/admin/anzeigen.ejs', viewData(request, {
      title: 'Prüfung',
      pending,
      recent,
    }))
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
        .header('Content-Disposition', `inline; filename="${loaded.report.aktenzeichen}.pdf"`)
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

    try {
      await MailService.sendReport(loaded.report, loaded.user)
      await pool.execute(
        "UPDATE reports SET status='versendet', versand_art='system_email' WHERE id=?",
        [loaded.report.id]
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
