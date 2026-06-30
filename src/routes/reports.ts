import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import heicConvert from 'heic-convert'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { PdfService } from '../services/pdf'
import { MailService } from '../services/mail'

export const VERSTOSS_ARTEN = [
  'Parken auf dem Gehweg',
  'Parken im absoluten Halteverbot (Zeichen 283)',
  'Parken im eingeschränkten Halteverbot (Zeichen 286)',
  'Parken in der zweiten Reihe',
  'Parken auf einem Sonderfahrstreifen (Busspur/Radweg)',
  'Parken vor einer abgesenkten Bordsteinkante',
  'Parken in einer Feuerwehrzufahrt',
  'Parken auf einem Behindertenparkplatz ohne Ausweis',
  'Parken an einer Kreuzung oder Einmündung',
  'Fahren auf dem Gehweg oder Radweg',
  'Rotlichtverstoß',
  'Sonstiges',
]

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')
const DIRECT_IMAGE_TYPES = ['image/jpeg', 'image/png']

/** Direkt für PDF/Web verwendbares Bild plus aufbewahrtes Original. */
type PreparedImage = {
  buffer: Buffer // JPG/PNG, wird ins PDF eingebettet und im Web angezeigt
  mimetype: string
  ext: string
  originalBuffer: Buffer // exakt wie hochgeladen (z.B. HEIC)
  originalMimetype: string
  originalExt: string
  converted: boolean
}

/** Buffer, den der PDF-Service einbettet. */
export type ReportImage = { mimetype: string; buffer: Buffer }

function extFromMime(mime: string): string {
  return mime === 'image/png' ? 'png' : 'jpg'
}

function extFromName(filename: string, fallback: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : fallback
}

/** Browser melden HEIC uneinheitlich – daher MIME *und* Dateiendung prüfen. */
function isHeic(filename: string, mimetype: string): boolean {
  const f = filename.toLowerCase()
  return (
    mimetype.startsWith('image/heic') ||
    mimetype.startsWith('image/heif') ||
    f.endsWith('.heic') ||
    f.endsWith('.heif')
  )
}

