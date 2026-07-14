import { FastifyInstance, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { PdfService } from '../services/pdf'
import { MailService, buildReportMail } from '../services/mail'
import { getCity, DEFAULT_CITY_ID } from '../config/cities'
import { VERSTOSS_ARTEN } from '../config/verstoss'
import { analyzeImageInBackground, isPhotoAiEnabled } from '../services/imageAnalysis'
import { prepareImage, writePreparedImage, removeImagePair, PreparedImage } from '../services/images'
import { thumbnail } from '../services/pixelate'
import {
  chargeAnalysis,
  refundAnalysis,
  InsufficientFundsError,
  hasActiveSubscription,
  getBalance,
} from '../services/credits'
import { ANALYSIS_PRICE_CENTS } from '../config/credits'
import { createDraft, reportDir, UPLOAD_DIR } from '../services/drafts'
import { extractPhotoMeta } from '../services/exif'

// Re-Export für bestehende Importe (Views/Tests beziehen die Liste über reports.ts).
export { VERSTOSS_ARTEN }

const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')
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

/** Buffer, den der PDF-Service einbettet. */
export type ReportImage = { mimetype: string; buffer: Buffer }

/** Vorbereitetes Bild (+ ggf. Original) zum Entwurf auf Platte schreiben. */
async function writeImageFiles(
  userId: number,
  reportId: number,
  p: PreparedImage
): Promise<{ filename: string; originalFilename: string }> {
  return writePreparedImage(reportDir(userId, reportId), p)
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
  const behinderung = v.behinderung === 'ja' ? 1 : v.behinderung === 'nein' ? 0 : null
  // Text immer aufbewahren (falls später doch wieder „Ja"); im PDF wird er nur
  // bei behinderung=1 angezeigt.
  const behinderungText = v.behinderung_text || null
  // Checkbox: nicht angehakt = Feld fehlt im Body bzw. ist leer.
  const fahrzeugVerlassen = v.fahrzeug_verlassen && v.fahrzeug_verlassen !== '0' ? 1 : 0
  // Tatort-Koordinaten (Karte/Marker) nur übernehmen, wenn beide gültig sind.
  const lat = Number(v.tatort_lat)
  const lon = Number(v.tatort_lon)
  const tatortLat = Number.isFinite(lat) ? lat : null
  const tatortLon = Number.isFinite(lon) ? lon : null
  await pool.execute(
    `UPDATE reports
       SET kennzeichen=?, fahrzeug_marke=?, tattag=?, tatzeit_von=?, tatzeit_bis=?,
           tatort=?, tatort_lat=?, tatort_lon=?, verstoss_art=?, beschreibung=?,
           behinderung=?, behinderung_text=?, fahrzeug_verlassen=?
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
      url: `/report/${r.aktenzeichen}/edit`,
      imageUrl: r.image_id ? `/report/${r.aktenzeichen}/image/${r.image_id}/thumb.jpg` : null,
    }))
    return reply.send({ reports })
  })

  // ---------------------------------------------------------------------------
  // Entwurf anlegen + bearbeiten
  // ---------------------------------------------------------------------------

  app.post('/report/new', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const { aktenzeichen } = await createDraft(userId)
    return reply.redirect(`/report/${aktenzeichen}/edit`)
  })

  app.get('/report/:az/edit', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/report/${az}`)

    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, original_filename, analysis_status FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
      [report.id]
    )
    // KI-Analyse ist nur nutzbar mit aktiver Flatrate oder genug Guthaben (frei + bezahlt).
    // EXIF-basierte Helfer (Standort/Uhrzeit aus Fotos) bleiben davon unberührt und kostenlos.
    const [bal, subscribed] = await Promise.all([
      getBalance(userId),
      hasActiveSubscription(userId),
    ])
    const aiEnabled = isPhotoAiEnabled() && (subscribed || bal.totalCents >= ANALYSIS_PRICE_CENTS)
    const firstImageUrl = images.length ? `/report/${az}/image/${images[0].id}/thumb.jpg` : null

    // Review-Queue des Foto-Imports: "Entwurf X von N" mit Vor/Zurück-Navigation
    // über alle noch offenen Entwürfe desselben Batches.
    const queueParam = Number((request.query as { queue?: string }).queue)
    const queue =
      Number.isInteger(queueParam) && queueParam > 0 && queueParam === report.intake_batch_id
        ? await loadQueueContext(queueParam, userId, az)
        : null

    return reply.view('/reports/edit.ejs', viewData(request, {
      title: 'Entwurf bearbeiten',
      verstossArten: VERSTOSS_ARTEN,
      report,
      images,
      city: getCity(report.city),
      aiEnabled,
      subscriptionActive: subscribed,
      firstImageUrl,
      queue,
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

  // Vorschläge aus der Hintergrund-Foto-Analyse (Kennzeichen + Verstoßart). Das
  // Formular pollt diesen Endpoint und füllt damit leere Felder vor.
  app.get('/report/:az/analysis', { preHandler: requireAuth }, async (request, reply) => {
    // KI-Analyse aus (z.B. Entwicklung) -> sofort „fertig" ohne Vorschläge, damit
    // das Formular nicht ins Leere pollt.
    if (!isPhotoAiEnabled()) {
      return reply.send({
        status: 'done',
        suggestions: { kennzeichen: null, verstoss_art: null, fahrzeug_marke: null, beschreibung: null },
      })
    }

    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT analysis_status, detected_plate, plate_confidence,
              vlm_verstoss_art, vlm_marke, vlm_beschreibung
         FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
      [report.id]
    )

    // „pending", solange ein Bild noch nicht fertig ist (NULL = frisch hochgeladen).
    const pending = rows.some(
      (r) => r.analysis_status !== 'done' && r.analysis_status !== 'error'
    )

    // Bestes Kennzeichen nach OCR-Konfidenz über alle Bilder.
    let kennzeichen: string | null = null
    let bestConf = -1
    for (const r of rows) {
      const conf = Number(r.plate_confidence)
      if (r.detected_plate && Number.isFinite(conf) && conf > bestConf) {
        bestConf = conf
        kennzeichen = r.detected_plate
      }
    }
    const firstOf = (key: string): string | null => {
      for (const r of rows) if (r[key]) return r[key] as string
      return null
    }

    return reply.send({
      status: pending ? 'pending' : 'done',
      suggestions: {
        kennzeichen,
        verstoss_art: firstOf('vlm_verstoss_art'),
        fahrzeug_marke: firstOf('vlm_marke'),
        beschreibung: firstOf('vlm_beschreibung'),
      },
    })
  })

  // Manuelle, kostenpflichtige KI-Analyse eines einzelnen Bildes (0,10 €). Belastet das
  // Guthaben (erst Freiguthaben), stößt die Analyse für genau dieses Bild an und erstattet
  // automatisch, falls sie technisch fehlschlägt. Das Formular pollt danach wie gehabt
  // GET /report/:az/analysis und übernimmt die Vorschläge.
  app.post('/report/:az/images/:imageId/analyze', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    if (!isPhotoAiEnabled()) {
      return reply.status(409).send({ error: 'KI-Analyse ist derzeit nicht verfügbar.' })
    }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.id, ri.filename, ri.mimetype, ri.analysis_status, r.id AS report_id
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ? AND r.status = 'entwurf'`,
      [imageId, az, userId]
    )
    const img = rows[0]
    if (!img) return reply.status(404).send({ error: 'not found' })

    // Job atomar beanspruchen: nur wenn nicht bereits 'pending'. Ein zweiter,
    // gleichzeitiger Klick trifft affectedRows==0 und wird nicht erneut belastet.
    // Bestehende Ergebnisse werden hier noch NICHT verworfen (falls die Bezahlung scheitert).
    const [claim] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE report_images SET analysis_status='pending'
        WHERE id=? AND (analysis_status IS NULL OR analysis_status IN ('done','error'))`,
      [imageId]
    )
    if (claim.affectedRows !== 1) {
      return reply.send({ ok: true, status: 'pending' })
    }

    // Flatrate-Nutzer analysieren unbegrenzt (keine Belastung); sonst pro Bild abrechnen.
    const subscribed = await hasActiveSubscription(userId)
    let balance: Awaited<ReturnType<typeof chargeAnalysis>> | null = null
    if (!subscribed) {
      try {
        balance = await chargeAnalysis(userId, Number(imageId))
      } catch (err) {
        // Beanspruchung zurücknehmen (vorherigen Status wiederherstellen; Ergebnisse blieben erhalten).
        await pool.execute('UPDATE report_images SET analysis_status=? WHERE id=?', [
          img.analysis_status ?? null,
          imageId,
        ])
        if (err instanceof InsufficientFundsError) {
          return reply.status(402).send({
            error: 'Nicht genug Guthaben. Bitte aufladen oder Flatrate buchen.',
            topupUrl: '/konto',
          })
        }
        throw err
      }
    }

    // Bezahlt/Flatrate -> alte Analyse-Ergebnisse verwerfen und neu analysieren.
    await pool.execute(
      `UPDATE report_images
          SET detected_plate=NULL, plate_confidence=NULL, vlm_verstoss_art=NULL,
              vlm_marke=NULL, vlm_beschreibung=NULL, analyzed_at=NULL
        WHERE id=?`,
      [imageId]
    )
    analyzeImageInBackground(
      userId,
      img.report_id,
      Number(imageId),
      img.filename,
      img.mimetype,
      // Nur bei bezahlter Einzelanalyse bei Fehlschlag erstatten (Flatrate wird nicht belastet).
      subscribed ? undefined : () => refundAnalysis(userId, Number(imageId))
    )

    return reply.send({
      ok: true,
      status: 'pending',
      subscriptionActive: subscribed,
      balanceCents: balance?.balanceCents,
      freeCents: balance?.freeCents,
      totalCents: balance?.totalCents,
    })
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
          // KI-Analyse wird nicht mehr automatisch angestoßen – der Nutzer löst sie
          // pro Bild kostenpflichtig über „Automatisch ausfüllen" aus.
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
    // Neue Bildfassung -> bisherige Analyse-Ergebnisse verwerfen. Eine neue Analyse
    // stößt der Nutzer bei Bedarf wieder manuell an (kostenpflichtig).
    await pool.execute(
      `UPDATE report_images
         SET filename=?, mimetype=?, original_filename=?, original_mimetype=?,
             detected_plate=NULL, plate_confidence=NULL, vlm_verstoss_art=NULL,
             vlm_marke=NULL, vlm_beschreibung=NULL, analysis_status=NULL, analyzed_at=NULL
       WHERE id=?`,
      [filename, prepared.mimetype, originalFilename, prepared.originalMimetype, imageId]
    )
    await removeImageFiles(userId, old.report_id, old.filename, old.original_filename)

    return reply.send({ image: { id: Number(imageId), url: `/report/${az}/image/${imageId}` } })
  })

  // Bildreihenfolge speichern (Nutzer sortiert per ◀ ▶). Das erste Bild dient u.a. als
  // Karten-Marker. order = Bild-IDs in der neuen Reihenfolge.
  app.post('/report/:az/images/reorder', { preHandler: requireAuth }, async (request, reply) => {
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

  // „Entwurf speichern": finale Werte sichern, PDF erzeugen, zur Detailseite.
  app.post('/report/:az/save', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/report/${az}`)

    const body = (request.body || {}) as Record<string, string>
    await persistFields(report.id, userId, body)
    await regeneratePdf(report.id, userId)

    // In der Review-Queue des Foto-Imports: direkt zum nächsten offenen Entwurf,
    // nach dem letzten zurück zur Batch-Übersicht.
    const queueId = Number(body.queue)
    if (Number.isInteger(queueId) && queueId > 0 && queueId === report.intake_batch_id) {
      const queue = await loadQueueContext(queueId, userId, az)
      request.session.flash = { type: 'success', message: `Entwurf ${az} gespeichert.` }
      await request.session.save()
      if (queue?.nextAz) return reply.redirect(`/report/${queue.nextAz}/edit?queue=${queueId}`)
      return reply.redirect(`/intake/${queueId}`)
    }

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
      'SELECT id, filename, original_filename FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
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

  // Kleines Vorschaubild (fürs Karten-Marker): serverseitig auf wenige KB heruntergerechnet,
  // damit die Karte nicht die Vollbilder laden muss.
  app.get('/report/:az/image/:imageId/thumb.jpg', { preHandler: requireAuth }, async (request, reply) => {
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

    const imagePath = path.join(UPLOAD_DIR, String(userId), String(image.report_id), image.filename)
    try {
      const buffer = await fs.readFile(imagePath)
      let out: Buffer = buffer
      let type = image.mimetype || 'image/jpeg'
      try {
        out = thumbnail(buffer, image.mimetype || 'image/jpeg')
        type = 'image/jpeg'
      } catch {
        /* Nicht dekodierbar -> Originalbild ausliefern (Marker bleibt sichtbar). */
      }
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', 'private, max-age=3600')
        .send(out)
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
