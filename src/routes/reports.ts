import { FastifyInstance, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import heicConvert from 'heic-convert'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { PdfService } from '../services/pdf'
import { MailService, buildReportMail } from '../services/mail'
import { getCity, DEFAULT_CITY_ID } from '../config/cities'

export const VERSTOSS_ARTEN = [
  'Parken auf dem Gehweg',
  'Parken im absoluten Halteverbot (Zeichen 283)',
  'Parken im eingeschränkten Halteverbot (Zeichen 286)',
  'Parken in der zweiten Reihe',
  'Halten und Parken auf einem Radweg',
  'Parken auf einem Sonderfahrstreifen (Busspur/Radweg)',
  'Parken vor einer abgesenkten Bordsteinkante',
  'Parken in einer Feuerwehrzufahrt',
  'Parken auf einem Behindertenparkplatz ohne Ausweis',
  'Parken an einer Kreuzung oder Einmündung',
  'Sonstiges',
]

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')
const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')
const DIRECT_IMAGE_TYPES = ['image/jpeg', 'image/png']
const MAX_IMAGES = 10

/**
 * Ob die Anzeige über unser System per E-Mail ans Ordnungsamt versendet werden
 * darf ("Wir verschicken"). In Produktion vorerst deaktiviert; per Umgebungs-
 * variable SYSTEM_EMAIL_SENDING=on (bzw. =off) gezielt überschreibbar.
 */
function isSystemEmailEnabled(): boolean {
  const v = (process.env.SYSTEM_EMAIL_SENDING || '').toLowerCase()
  if (['on', '1', 'true', 'yes'].includes(v)) return true
  if (['off', '0', 'false', 'no'].includes(v)) return false
  return process.env.NODE_ENV !== 'production'
}

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

// Aktenzeichen-Alphabet ohne leicht verwechselbare Zeichen (0/O, 1/I).
// 32 Zeichen → 256 % 32 == 0, daher kein Modulo-Bias bei randomBytes.
const AKTENZEICHEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Zufälliges, nicht aus der ID ableitbares Aktenzeichen, z.B. "OWiAA-7K3QF2".
 *  Bindestrich statt '#', damit es direkt in URLs/Links verwendbar ist. */
function generateAktenzeichen(): string {
  const bytes = crypto.randomBytes(6)
  let code = ''
  for (let i = 0; i < bytes.length; i++) {
    code += AKTENZEICHEN_ALPHABET[bytes[i] % AKTENZEICHEN_ALPHABET.length]
  }
  return `OWiAA-${code}`
}

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

/** Hochgeladenes Bild in ein nutzbares JPG/PNG (+ ggf. HEIC-Original) überführen. */
async function prepareImage(
  buffer: Buffer,
  filename: string,
  mimetype: string
): Promise<PreparedImage> {
  if (DIRECT_IMAGE_TYPES.includes(mimetype)) {
    const ext = extFromMime(mimetype)
    return {
      buffer,
      mimetype,
      ext,
      originalBuffer: buffer,
      originalMimetype: mimetype,
      originalExt: ext,
      converted: false,
    }
  }
  if (isHeic(filename, mimetype)) {
    const jpeg = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.85 }))
    return {
      buffer: jpeg,
      mimetype: 'image/jpeg',
      ext: 'jpg',
      originalBuffer: buffer,
      originalMimetype: mimetype || 'image/heic',
      originalExt: extFromName(filename, 'heic'),
      converted: true,
    }
  }
  throw new Error('unsupported')
}

/** Vorbereitetes Bild (+ ggf. Original) auf Platte schreiben; gibt die Dateinamen zurück. */
async function writeImageFiles(
  userId: number,
  reportId: number,
  p: PreparedImage
): Promise<{ filename: string; originalFilename: string }> {
  const dir = path.join(UPLOAD_DIR, String(userId), String(reportId))
  await fs.mkdir(dir, { recursive: true })

  const base = `bild-${crypto.randomBytes(6).toString('hex')}`
  const filename = `${base}.${p.ext}`
  await fs.writeFile(path.join(dir, filename), p.buffer)

  let originalFilename = filename
  if (p.converted) {
    originalFilename = `${base}-original.${p.originalExt}`
    await fs.writeFile(path.join(dir, originalFilename), p.originalBuffer)
  }
  return { filename, originalFilename }
}