export default async function reportsRoutes(app: FastifyInstance) {
  app.get('/report/new', { preHandler: requireAuth }, async (request, reply) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT vorname, nachname, strasse, plz, ort, telefon, email FROM users WHERE id = ?',
      [request.session.userId]
    )
    return reply.view('/reports/new.ejs', viewData(request, {
      title: 'Neue Anzeige',
      verstossArten: VERSTOSS_ARTEN,
      user: rows[0],
    }))
  })

  app.post('/report', { preHandler: requireAuth }, async (request, reply) => {
    const fields: Record<string, string> = {}
    const prepared: PreparedImage[] = []
    let imageError: string | null = null

    async function renderForm(error: string) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT vorname, nachname, strasse, plz, ort, telefon, email FROM users WHERE id = ?',
        [request.session.userId]
      )
      return reply.view('/reports/new.ejs', viewData(request, {
        title: 'Neue Anzeige',
        verstossArten: VERSTOSS_ARTEN,
        user: rows[0],
        error,
        values: fields,
      }))
    }

    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') {
          fields[part.fieldname] = String(part.value)
          continue
        }

        const buffer = await part.toBuffer()
        if (part.fieldname !== 'bilder' || !part.filename || buffer.length === 0) {
          continue
        }
        const mimetype = part.mimetype || ''

        if (DIRECT_IMAGE_TYPES.includes(mimetype)) {
          const ext = extFromMime(mimetype)
          prepared.push({
            buffer,
            mimetype,
            ext,
            originalBuffer: buffer,
            originalMimetype: mimetype,
            originalExt: ext,
            converted: false,
          })
        } else if (isHeic(part.filename, mimetype)) {
          try {
            const jpeg = Buffer.from(
              await heicConvert({ buffer, format: 'JPEG', quality: 0.85 })
            )
            prepared.push({
              buffer: jpeg,
              mimetype: 'image/jpeg',
              ext: 'jpg',
              originalBuffer: buffer,
              originalMimetype: mimetype || 'image/heic',
              originalExt: extFromName(part.filename, 'heic'),
              converted: true,
            })
          } catch (err) {
            app.log.error({ err }, 'HEIC-Konvertierung fehlgeschlagen')
            imageError = 'Ein HEIC-Bild konnte nicht umgewandelt werden. Bitte als JPG/PNG hochladen.'
          }
        } else {
          imageError = 'Es werden nur JPG-, PNG- und HEIC/HEIF-Bilder unterstützt.'
        }
      }
    } catch (err) {
      app.log.warn({ err }, 'Upload abgebrochen')
      return renderForm(
        'Mindestens ein Bild ist zu groß (max. 20 MB) oder es wurden zu viele Bilder hochgeladen (max. 10).'
      )
    }

    const { kennzeichen, fahrzeug_marke, tattag, tatzeit_von, tatzeit_bis, tatort, verstoss_art, beschreibung } =
      fields

    if (!kennzeichen || !tattag || !tatzeit_von || !tatort || !verstoss_art) {
      return renderForm('Bitte alle Pflichtfelder ausfüllen.')
    }
    if (imageError) {
      return renderForm(imageError)
    }

    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO reports
         (user_id, kennzeichen, fahrzeug_marke, tattag, tatzeit_von, tatzeit_bis, tatort, verstoss_art, beschreibung)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.session.userId,
        kennzeichen.toUpperCase().trim(),
        fahrzeug_marke || null,
        tattag,
        tatzeit_von,
        tatzeit_bis || null,
        tatort,
        verstoss_art,
        beschreibung || null,
      ]
    )
    const reportId = result.insertId

    // Bilder für den Nutzer speichern (nutzbares JPG/PNG + ggf. HEIC-Original)
    if (prepared.length > 0) {
      const dir = path.join(UPLOAD_DIR, String(request.session.userId), String(reportId))
      await fs.mkdir(dir, { recursive: true })
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i]
        const filename = `bild-${i + 1}.${p.ext}`
        await fs.writeFile(path.join(dir, filename), p.buffer)

        let originalFilename = filename
        if (p.converted) {
          originalFilename = `bild-${i + 1}-original.${p.originalExt}`
          await fs.writeFile(path.join(dir, originalFilename), p.originalBuffer)
        }

        await pool.execute(
          `INSERT INTO report_images (report_id, filename, mimetype, original_filename, original_mimetype)
           VALUES (?, ?, ?, ?, ?)`,
          [reportId, filename, p.mimetype, originalFilename, p.originalMimetype]
        )
      }
    }

    try {
      const [userRows] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT * FROM users WHERE id = ?',
        [request.session.userId]
      )
      const [reportRows] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT * FROM reports WHERE id = ?',
        [reportId]
      )
      const pdfImages: ReportImage[] = prepared.map((p) => ({
        mimetype: p.mimetype,
        buffer: p.buffer,
      }))
      const pdfFilename = await PdfService.generate(reportRows[0], userRows[0], pdfImages)
      await pool.execute('UPDATE reports SET pdf_filename=? WHERE id=?', [pdfFilename, reportId])
    } catch (err) {
      app.log.error({ err }, 'PDF-Generierung fehlgeschlagen')
    }

    request.session.flash = { type: 'success', message: 'Anzeige erfolgreich eingereicht.' }
    await request.session.save()
    return reply.redirect(`/report/${reportId}`)
  })

  app.get('/report/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM reports WHERE id = ? AND user_id = ?',
      [id, request.session.userId]
    )
    if (!rows[0]) return reply.status(404).send('Anzeige nicht gefunden.')

    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, original_filename FROM report_images WHERE report_id = ? ORDER BY id',
      [id]
    )
    return reply.view('/reports/show.ejs', viewData(request, {
      title: `Anzeige #${id}`,
      report: rows[0],
      images,
    }))
  })

  app.get('/report/:id/image/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { id, imageId } = request.params as { id: string; imageId: string }
    const wantOriginal = (request.query as { original?: string }).original === '1'

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.mimetype, ri.original_filename, ri.original_mimetype
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.id = ? AND r.user_id = ?`,
      [imageId, id, request.session.userId]
    )
    const image = rows[0]
    if (!image) return reply.status(404).send('Bild nicht gefunden.')

    const filename = wantOriginal ? image.original_filename : image.filename
    const mimetype = wantOriginal ? image.original_mimetype : image.mimetype

    const imagePath = path.join(
      UPLOAD_DIR,
      String(request.session.userId),
      String(id),
      filename
    )
    try {
      const buffer = await fs.readFile(imagePath)
      const reply2 = reply.header('Content-Type', mimetype || 'application/octet-stream')
      if (wantOriginal) {
        reply2.header('Content-Disposition', `attachment; filename="${filename}"`)
      }
      return reply2.send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })

  app.get('/report/:id/pdf', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT pdf_filename FROM reports WHERE id = ? AND user_id = ?',
      [id, request.session.userId]
    )
    const report = rows[0]
    if (!report?.pdf_filename) return reply.status(404).send('PDF nicht verfügbar.')

    const pdfPath = path.join(
      process.cwd(),
      'data/pdfs',
      String(request.session.userId),
      report.pdf_filename
    )
    try {
      const buffer = await fs.readFile(pdfPath)
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="anzeige-${id}.pdf"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('PDF-Datei nicht gefunden.')
    }
  })

  app.post('/report/:id/send', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM reports WHERE id = ? AND user_id = ?',
      [id, request.session.userId]
    )
    const report = rows[0]
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (!report.pdf_filename) {
      request.session.flash = { type: 'error', message: 'PDF konnte nicht gefunden werden.' }
      await request.session.save()
      return reply.redirect(`/report/${id}`)
    }

    const [userRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ?',
      [request.session.userId]
    )

    try {
      await MailService.sendReport(report, userRows[0])
      await pool.execute('UPDATE reports SET status=? WHERE id=?', ['versendet', id])
      request.session.flash = { type: 'success', message: 'Anzeige wurde per E-Mail versendet.' }
    } catch (err) {
      app.log.error({ err }, 'E-Mail-Versand fehlgeschlagen')
      request.session.flash = { type: 'error', message: 'E-Mail-Versand fehlgeschlagen.' }
    }

    await request.session.save()
    return reply.redirect(`/report/${id}`)
  })
}
