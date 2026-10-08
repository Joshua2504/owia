// Admin-Prüfung: Nutzer reichen Anzeigen ein (status 'eingereicht'), ein Admin
// gibt sie hier frei (Versand ans Ordnungsamt per E-Mail, Nutzer optional in Kopie) oder
// lehnt sie mit Begründung ab (zurück in den Entwurf + Info-Mail an den Nutzer).
import { isVerjaehrt } from '../services/verjaehrung'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { requireAdmin, viewData, setFlash } from '../middleware/auth'
import { MailService } from '../services/mail'
import { dispatchReport, ReportPreparationError } from '../services/reportDispatch'
import { replyAttachmentPath, repliesDir } from '../services/mailInbox'
import { resolveSendCity } from '../services/districts'
import { regeneratePdf, isProfileComplete } from './reports'
import { deleteUser, UserDeleteError } from '../services/userDelete'
import { isAdminEmail } from '../config/admin'
import { enqueueJob, registerJob, recentJobs } from '../services/jobs'
import { usesPortal, enqueuePortalStart } from '../services/portalDispatch'

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

/** Admin-Freigabe einer eingereichten Anzeige: Prüfungen, PDF neu, Mail an das
 *  Ordnungsamt. Genutzt von der Freigabe in /admin/anzeigen und vom
 *  „Einreichen & versenden" eines Admins für eigene Anzeigen (reports.ts). */
export async function approveAndDispatch(
  id: string,
  aktenzeichen: string,
  log: FastifyBaseLogger
): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await dispatchReport(Number(id), async (messageId) => {
      const fresh = await loadReportWithUser(id)
      // Portal-Städte (Frankfurt) laufen ausschließlich über /versand (routes/portal.ts).
      if (fresh && usesPortal(fresh.report)) {
        throw new ReportPreparationError('Diese Anzeige wird über das Online-Portal der Stadt versendet – bitte unter „Versand".')
      }
      if (!fresh || !(await isProfileComplete(fresh.report.user_id))) {
        throw new ReportPreparationError('Das Nutzerprofil ist unvollständig. Bitte die Anzeige ablehnen und korrigieren lassen.')
      }
      if (isVerjaehrt(fresh.report)) {
        throw new ReportPreparationError('Die Tat ist verjährt (mehr als drei Monate her). Bitte die Anzeige ablehnen.')
      }
      const gate = resolveSendCity(fresh.report.tatort, fresh.report.city)
      if (!gate.ok) throw new ReportPreparationError(gate.message)
      await pool.execute('UPDATE reports SET city=? WHERE id=?', [gate.cityId, fresh.report.id])
      await regeneratePdf(fresh.report.id, fresh.report.user_id)
      const ready = await loadReportWithUser(id)
      if (!ready) throw new Error('Anzeige nicht mehr verfügbar.')
      return MailService.prepareReport(ready.report, ready.user, messageId)
    })
    if (result === 'sent') return { ok: true, message: `Anzeige ${aktenzeichen}: Versand abgeschlossen.` }
    return {
      ok: false,
      message: result === 'uncertain'
        ? 'Der Versand läuft oder sein Ergebnis ist unklar. Vor einem erneuten Versand muss der Mailserver geprüft werden.'
        : 'Die Anzeige wird bereits verarbeitet oder ist nicht mehr zur Freigabe verfügbar.',
    }
  } catch (err) {
    log.error({ err }, 'Freigabe/Versandabschluss fehlgeschlagen')
    return {
      ok: false,
      message: err instanceof ReportPreparationError ? err.message : 'Freigabe nicht abgeschlossen. Bitte den angezeigten Versandstatus prüfen; eine bereits verschickte Mail wird nicht automatisch erneut versendet.',
    }
  }
}

// Hintergrund-Jobs der Admin-Aktionen: Versand und Benachrichtigungen laufen
// nicht mehr im Request (services/jobs.ts). Mails werden mit frischen Daten
// erzeugt; Fehler landen in jobs.error und werden bis zu 3× wiederholt.
// Der Versand selbst nur einmal – dispatchReport sperrt über versand_status, ein
// unklares Ergebnis muss ein Mensch prüfen (docs/VERSANDBETRIEB.md).
registerJob('report.dispatch', async ({ reportId, aktenzeichen }, log) => {
  const outcome = await approveAndDispatch(String(reportId), aktenzeichen, log)
  if (!outcome.ok) throw new Error(outcome.message)
})