/** Alte Bilddateien (nutzbare Fassung + Original) entfernen. */
async function removeImageFiles(
  userId: number,
  reportId: number | string,
  filename: string,
  originalFilename: string
): Promise<void> {
  const dir = path.join(UPLOAD_DIR, String(userId), String(reportId))
  try {
    await fs.rm(path.join(dir, filename), { force: true })
    if (originalFilename && originalFilename !== filename) {
      await fs.rm(path.join(dir, originalFilename), { force: true })
    }
  } catch {
    /* Dateien evtl. schon weg */
  }
}

/** Bild zum Entwurf auf Platte + in der DB speichern; gibt die neue Bild-ID zurück. */
async function saveImageToReport(
  userId: number,
  reportId: number,
  p: PreparedImage
): Promise<{ id: number; filename: string }> {
  const { filename, originalFilename } = await writeImageFiles(userId, reportId, p)

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images (report_id, filename, mimetype, original_filename, original_mimetype)
     VALUES (?, ?, ?, ?, ?)`,
    [reportId, filename, p.mimetype, originalFilename, p.originalMimetype]
  )
  return { id: result.insertId, filename }
}

async function loadReport(
  reportId: string | number,
  userId: number
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM reports WHERE id = ? AND user_id = ?',
    [reportId, userId]
  )
  return rows[0]
}

/** Wie loadReport, aber per Aktenzeichen (wird in den URLs/Links verwendet). */
async function loadReportByAktenzeichen(
  aktenzeichen: string,
  userId: number
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM reports WHERE aktenzeichen = ? AND user_id = ?',
    [aktenzeichen, userId]
  )
  return rows[0]
}

/** Felder eines Entwurfs persistieren (leere Strings -> NULL). */
async function persistFields(
  reportId: string | number,
  userId: number,
  v: Record<string, string | undefined>
): Promise<void> {
  const behinderung = v.behinderung === 'ja' ? 1 : v.behinderung === 'nein' ? 0 : null
  // Text immer aufbewahren (falls später doch wieder „Ja"); im PDF wird er nur
  // bei behinderung=1 angezeigt.
  const behinderungText = v.behinderung_text || null
  // Tatort-Koordinaten (Karte/Marker) nur übernehmen, wenn beide gültig sind.
  const lat = Number(v.tatort_lat)
  const lon = Number(v.tatort_lon)
  const tatortLat = Number.isFinite(lat) ? lat : null
  const tatortLon = Number.isFinite(lon) ? lon : null
  await pool.execute(
    `UPDATE reports
       SET kennzeichen=?, fahrzeug_marke=?, tattag=?, tatzeit_von=?, tatzeit_bis=?,
           tatort=?, tatort_lat=?, tatort_lon=?, verstoss_art=?, beschreibung=?,
           behinderung=?, behinderung_text=?
     WHERE id=? AND user_id=? AND status='entwurf'`,
    [
      v.kennzeichen ? v.kennzeichen.toUpperCase().trim() : null,
      v.fahrzeug_marke || null,
      v.tattag || null,
      v.tatzeit_von || null,
      v.tatzeit_bis || null,
      v.tatort || null,
      tatortLat,
      tatortLon,
      v.verstoss_art || null,
      v.beschreibung || null,
      behinderung,
      behinderungText,
      reportId,
      userId,
    ]
  )
}

function isComplete(r: mysql.RowDataPacket): boolean {
  return !!(r.kennzeichen && r.tattag && r.tatzeit_von && r.tatort && r.verstoss_art)
}

/** PDF aus dem aktuellen Stand (inkl. gespeicherter Bilder) neu erzeugen. */
async function regeneratePdf(reportId: string | number, userId: number): Promise<void> {
  const report = await loadReport(reportId, userId)
  if (!report) return
  const [uRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM users WHERE id = ?',
    [userId]
  )
  const user = uRows[0]
  const [imgRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT filename, mimetype FROM report_images WHERE report_id = ? ORDER BY id',
    [reportId]
  )

  const dir = path.join(UPLOAD_DIR, String(userId), String(reportId))
  const images: ReportImage[] = []
  for (const row of imgRows) {
    try {
      const buffer = await fs.readFile(path.join(dir, row.filename))
      images.push({ mimetype: row.mimetype, buffer })
    } catch {
      // Datei fehlt – überspringen
    }
  }

  // Altes PDF entfernen, damit keine verwaisten Dateien liegen bleiben.
  if (report.pdf_filename) {
    try {
      await fs.rm(path.join(PDF_DIR, String(userId), report.pdf_filename), { force: true })
    } catch {
      /* egal */
    }
  }

  try {
    const filename = await PdfService.generate(report, user, images)
    await pool.execute('UPDATE reports SET pdf_filename=? WHERE id=?', [filename, reportId])
  } catch (err) {
    // PDF-Erzeugung darf den Workflow nicht blockieren; Vorschau bleibt dann leer.
    console.error('PDF-Generierung fehlgeschlagen', err)
  }
}

export default async function reportsRoutes(app: FastifyInstance) {
  // Eigene, noch nicht versendete Anzeigen (Entwürfe) mit Koordinaten – für die
  // Karte im Dashboard. Versendete erscheinen bereits (anonym) über die
  // öffentliche Übersicht, daher hier ausgenommen.
  app.get('/api/my/reports', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT aktenzeichen, status, tattag, verstoss_art, tatort, tatort_lat, tatort_lon
         FROM reports
        WHERE user_id = ? AND status <> 'versendet'
          AND tatort_lat IS NOT NULL AND tatort_lon IS NOT NULL
        ORDER BY created_at DESC`,
      [userId]
    )
    const reports = rows.map((r) => ({
      lat: Number(r.tatort_lat),
      lon: Number(r.tatort_lon),
      aktenzeichen: r.aktenzeichen,
      status: r.status,
      verstossArt: r.verstoss_art || null,
      tattag: r.tattag || null,
      tatort: r.tatort || null,
      url: `/report/${r.aktenzeichen}/edit`,
    }))
    return reply.send({ reports })
  })

  // ---------------------------------------------------------------------------
  // Entwurf anlegen + bearbeiten
  // ---------------------------------------------------------------------------

  app.post('/report/new', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    // Tattag/Tatzeit mit dem aktuellen Zeitpunkt vorbelegen (häufigster Fall: Vorfall jetzt).
    // Aktenzeichen ist zufällig + eindeutig; bei (extrem seltener) Kollision neu würfeln.
    let aktenzeichen: string | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateAktenzeichen()
      try {
        await pool.execute<mysql.ResultSetHeader>(
          `INSERT INTO reports (user_id, status, tattag, tatzeit_von, aktenzeichen, city)
           VALUES (?, 'entwurf', CURDATE(), CURTIME(), ?, ?)`,
          [userId, candidate, DEFAULT_CITY_ID]
        )
        aktenzeichen = candidate
        break
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY' && attempt < 4) continue
        throw err
      }
    }
    return reply.redirect(`/report/${aktenzeichen}/edit`)
  })

  app.get('/report/:az/edit', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/report/${az}`)

    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, original_filename FROM report_images WHERE report_id = ? ORDER BY id',
      [report.id]
    )
    return reply.view('/reports/edit.ejs', viewData(request, {
      title: 'Entwurf bearbeiten',
      verstossArten: VERSTOSS_ARTEN,
      report,
      images,
      city: getCity(report.city),
    }))
  })

  // Hintergrund-Autosave der Textfelder (JSON).
  app.patch('/report/:az', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })

    await persistFields(report.id, userId, (request.body || {}) as Record<string, string>)
    return reply.send({ ok: true })
  })

  // Einzelnes (ggf. bereits geschwärztes) Bild sofort zum Entwurf hochladen.
  app.post('/report/:az/images', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })
    const reportId = report.id

    const [cntRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ?',
      [reportId]
    )
    let count = Number(cntRows[0].c)

    const saved: { id: number; url: string }[] = []
    const errors: string[] = []
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        if (part.fieldname !== 'bilder' || !part.filename) continue
        const buffer = await part.toBuffer()
        if (buffer.length === 0) continue
        if (count >= MAX_IMAGES) {
          errors.push(`Maximal ${MAX_IMAGES} Bilder pro Anzeige.`)
          continue
        }
        try {
          const prepared = await prepareImage(buffer, part.filename, part.mimetype || '')
          const row = await saveImageToReport(userId, reportId, prepared)
          saved.push({ id: row.id, url: `/report/${az}/image/${row.id}` })
          count++
        } catch {
          errors.push('Nur JPG-, PNG- und HEIC/HEIF-Bilder werden unterstützt.')
        }
      }
    } catch {
      return reply.status(413).send({ error: 'Bild zu groß (max. 20 MB).', images: saved })
    }

    return reply.send({ images: saved, errors })
  })

  app.delete('/report/:az/images/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.original_filename, r.id AS report_id
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ? AND r.status = 'entwurf'`,
      [imageId, az, userId]
    )
    const img = rows[0]
    if (!img) return reply.status(404).send({ error: 'not found' })

    await pool.execute('DELETE FROM report_images WHERE id = ?', [imageId])
    await removeImageFiles(userId, img.report_id, img.filename, img.original_filename)
    return reply.send({ ok: true })
  })

  // Bestehendes Bild durch eine neue (z.B. geschwärzte) Fassung ersetzen.
  // Die Bild-ID bleibt erhalten, das Bilder-Limit wird nicht berührt.
  app.put('/report/:az/images/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.original_filename, r.id AS report_id
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ? AND r.status = 'entwurf'`,
      [imageId, az, userId]
    )
    const old = rows[0]
    if (!old) return reply.status(404).send({ error: 'not found' })

    let prepared: PreparedImage | null = null
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'bilder' || !part.filename) continue
        const buffer = await part.toBuffer()
        if (buffer.length === 0) continue
        prepared = await prepareImage(buffer, part.filename, part.mimetype || '')
        break // nur das erste Bild ersetzt die bestehende Fassung
      }
    } catch {
      return reply.status(413).send({ error: 'Bild zu groß (max. 20 MB).' })
    }
    if (!prepared) {
      return reply.status(400).send({ error: 'Kein gültiges Bild übermittelt.' })
    }

    const { filename, originalFilename } = await writeImageFiles(userId, old.report_id, prepared)
    await pool.execute(
      `UPDATE report_images
         SET filename=?, mimetype=?, original_filename=?, original_mimetype=?
       WHERE id=?`,
      [filename, prepared.mimetype, originalFilename, prepared.originalMimetype, imageId]
    )
    await removeImageFiles(userId, old.report_id, old.filename, old.original_filename)

    return reply.send({ image: { id: Number(imageId), url: `/report/${az}/image/${imageId}` } })
  })

  // „Entwurf speichern": finale Werte sichern, PDF erzeugen, zur Detailseite.
  app.post('/report/:az/save', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/report/${az}`)

    await persistFields(report.id, userId, (request.body || {}) as Record<string, string>)
    await regeneratePdf(report.id, userId)

    request.session.flash = { type: 'success', message: 'Entwurf gespeichert.' }
    await request.session.save()
    return reply.redirect(`/report/${az}`)
  })

  app.post('/report/:az/discard', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/report/${az}`)
    const reportId = report.id

    await pool.execute('DELETE FROM reports WHERE id = ? AND user_id = ?', [reportId, userId])
    try {
      await fs.rm(path.join(UPLOAD_DIR, String(userId), String(reportId)), { recursive: true, force: true })
    } catch {
      /* egal */
    }
    if (report.pdf_filename) {
      try {
        await fs.rm(path.join(PDF_DIR, String(userId), report.pdf_filename), { force: true })
      } catch {
        /* egal */
      }
    }

    request.session.flash = { type: 'success', message: 'Entwurf verworfen.' }
    await request.session.save()
    return reply.redirect('/dashboard')
  })

  // ---------------------------------------------------------------------------
  // Detail / Versand
  // ---------------------------------------------------------------------------

  app.get('/report/:az', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')

    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, original_filename FROM report_images WHERE report_id = ? ORDER BY id',
      [report.id]
    )
    const [uRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    )
    const mailExample = buildReportMail(report, uRows[0])

    const city = getCity(report.city)
    return reply.view('/reports/show.ejs', viewData(request, {
      title: `Anzeige ${report.aktenzeichen || ''}`,
      report,
      images,
      complete: isComplete(report),
      mailExample,
      city,
      empfaenger: city.email,
      systemSendEnabled: isSystemEmailEnabled(),
    }))
  })

  app.get('/report/:az/image/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const wantOriginal = (request.query as { original?: string }).original === '1'

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.mimetype, ri.original_filename, ri.original_mimetype, r.id AS report_id
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ?`,
      [imageId, az, userId]
    )
    const image = rows[0]
    if (!image) return reply.status(404).send('Bild nicht gefunden.')

    const filename = wantOriginal ? image.original_filename : image.filename
    const mimetype = wantOriginal ? image.original_mimetype : image.mimetype

    const imagePath = path.join(UPLOAD_DIR, String(userId), String(image.report_id), filename)
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

  app.get('/report/:az/pdf', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const inline = (request.query as { inline?: string }).inline === '1'
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT pdf_filename FROM reports WHERE aktenzeichen = ? AND user_id = ?',
      [az, userId]
    )
    const report = rows[0]
    if (!report?.pdf_filename) return reply.status(404).send('PDF nicht verfügbar.')

    const pdfPath = path.join(PDF_DIR, String(userId), report.pdf_filename)
    try {
      const buffer = await fs.readFile(pdfPath)
      const disposition = inline ? 'inline' : 'attachment'
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="anzeige-${az}.pdf"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('PDF-Datei nicht gefunden.')
    }
  })

  // Wir versenden die Anzeige per E-Mail ans Ordnungsamt.
  app.post('/report/:az/send', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    // „Wir verschicken" ist derzeit (Produktion) deaktiviert – abweisen, auch wenn
    // jemand das Formular direkt ansteuert.
    if (!isSystemEmailEnabled()) {
      request.session.flash = {
        type: 'error',
        message: 'Der Versand über uns ist derzeit deaktiviert. Bitte selbst per Post oder E-Mail versenden.',
      }
      await request.session.save()
      return reply.redirect(`/report/${az}`)
    }

    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status === 'versendet') return reply.redirect(`/report/${az}`)
    const reportId = report.id

    if (!isComplete(report)) {
      request.session.flash = { type: 'error', message: 'Bitte zuerst alle Pflichtfelder ausfüllen.' }
      await request.session.save()
      return reply.redirect(`/report/${az}/edit`)
    }

    await regeneratePdf(reportId, userId)
    const fresh = await loadReport(reportId, userId)
    const [userRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    )

    try {
      await MailService.sendReport(fresh as mysql.RowDataPacket, userRows[0])
      await pool.execute(
        "UPDATE reports SET status='versendet', versand_art='system_email' WHERE id=?",
        [reportId]
      )
      request.session.flash = { type: 'success', message: 'Anzeige wurde per E-Mail versendet.' }
    } catch (err) {
      app.log.error({ err }, 'E-Mail-Versand fehlgeschlagen')
      request.session.flash = { type: 'error', message: 'E-Mail-Versand fehlgeschlagen.' }
    }

    await request.session.save()
    return reply.redirect(`/report/${az}`)
  })

  // Nutzer hat selbst versendet (gedruckt/Post oder eigene E-Mail) -> als erledigt markieren.
  app.post('/report/:az/complete', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const { art } = (request.body || {}) as { art?: string }
    if (art !== 'gedruckt' && art !== 'selbst_email') {
      return reply.status(400).send('Ungültige Versandart.')
    }

    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status === 'versendet') return reply.redirect(`/report/${az}`)
    const reportId = report.id

    if (!isComplete(report)) {
      request.session.flash = { type: 'error', message: 'Bitte zuerst alle Pflichtfelder ausfüllen.' }
      await request.session.save()
      return reply.redirect(`/report/${az}/edit`)
    }

    if (!report.pdf_filename) await regeneratePdf(reportId, userId)
    await pool.execute("UPDATE reports SET status='versendet', versand_art=? WHERE id=?", [art, reportId])

    request.session.flash = { type: 'success', message: 'Anzeige als versendet markiert.' }
    await request.session.save()
    return reply.redirect(`/report/${az}`)
  })
}
