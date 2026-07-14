import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { ZipArchive } from 'archiver'
import { pool } from '../db/connection'
import { requireAuth, viewData, setFlash } from '../middleware/auth'
import { reportDir, UPLOAD_DIR } from '../services/drafts'
import { replyAttachmentPath } from '../services/mailInbox'

const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')

/** Dateinamen für den ZIP-Export bereinigen. */
function safeName(name: string): string {
  return (name || 'datei').replace(/[^\wäöüÄÖÜß .()-]/g, '_').slice(0, 150)
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/einstellungen', { preHandler: requireAuth }, async (request, reply) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT email, vorname, nachname, strasse, plz, ort, telefon FROM users WHERE id = ?',
      [request.session.userId]
    )
    return reply.view('/settings/index.ejs', viewData(request, {
      title: 'Einstellungen',
      user: rows[0],
    }))
  })

  app.post('/einstellungen', { preHandler: requireAuth }, async (request, reply) => {
    const { vorname, nachname, strasse, plz, ort, telefon } =
      request.body as Record<string, string>

    await pool.execute(
      `UPDATE users SET vorname=?, nachname=?, strasse=?, plz=?, ort=?, telefon=?
       WHERE id = ?`,
      [vorname, nachname, strasse, plz, ort, telefon, request.session.userId]
    )

    const name = [vorname, nachname].filter(Boolean).join(' ')
    request.session.userName = name || request.session.userEmail
    setFlash(reply, 'success', 'Einstellungen gespeichert.')
    return reply.redirect('/einstellungen')
  })

  // DSGVO-Datenexport (Art. 15/20): ZIP mit ALLEN gespeicherten Daten des
  // Nutzers – daten.json (maschinenlesbar) plus sämtliche Dateien (Beweisfotos
  // inkl. Originalen, PDFs, Mail-Anhänge, unzugeordnete Import-Fotos).
  // Sitzungs-/Anmelde-Artefakte (Sessions, Einmal-Tokens) sind flüchtige
  // Sicherheitsdaten und nicht Teil des Exports.
  app.get('/einstellungen/export', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number

    const [users] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, email, vorname, nachname, strasse, plz, ort, telefon, created_at
         FROM users WHERE id = ?`,
      [userId]
    )
    const [reports] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM reports WHERE user_id = ? ORDER BY id',
      [userId]
    )
    const reportIds = reports.map((r) => r.id)
    const ph = reportIds.map(() => '?').join(',')

    let images: mysql.RowDataPacket[] = []
    let replies: mysql.RowDataPacket[] = []
    let attachments: mysql.RowDataPacket[] = []
    if (reportIds.length) {
      ;[images] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, report_id, filename, original_filename, mimetype, sort_order,
                captured_at, gps_lat, gps_lon, created_at
           FROM report_images WHERE report_id IN (${ph}) ORDER BY report_id, sort_order`,
        reportIds
      )
      ;[replies] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, report_id, direction, from_address, subject, body_text, received_at, read_at
           FROM report_replies WHERE report_id IN (${ph}) ORDER BY report_id, id`,
        reportIds
      )
      if (replies.length) {
        const rph = replies.map(() => '?').join(',')
        ;[attachments] = await pool.execute<mysql.RowDataPacket[]>(
          `SELECT id, reply_id, filename, original_filename, mimetype, size_bytes, created_at
             FROM report_reply_attachments WHERE reply_id IN (${rph}) ORDER BY reply_id, id`,
          replies.map((r) => r.id)
        )
      }
    }
    const [batches] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, status, created_at, grouped_at FROM intake_batches WHERE user_id = ? ORDER BY id',
      [userId]
    )
    const [intakePhotos] = batches.length
      ? await pool.execute<mysql.RowDataPacket[]>(
          `SELECT id, batch_id, filename, upload_name, captured_at, gps_lat, gps_lon, created_at
             FROM intake_photos
            WHERE batch_id IN (${batches.map(() => '?').join(',')}) AND report_id IS NULL`,
          batches.map((b) => b.id)
        )
      : [[] as mysql.RowDataPacket[]]

    // Zu packende Dateien einsammeln: Zip-Pfad -> absoluter Pfad auf Platte.
    // (Fehlende Dateien werden übersprungen, damit der Export nie scheitert.)
    const files: { zipPath: string; absPath: string }[] = []
    const azById = new Map(reports.map((r) => [r.id, r.aktenzeichen]))

    for (const r of reports) {
      const dir = `anzeigen/${safeName(r.aktenzeichen || String(r.id))}`
      if (r.pdf_filename) {
        files.push({ zipPath: `${dir}/${safeName(r.pdf_filename)}`, absPath: path.join(PDF_DIR, String(userId), r.pdf_filename) })
      }
    }
    for (const i of images) {
      const dir = `anzeigen/${safeName(azById.get(i.report_id) || String(i.report_id))}/fotos`
      const nr = String(i.sort_order || 0).padStart(2, '0')
      i.datei = `${dir}/${nr}-${safeName(i.filename)}`
      files.push({ zipPath: i.datei, absPath: path.join(reportDir(userId, i.report_id), i.filename) })
      if (i.original_filename && i.original_filename !== i.filename) {
        i.original_datei = `${dir}/${nr}-original-${safeName(i.original_filename)}`
        files.push({ zipPath: i.original_datei, absPath: path.join(reportDir(userId, i.report_id), i.original_filename) })
      }
    }
    const replyById = new Map(replies.map((r) => [r.id, r]))
    for (const a of attachments) {
      const az = azById.get(replyById.get(a.reply_id)?.report_id) || 'unbekannt'
      a.datei = `anzeigen/${safeName(az)}/nachrichten/anhang-${a.id}-${safeName(a.original_filename || a.filename)}`
      files.push({ zipPath: a.datei, absPath: replyAttachmentPath(a.reply_id, a.filename) })
    }
    for (const p of intakePhotos) {
      p.datei = `foto-import/batch-${p.batch_id}/${safeName(p.upload_name || p.filename)}`
      files.push({
        zipPath: p.datei,
        absPath: path.join(UPLOAD_DIR, String(userId), 'intake', String(p.batch_id), p.filename),
      })
    }

    const strip = ({ filename, ...rest }: Record<string, unknown>) => rest // interne Dateinamen nicht exportieren
    const exportData = {
      hinweis:
        'Datenexport gemäß Art. 15/20 DSGVO. Alle Dateien (Fotos, PDFs, Anhänge) liegen in diesem ZIP; die "datei"-Felder verweisen auf die Pfade im Archiv.',
      exportiert_am: new Date().toISOString(),
      nutzer: users[0],
      anzeigen: reports.map((r) => ({
        ...r,
        pdf_datei: r.pdf_filename ? `anzeigen/${safeName(r.aktenzeichen || String(r.id))}/${safeName(r.pdf_filename)}` : null,
        fotos: images.filter((i) => i.report_id === r.id).map(strip),
        nachrichten: replies
          .filter((m) => m.report_id === r.id)
          .map((m) => ({
            ...m,
            anhaenge: attachments.filter((a) => a.reply_id === m.id).map(strip),
          })),
      })),
      foto_importe: batches.map((b) => ({
        ...b,
        nicht_zugeordnete_fotos: intakePhotos.filter((p) => p.batch_id === b.id).map(strip),
      })),
    }

    // ZIP streamen: daten.json + alle vorhandenen Dateien.
    const datum = new Date().toISOString().slice(0, 10)
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="owia-datenexport-${datum}.zip"`)

    const archive = new ZipArchive({ zlib: { level: 6 } })
    archive.on('warning', (err: Error) => app.log.warn({ err }, 'DSGVO-Export: Warnung'))
    archive.on('error', (err: Error) => app.log.error({ err }, 'DSGVO-Export: Fehler'))

    archive.append(JSON.stringify(exportData, null, 2), { name: 'daten.json' })
    for (const f of files) {
      try {
        await fs.access(f.absPath)
        archive.file(f.absPath, { name: f.zipPath })
      } catch {
        app.log.warn({ file: f.absPath }, 'DSGVO-Export: Datei fehlt – übersprungen')
      }
    }
    void archive.finalize()
    return reply.send(archive)
  })
}