registerJob('mail.report-rejected', async ({ reportId, grund }) => {
  const loaded = await loadReportWithUser(String(reportId))
  if (loaded) await MailService.sendReportRejected(loaded.user, loaded.report, grund)
})

registerJob('mail.reply-notification', async ({ reportId }) => {
  const loaded = await loadReportWithUser(String(reportId))
  if (loaded) await MailService.sendReplyNotification(loaded.user, loaded.report)
})

// Ein Job pro Abonnent: einzelne Fehler blockieren die übrigen nicht und werden
// einzeln wiederholt.
registerJob('mail.newsletter', async ({ email, subject, text, unsubscribeUrl }) => {
  await MailService.sendNewsletterAnnouncement(email, subject, text, unsubscribeUrl)
})

export default async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/anzeigen', { preHandler: requireAdmin }, async (request, reply) => {
    const [pending] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.id, r.aktenzeichen, r.versand_status, r.city, r.pdf_filename, r.kennzeichen, r.kennzeichen_land, r.tattag, r.tattag_bis,
              r.tatzeit_von, r.tatzeit_bis, r.tatort, r.verstoss_art, r.beschreibung,
              r.behinderung, r.behinderung_text, r.fahrzeug_verlassen,
              DATE_FORMAT(r.eingereicht_at, '%d.%m.%Y %H:%i') AS eingereicht_fmt,
              u.email AS user_email, u.vorname, u.nachname, u.strasse, u.hausnummer, u.plz, u.ort,
              (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = r.id) AS image_count
         FROM reports r
         JOIN users u ON u.id = r.user_id
        WHERE r.status = 'eingereicht'
        ORDER BY r.eingereicht_at, r.id`
    )
    const [recent] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.id, r.aktenzeichen, r.kennzeichen, r.tatort, r.city, r.versand_art, r.pdf_filename, u.email AS user_email
         FROM reports r
         JOIN users u ON u.id = r.user_id
        WHERE r.status = 'versendet' AND r.versand_art IN ('system_email', 'portal')
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
        LIMIT 2000`
    )

    // Versand-Jobs je Anzeige (der jüngste zählt): „läuft" bzw. Fehlermeldung.
    const versandJobs: Record<number, { status: string; error: string | null }> = {}
    for (const job of await recentJobs('report.dispatch')) {
      versandJobs[Number(job.payload?.reportId)] = { status: job.status, error: job.error }
    }
    return reply.view('/admin/anzeigen.ejs', viewData(request, {
      title: 'Prüfung',
      pending,
      versandJobs,
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
      await enqueueJob('mail.reply-notification', { reportId: reports[0].id })
    }
    setFlash(reply, 'success', `Antwort der Anzeige ${az} zugeordnet.`)
    return reply.redirect('/admin/anzeigen')
  })

  // Nicht zugeordnete Antwort verwerfen (Spam/Fehlzustellung): Zeile samt
  // Anhängen löschen (DB-Kaskade + Dateien). Bewusst auf report_id IS NULL
  // beschränkt – zugeordnete Antworten sind Aktenbestandteil und bleiben.
  // Die Mail ist im Postfach bereits \Seen, der IMAP-Poll holt sie nicht erneut.
  async function discardUnmatchedReplies(ids: number[]): Promise<number> {
    let removed = 0
    for (const id of ids) {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        'DELETE FROM report_replies WHERE id = ? AND report_id IS NULL',
        [id]
      )
      if (result.affectedRows !== 1) continue
      removed++
      try {
        await fs.rm(repliesDir(id), { recursive: true, force: true })
      } catch (err) {
        app.log.error({ err, replyId: id }, 'Anhang-Verzeichnis der verworfenen Antwort nicht löschbar')
      }
    }
    return removed
  }

  app.post('/admin/replies/:id/discard', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (await discardUnmatchedReplies([Number(id)])) {
      setFlash(reply, 'success', 'Antwort verworfen.')
    } else {
      setFlash(reply, 'error', 'Antwort nicht gefunden oder bereits zugeordnet.')
    }
    return reply.redirect('/admin/anzeigen#antworten')
  })

  // Sammel-Verwerfen markierter, nicht zugeordneter Antworten (Spam-Flut).
  app.post('/admin/replies/bulk-discard', { preHandler: requireAdmin }, async (request, reply) => {
    const raw = (request.body as { ids?: string | string[] })?.ids
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
    const removed = await discardUnmatchedReplies(ids)
    setFlash(reply, removed ? 'success' : 'error',
      removed ? `${removed} Antwort(en) verworfen.` : 'Keine Antwort markiert.')
    return reply.redirect('/admin/anzeigen#antworten')
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

  // Freigeben: Anzeige ans Ordnungsamt verschicken (Nutzer je nach Einstellung in Kopie).
  app.post('/admin/anzeigen/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const loaded = await loadReportWithUser(id)
    if (!loaded) return reply.status(404).send('Anzeige nicht gefunden.')
    if (loaded.report.status !== 'eingereicht') return reply.redirect('/admin/anzeigen')
    // Portal-Städte: Lauf startet sofort im Hintergrund, /versand zeigt ihn live.
    if (usesPortal(loaded.report)) {
      const az = loaded.report.aktenzeichen
      const { problem, abMorgen } = await enqueuePortalStart(Number(loaded.report.id))
      if (problem) {
        setFlash(reply, 'error', `Anzeige ${az}: ${problem}`)
        return reply.redirect('/admin/anzeigen')
      }
      setFlash(reply, 'success', abMorgen
        ? `Anzeige ${az}: Tat von heute – der Portal-Versand startet automatisch nach Mitternacht.`
        : `Anzeige ${az}: Portal-Versand gestartet.`)
      return reply.redirect(`/versand?az=${encodeURIComponent(az)}`)
    }

    await enqueueJob('report.dispatch', { reportId: loaded.report.id, aktenzeichen: loaded.report.aktenzeichen },
      { key: `report.dispatch:${loaded.report.id}`, maxAttempts: 1 })
    setFlash(reply, 'success', `Anzeige ${loaded.report.aktenzeichen}: Versand läuft im Hintergrund.`)
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

    const [rejected] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE reports SET status='entwurf', eingereicht_at=NULL, ablehnung_grund=? WHERE id=? AND status='eingereicht' AND versand_status IS NULL",
      [grund, loaded.report.id]
    )
    if (!rejected.affectedRows) {
      setFlash(reply, 'error', 'Die Anzeige wird bereits versendet oder wurde inzwischen geändert.')
      return reply.redirect('/admin/anzeigen')
    }
    await enqueueJob('mail.report-rejected', { reportId: loaded.report.id, grund })
    setFlash(reply, 'success', `Anzeige ${loaded.report.aktenzeichen} abgelehnt – der Nutzer wurde informiert.`)
    return reply.redirect('/admin/anzeigen')
  })

  // ---------------------------------------------------------------------------
  // Benutzerübersicht: alle Konten mit Anzeigen-Kennzahlen. Nutzer schließen ihr
  // Konto selbst per Anonymisierung (routes/settings.ts); Admins können Konten
  // (z.B. Spam) zusätzlich vollständig löschen.
  // ---------------------------------------------------------------------------

  app.get('/admin/benutzer', { preHandler: requireAdmin }, async (request, reply) => {
    const [users] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT u.id, u.email, u.vorname, u.nachname, u.plz, u.ort, u.anonymized_at,
              DATE_FORMAT(u.created_at, '%d.%m.%Y') AS created_fmt,
              COUNT(r.id) AS reports_total,
              COALESCE(SUM(r.status = 'entwurf'), 0) AS drafts,
              COALESCE(SUM(r.status = 'eingereicht'), 0) AS submitted,
              COALESCE(SUM(r.status = 'versendet'), 0) AS sent,
              DATE_FORMAT(MAX(r.created_at), '%d.%m.%Y') AS last_report_fmt
         FROM users u
         LEFT JOIN reports r ON r.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at DESC`
    )
    // Fotoanzahl je Nutzer separat (über den JOIN oben würde COUNT(r.id) sonst
    // durch die report_images-Zeilen multipliziert).
    const [imgRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.user_id, COUNT(*) AS c
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        GROUP BY r.user_id`
    )
    const imagesByUser: Record<number, number> = {}
    for (const row of imgRows) imagesByUser[row.user_id] = Number(row.c)

    return reply.view('/admin/benutzer.ejs', viewData(request, {
      title: 'Benutzer',
      users,
      imagesByUser,
    }))
  })

  // Detailseite eines Nutzers: Stammdaten + alle seine Anzeigen mit Status.
  app.get('/admin/benutzer/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const [users] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, email, anrede, vorname, nachname, strasse, hausnummer, plz, ort, telefon, anonymized_at,
              DATE_FORMAT(created_at, '%d.%m.%Y') AS created_fmt
         FROM users WHERE id = ?`,
      [id]
    )
    const user = users[0]
    if (!user) return reply.status(404).send('Benutzer nicht gefunden.')

    const [reports] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.id, r.aktenzeichen, r.status, r.kennzeichen, r.kennzeichen_land,
              r.tatort, r.verstoss_art, r.ablehnung_grund,
              DATE_FORMAT(r.tattag, '%d.%m.%Y') AS tattag_fmt,
              TIME_FORMAT(r.tatzeit_von, '%H:%i') AS von_fmt,
              DATE_FORMAT(r.created_at, '%d.%m.%Y') AS created_fmt,
              DATE_FORMAT(r.eingereicht_at, '%d.%m.%Y %H:%i') AS eingereicht_fmt,
              (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = r.id) AS image_count,
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = r.id AND rr.direction = 'in') AS reply_count
         FROM reports r
        WHERE r.user_id = ?
        ORDER BY r.created_at DESC`,
      [id]
    )

    return reply.view('/admin/benutzer-detail.ejs', viewData(request, {
      title: `Benutzer – ${user.email}`,
      benutzer: user,
      reports,
    }))
  })

  app.post('/admin/benutzer/:id/delete', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (id === request.session.userId) {
      setFlash(reply, 'error', 'Das eigene Konto kann hier nicht gelöscht werden.')
      return reply.redirect(`/admin/benutzer/${id}`)
    }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT email FROM users WHERE id = ?', [id])
    if (rows[0] && isAdminEmail(rows[0].email)) {
      setFlash(reply, 'error', 'Admin-Konten können nicht gelöscht werden.')
      return reply.redirect(`/admin/benutzer/${id}`)
    }
    try {
      const { email } = await deleteUser(id)
      app.log.info({ userId: id, by: request.session.userId }, 'Benutzer durch Admin gelöscht')
      setFlash(reply, 'success', `Benutzer ${email} wurde mit allen Daten gelöscht.`)
      return reply.redirect('/admin/benutzer')
    } catch (err) {
      if (!(err instanceof UserDeleteError)) throw err
      setFlash(reply, 'error', err.message)
      return reply.redirect(rows[0] ? `/admin/benutzer/${id}` : '/admin/benutzer')
    }
  })

  // ---------------------------------------------------------------------------
  // Newsletter-Ankündigungen (z.B. neue Stadt/PLZ freigeschaltet) an alle
  // bestätigten Abonnenten. Anmeldung/Abmeldung läuft öffentlich (routes/public.ts).
  // ---------------------------------------------------------------------------

  app.get('/admin/newsletter', { preHandler: requireAdmin }, async (request, reply) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT
         SUM(confirmed_at IS NOT NULL) AS confirmed,
         SUM(confirmed_at IS NULL) AS pending
       FROM newsletter_subscribers`
    )
    // Nachfrage nach PLZ (nur bestätigte): zeigt, welche Gebiete sich als
    // Nächstes lohnen.
    const [plzRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT plz, COUNT(*) AS c FROM newsletter_subscribers
        WHERE confirmed_at IS NOT NULL AND plz IS NOT NULL
        GROUP BY plz ORDER BY c DESC, plz LIMIT 25`
    )
    return reply.view('/admin/newsletter.ejs', viewData(request, {
      title: 'Newsletter',
      confirmed: Number(rows[0]?.confirmed || 0),
      pendingCount: Number(rows[0]?.pending || 0),
      plzDemand: plzRows.map((r) => ({ plz: r.plz, count: Number(r.c) })),
    }))
  })

  app.post('/admin/newsletter/announce', { preHandler: requireAdmin }, async (request, reply) => {
    const { subject, text } = (request.body || {}) as { subject?: string; text?: string }
    if (!subject?.trim() || !text?.trim()) {
      setFlash(reply, 'error', 'Betreff und Text dürfen nicht leer sein.')
      return reply.redirect('/admin/newsletter')
    }

    const [subscribers] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT email, token FROM newsletter_subscribers WHERE confirmed_at IS NOT NULL'
    )
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')

    for (const sub of subscribers) {
      await enqueueJob('mail.newsletter', {
        email: sub.email,
        subject: subject.trim(),
        text,
        unsubscribeUrl: `${appUrl}/newsletter/abmelden/${sub.token}`,
      })
    }
    setFlash(reply, 'success', `Ankündigung an ${subscribers.length} Abonnenten wird im Hintergrund versendet.`)
    return reply.redirect('/admin/newsletter')
  })
}
