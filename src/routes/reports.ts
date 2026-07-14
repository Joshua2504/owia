import { FastifyInstance, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { requireAuth, viewData, setFlash } from '../middleware/auth'
import { PdfService } from '../services/pdf'
import { getCity, DEFAULT_CITY_ID } from '../config/cities'
import { VERSTOSS_ARTEN } from '../config/verstoss'
import { prepareImage, writePreparedImage, removeImagePair, PreparedImage } from '../services/images'
import { cachedThumbnail, writeThumbnailCache } from '../services/pixelate'
import { createDraft, reportDir, UPLOAD_DIR } from '../services/drafts'
import { extractPhotoMeta } from '../services/exif'
import { replyAttachmentPath } from '../services/mailInbox'
import { MailService } from '../services/mail'

// Re-Export für bestehende Importe (Views/Tests beziehen die Liste über reports.ts).
export { VERSTOSS_ARTEN }

const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')
const MAX_IMAGES = 10

/** Buffer, den der PDF-Service einbettet. */
export type ReportImage = { mimetype: string; buffer: Buffer }

/** Vorbereitetes Bild (+ ggf. Original) zum Entwurf auf Platte schreiben. */
async function writeImageFiles(
  userId: number,
  reportId: number,
  p: PreparedImage
): Promise<{ filename: string; originalFilename: string }> {
  const dir = reportDir(userId, reportId)
  const names = await writePreparedImage(dir, p)
  // Vorschaubild sofort mitschreiben (Übersichten laden sonst beim ersten
  // Aufruf dutzende Vollbilder durch den synchronen jpeg-js-Decoder).
  await writeThumbnailCache(dir, names.filename, p.buffer, p.mimetype)
  return names
}

/** Alte Bilddateien (nutzbare Fassung + Original) entfernen. */
async function removeImageFiles(
  userId: number,
  reportId: number | string,
  filename: string,
  originalFilename: string
): Promise<void> {
  return removeImagePair(reportDir(userId, reportId), filename, originalFilename)
}

/** Bild zum Entwurf auf Platte + in der DB speichern; gibt die neue Bild-ID zurück. */
async function saveImageToReport(
  userId: number,
  reportId: number,
  p: PreparedImage
): Promise<{ id: number; filename: string }> {
  const { filename, originalFilename } = await writeImageFiles(userId, reportId, p)

  // EXIF (Aufnahmezeit + GPS) aus dem Original lesen – die HEIC-Konvertierung
  // entfernt die Metadaten aus der nutzbaren Fassung.
  const meta = await extractPhotoMeta(p.originalBuffer)

  // Neues Bild ans Ende der Sortierreihenfolge hängen.
  const [maxRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM report_images WHERE report_id = ?',
    [reportId]
  )
  const sortOrder = Number(maxRows[0].next)
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images
       (report_id, filename, mimetype, original_filename, original_mimetype, sort_order,
        captured_at, gps_lat, gps_lon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reportId, filename, p.mimetype, originalFilename, p.originalMimetype, sortOrder,
     meta.capturedAt, meta.lat, meta.lon]
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

/** Kontext der Review-Queue eines Foto-Imports: Position des aktuellen
 *  Entwurfs sowie vorheriger/nächster noch offener Entwurf des Batches. */
async function loadQueueContext(
  batchId: number,
  userId: number,
  currentAz: string
): Promise<{ batchId: number; position: number; total: number; prevAz: string | null; nextAz: string | null } | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT aktenzeichen, status FROM reports
      WHERE intake_batch_id = ? AND user_id = ?
      ORDER BY tattag, tatzeit_von, id`,
    [batchId, userId]
  )
  const idx = rows.findIndex((r) => r.aktenzeichen === currentAz)
  if (idx === -1) return null
  const prev = rows.slice(0, idx).reverse().find((r) => r.status === 'entwurf')
  const next = rows.slice(idx + 1).find((r) => r.status === 'entwurf')
  return {
    batchId,
    position: idx + 1,
    total: rows.length,
    prevAz: prev ? prev.aktenzeichen : null,
    nextAz: next ? next.aktenzeichen : null,
  }
}

/** Felder eines Entwurfs persistieren (leere Strings -> NULL). */
async function persistFields(
  reportId: string | number,
  userId: number,
  v: Record<string, string | undefined>
): Promise<void> {
  // Standard "Nein": nur explizites "ja" ergibt 1, alles andere 0.
  const behinderung = v.behinderung === 'ja' ? 1 : 0
  // Text immer aufbewahren (falls später doch wieder „Ja"); im PDF wird er nur
  // bei behinderung=1 angezeigt.
  const behinderungText = v.behinderung_text || null
  // Checkbox: nicht angehakt = Feld fehlt im Body bzw. ist leer.
  const fahrzeugVerlassen = v.fahrzeug_verlassen && v.fahrzeug_verlassen !== '0' ? 1 : 0
  // Länderkürzel des Kennzeichens (blaues Band): 1-3 Buchstaben, Default 'D'.
  const land = (v.kennzeichen_land || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'D'
  // Tatort-Koordinaten (Karte/Marker) nur übernehmen, wenn beide gültig sind.
  const lat = Number(v.tatort_lat)
  const lon = Number(v.tatort_lon)
  const tatortLat = Number.isFinite(lat) ? lat : null
  const tatortLon = Number.isFinite(lon) ? lon : null
  await pool.execute(
    `UPDATE reports
       SET kennzeichen=?, kennzeichen_land=?, fahrzeug_marke=?, tattag=?, tatzeit_von=?, tatzeit_bis=?,
           tatort=?, tatort_lat=?, tatort_lon=?, verstoss_art=?, beschreibung=?,
           behinderung=?, behinderung_text=?, fahrzeug_verlassen=?
     WHERE id=? AND user_id=? AND status='entwurf'`,
    [
      v.kennzeichen ? v.kennzeichen.toUpperCase().trim() : null,
      land,
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
      fahrzeugVerlassen,
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
    'SELECT filename, mimetype FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
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
      `SELECT aktenzeichen, status, tattag, verstoss_art, tatort, tatort_lat, tatort_lon,
              (SELECT ri.id FROM report_images ri
                WHERE ri.report_id = reports.id ORDER BY ri.sort_order, ri.id LIMIT 1) AS image_id
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
      url: `/anzeige/${r.aktenzeichen}/bearbeiten`,
      imageUrl: r.image_id ? `/anzeige/${r.aktenzeichen}/image/${r.image_id}/thumb.jpg` : null,
    }))
    return reply.send({ reports })
  })

  // ---------------------------------------------------------------------------
  // Entwurf anlegen + bearbeiten
  // ---------------------------------------------------------------------------

  app.post('/anzeige/neu', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const { aktenzeichen } = await createDraft(userId)
    return reply.redirect(`/anzeige/${aktenzeichen}/bearbeiten`)
  })

  app.get('/anzeige/:az/bearbeiten', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/anzeige/${az}`)

    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, original_filename FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
      [report.id]
    )
    const firstImageUrl = images.length ? `/anzeige/${az}/image/${images[0].id}/thumb.jpg` : null

    // Review-Queue des Foto-Imports: "Entwurf X von N" mit Vor/Zurück-Navigation
    // über alle noch offenen Entwürfe desselben Batches.
    const queueParam = Number((request.query as { queue?: string }).queue)
    const queue =
      Number.isInteger(queueParam) && queueParam > 0 && queueParam === report.intake_batch_id
        ? await loadQueueContext(queueParam, userId, az)
        : null

    // Andere offene Entwürfe als Ziel für "Foto verschieben".
    const [otherDrafts] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT aktenzeichen, kennzeichen, tatort,
              DATE_FORMAT(tattag, '%d.%m.%Y') AS tattag_fmt
         FROM reports
        WHERE user_id = ? AND status = 'entwurf' AND id != ?
        ORDER BY id DESC
        LIMIT 50`,
      [userId, report.id]
    )

    return reply.view('/reports/edit.ejs', viewData(request, {
      title: 'Entwurf bearbeiten',
      verstossArten: VERSTOSS_ARTEN,
      report,
      images,
      city: getCity(report.city),
      firstImageUrl,
      queue,
      otherDrafts,
    }))
  })

  // Hintergrund-Autosave der Textfelder (JSON).
  app.patch('/anzeige/:az', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })

    await persistFields(report.id, userId, (request.body || {}) as Record<string, string>)
    return reply.send({ ok: true })
  })

  // Einzelnes (ggf. bereits geschwärztes) Bild sofort zum Entwurf hochladen.
  app.post('/anzeige/:az/images', { preHandler: requireAuth }, async (request, reply) => {
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
          saved.push({ id: row.id, url: `/anzeige/${az}/image/${row.id}` })
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

  app.delete('/anzeige/:az/images/:imageId', { preHandler: requireAuth }, async (request, reply) => {
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
  app.put('/anzeige/:az/images/:imageId', { preHandler: requireAuth }, async (request, reply) => {
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

    return reply.send({ image: { id: Number(imageId), url: `/anzeige/${az}/image/${imageId}` } })
  })

  // Bildreihenfolge speichern (Nutzer sortiert per ◀ ▶). Das erste Bild dient u.a. als
  // Karten-Marker. order = Bild-IDs in der neuen Reihenfolge.
  app.post('/anzeige/:az/images/reorder', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })

    const body = (request.body || {}) as { order?: unknown }
    const order = Array.isArray(body.order)
      ? body.order.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : []
    if (!order.length) return reply.send({ ok: true })

    // Position = Index in der übergebenen Liste; nur Bilder dieses Reports betroffen.
    let pos = 0
    for (const imageId of order) {
      await pool.execute('UPDATE report_images SET sort_order = ? WHERE id = ? AND report_id = ?', [
        pos,
        imageId,
        report.id,
      ])
      pos++
    }
    return reply.send({ ok: true })
  })

  // Foto in einen anderen eigenen Entwurf verschieben (aus dem Formular oder
  // per Drag & Drop in der Import-Übersicht). Dateien wandern physisch mit,
  // das Bild landet am Ende der Ziel-Sortierung; beide PDFs werden aktualisiert.
  app.post('/anzeige/:az/images/:imageId/move', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const { targetAz, newDraft } = (request.body || {}) as { targetAz?: string; newDraft?: boolean }
    if (!newDraft && (!targetAz || targetAz === az)) {
      return reply.status(400).send({ error: 'Ziel-Anzeige fehlt.' })
    }

    const source = await loadReportByAktenzeichen(az, userId)
    if (!source) return reply.status(404).send({ error: 'not found' })
    if (source.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, filename, original_filename,
              DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s') AS captured_at, gps_lat, gps_lon
         FROM report_images WHERE id = ? AND report_id = ?`,
      [imageId, source.id]
    )
    const img = rows[0]
    if (!img) return reply.status(404).send({ error: 'Bild nicht gefunden.' })

    // Ziel: bestehender Entwurf oder neue Anzeige (mit EXIF des Fotos vorbelegt;
    // ein Import-Entwurf bleibt Teil seines Batches, damit die Übersicht ihn zeigt).
    let targetId: number
    let resolvedTargetAz: string
    if (newDraft) {
      const draft = await createDraft(userId, {
        tattag: img.captured_at ? img.captured_at.slice(0, 10) : null,
        tatzeitVon: img.captured_at ? img.captured_at.slice(11, 19) : null,
        tatortLat: img.gps_lat !== null ? Number(img.gps_lat) : null,
        tatortLon: img.gps_lon !== null ? Number(img.gps_lon) : null,
        intakeBatchId: source.intake_batch_id ?? null,
      })
      targetId = draft.id
      resolvedTargetAz = draft.aktenzeichen
    } else {
      const target = await loadReportByAktenzeichen(targetAz as string, userId)
      if (!target) return reply.status(404).send({ error: 'Ziel-Entwurf nicht gefunden.' })
      if (target.status !== 'entwurf') {
        return reply.status(409).send({ error: 'Ziel-Anzeige ist kein Entwurf mehr.' })
      }
      const [cntRows] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ?',
        [target.id]
      )
      if (Number(cntRows[0].c) >= MAX_IMAGES) {
        return reply.status(400).send({ error: `Maximal ${MAX_IMAGES} Bilder pro Anzeige.` })
      }
      targetId = target.id
      resolvedTargetAz = target.aktenzeichen
    }

    const from = reportDir(userId, source.id)
    const to = reportDir(userId, targetId)
    await fs.mkdir(to, { recursive: true })
    await fs.rename(path.join(from, img.filename), path.join(to, img.filename))
    if (img.original_filename && img.original_filename !== img.filename) {
      await fs.rename(path.join(from, img.original_filename), path.join(to, img.original_filename))
    }
    // Gecachte Ableitungen (Thumbnail/Pixelbild) mitnehmen, falls vorhanden.
    for (const suffix of ['.thumb.jpg', '.pixel.jpg']) {
      await fs
        .rename(path.join(from, img.filename + suffix), path.join(to, img.filename + suffix))
        .catch(() => {})
    }

    const [maxRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM report_images WHERE report_id = ?',
      [targetId]
    )
    await pool.execute('UPDATE report_images SET report_id = ?, sort_order = ? WHERE id = ?', [
      targetId,
      Number(maxRows[0].next),
      img.id,
    ])

    await regeneratePdf(source.id, userId)
    await regeneratePdf(targetId, userId)
    return reply.send({ ok: true, targetAz: resolvedTargetAz })
  })

  // „Entwurf speichern": finale Werte sichern, PDF erzeugen, zur Detailseite.
  app.post('/anzeige/:az/save', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/anzeige/${az}`)

    const body = (request.body || {}) as Record<string, string>
    await persistFields(report.id, userId, body)
    await regeneratePdf(report.id, userId)

    // In der Review-Queue des Foto-Imports: direkt zum nächsten offenen Entwurf,
    // nach dem letzten zurück zur Batch-Übersicht.
    const queueId = Number(body.queue)
    if (Number.isInteger(queueId) && queueId > 0 && queueId === report.intake_batch_id) {
      const queue = await loadQueueContext(queueId, userId, az)
      setFlash(reply, 'success', `Entwurf ${az} gespeichert.`)
      if (queue?.nextAz) return reply.redirect(`/anzeige/${queue.nextAz}/bearbeiten?queue=${queueId}`)
      return reply.redirect(`/import/${queueId}`)
    }

    setFlash(reply, 'success', 'Entwurf gespeichert.')
    return reply.redirect(`/anzeige/${az}`)
  })

  app.post('/anzeige/:az/discard', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/anzeige/${az}`)
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

    setFlash(reply, 'success', 'Entwurf verworfen.')
    return reply.redirect('/anzeigen')
  })

  // ---------------------------------------------------------------------------
  // Detail / Versand
  // ---------------------------------------------------------------------------

  app.get('/anzeige/:az', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')

    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, original_filename FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
      [report.id]
    )

    // Nachrichtenverlauf (Anzeige-Mail, Antworten des Amts, eigene Nachrichten)
    // + Anhänge; Ansehen der Seite = gelesen.
    const [replies] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, direction, from_address, subject, body_text, received_at, read_at
         FROM report_replies WHERE report_id = ? ORDER BY received_at, id`,
      [report.id]
    )
    const attachmentsByReply: Record<number, mysql.RowDataPacket[]> = {}
    if (replies.length) {
      const ids = replies.map((r) => r.id)
      const [atts] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, reply_id, original_filename, size_bytes
           FROM report_reply_attachments WHERE reply_id IN (${ids.map(() => '?').join(',')})
          ORDER BY id`,
        ids
      )
      for (const a of atts) (attachmentsByReply[a.reply_id] ??= []).push(a)
      await pool.execute(
        'UPDATE report_replies SET read_at = NOW() WHERE report_id = ? AND read_at IS NULL',
        [report.id]
      )
    }

    return reply.view('/reports/show.ejs', viewData(request, {
      title: `Anzeige ${report.aktenzeichen || ''}`,
      report,
      images,
      replies,
      attachmentsByReply,
      complete: isComplete(report),
      city: getCity(report.city),
    }))
  })

  // Nachricht des Nutzers ans Ordnungsamt (Antwort auf Rückfragen). Nur bei
  // versendeten Anzeigen – vorher gibt es keinen Mail-Verlauf mit dem Amt.
  app.post('/anzeige/:az/message', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const text = String((request.body as { text?: string })?.text || '').trim().slice(0, 10_000)

    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'versendet') {
      setFlash(reply, 'error', 'Nachrichten sind erst nach dem Versand der Anzeige möglich.')
      return reply.redirect(`/anzeige/${az}`)
    }
    if (!text) {
      setFlash(reply, 'error', 'Bitte einen Nachrichtentext eingeben.')
      return reply.redirect(`/anzeige/${az}`)
    }

    // Threading: auf die letzte Nachricht des Amts antworten (sonst auf die
    // Anzeige-Mail); References = bisherige Message-IDs des Verlaufs.
    const [thread] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT direction, message_id FROM report_replies
        WHERE report_id = ? ORDER BY received_at, id`,
      [report.id]
    )
    const lastIn = [...thread].reverse().find((m) => m.direction === 'in')
    const inReplyTo = lastIn?.message_id || report.sent_message_id || null
    const references = [
      report.sent_message_id,
      ...thread.map((m) => m.message_id),
    ].filter((x): x is string => !!x && !x.startsWith('out:') && !x.startsWith('sha256:'))

    const [users] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM users WHERE id = ?', [userId])
    try {
      const sent = await MailService.sendUserReply(report, users[0], text, {
        inReplyTo,
        references: [...new Set(references)].slice(-10),
      })
      await pool.execute(
        `INSERT INTO report_replies (report_id, direction, message_id, from_address, subject, body_text, received_at, read_at)
         VALUES (?, 'out', ?, ?, ?, ?, NOW(), NOW())`,
        [
          report.id,
          sent.messageId.slice(0, 255) || `out:${report.id}:${thread.length + 1}`,
          (process.env.MAIL_FROM || '').slice(0, 255) || null,
          sent.subject.slice(0, 500),
          text,
        ]
      )
      setFlash(reply, 'success', 'Nachricht ans Ordnungsamt gesendet (du bist in Kopie).')
    } catch (err) {
      app.log.error({ err }, 'Nutzer-Nachricht ans Ordnungsamt fehlgeschlagen')
      setFlash(reply, 'error', 'Senden fehlgeschlagen – bitte später erneut versuchen.')
    }
    return reply.redirect(`/anzeige/${az}`)
  })

  // Anhang einer Ordnungsamt-Antwort herunterladen (nur eigene Anzeigen).
  app.get('/anzeige/:az/reply/:replyId/attachment/:attId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, replyId, attId } = request.params as { az: string; replyId: string; attId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT a.filename, a.original_filename, a.mimetype
         FROM report_reply_attachments a
         JOIN report_replies rr ON rr.id = a.reply_id
         JOIN reports r ON r.id = rr.report_id
        WHERE a.id = ? AND rr.id = ? AND r.aktenzeichen = ? AND r.user_id = ?`,
      [attId, replyId, az, userId]
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

  app.get('/anzeige/:az/image/:imageId', { preHandler: requireAuth }, async (request, reply) => {
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

  // Kleines Vorschaubild (fürs Karten-Marker): serverseitig auf wenige KB heruntergerechnet,
  // damit die Karte nicht die Vollbilder laden muss.
  app.get('/anzeige/:az/image/:imageId/thumb.jpg', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.mimetype, r.id AS report_id
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ?`,
      [imageId, az, userId]
    )
    const image = rows[0]
    if (!image) return reply.status(404).send('Bild nicht gefunden.')

    try {
      const { buffer, type } = await cachedThumbnail(
        reportDir(userId, image.report_id),
        image.filename,
        image.mimetype
      )
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', 'private, max-age=3600')
        .send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })

  app.get('/anzeige/:az/pdf', { preHandler: requireAuth }, async (request, reply) => {
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
        .header('Content-Disposition', `${disposition}; filename="${report.pdf_filename}"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('PDF-Datei nicht gefunden.')
    }
  })

  // Anzeige zur Prüfung einreichen: ein Admin gibt sie frei und verschickt sie
  // ans Ordnungsamt. Nutzer versenden nicht mehr selbst.
  app.post('/anzeige/:az/submit', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/anzeige/${az}`)

    if (!isComplete(report)) {
      setFlash(reply, 'error', 'Bitte zuerst alle Pflichtfelder ausfüllen.')
      return reply.redirect(`/anzeige/${az}/bearbeiten`)
    }

    // PDF auf den letzten Stand bringen; eine frühere Ablehnung ist damit erledigt.
    await regeneratePdf(report.id, userId)
    await pool.execute(
      "UPDATE reports SET status='eingereicht', eingereicht_at=NOW(), ablehnung_grund=NULL WHERE id=?",
      [report.id]
    )
    setFlash(reply, 'success', 'Anzeige eingereicht – sie wird geprüft und dann ans Ordnungsamt verschickt.')
    return reply.redirect(`/anzeige/${az}`)
  })

  // Eingereichte Anzeige zurückziehen (wird wieder bearbeitbarer Entwurf).
  app.post('/anzeige/:az/withdraw', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'eingereicht') return reply.redirect(`/anzeige/${az}`)

    await pool.execute("UPDATE reports SET status='entwurf', eingereicht_at=NULL WHERE id=?", [
      report.id,
    ])
    setFlash(reply, 'success', 'Anzeige zurückgezogen – sie ist wieder ein Entwurf.')
    return reply.redirect(`/anzeige/${az}/bearbeiten`)
  })
}
