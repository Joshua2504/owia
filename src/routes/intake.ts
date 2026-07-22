// Sammel-Import ("Foto-Import"): viele Fotos auf einmal hochladen, serverseitig
// EXIF (GPS + Aufnahmezeit) lesen, zu Vorfällen gruppieren und daraus automatisch
// Entwürfe erzeugen. Der Upload läuft client-seitig in kleinen Chunks (unter dem
// globalen Multipart-Limit von 10 Dateien); die Gruppierung ("finish") ist ein
// schneller synchroner Schritt.
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { requireAuth, viewData, setFlash } from '../middleware/auth'
import { prepareImage, writePreparedImage } from '../services/images'
import { extractPhotoMeta } from '../services/exif'
import { groupPhotos, IntakePhoto } from '../services/intakeGrouping'
import { createDraft, reportDir, insertImageRow, UPLOAD_DIR } from '../services/drafts'
import { queuePlateAnalysis } from '../services/plateAnalysis'
import { reverseGeocode } from '../services/geocode'
import { cachedThumbnail, writeThumbnailCache } from '../services/pixelate'
import { VERSTOSS_ARTEN } from '../config/verstoss'
import { mostUsedVerstoesse } from './reports'

// Muss zur Chunk-Größe in public/js/import-upload.js passen und unter dem
// globalen Multipart-Limit (files: 10, src/server.ts) bleiben.
export const CHUNK_SIZE = 5
const MAX_IMAGES_PER_REPORT = 10

function intakeDir(userId: number, batchId: number | string): string {
  return path.join(UPLOAD_DIR, String(userId), 'intake', String(batchId))
}

type BatchRow = mysql.RowDataPacket & { id: number; status: string }

async function loadBatch(batchId: string, userId: number): Promise<BatchRow | null> {
  const [rows] = await pool.execute<BatchRow[]>(
    'SELECT id, status FROM intake_batches WHERE id = ? AND user_id = ?',
    [batchId, userId]
  )
  return rows[0] ?? null
}

/** Foto-Dateien (nutzbare Fassung + ggf. Original) vom Intake- ins Entwurfs-Verzeichnis verschieben. */
async function movePhotoFiles(
  userId: number,
  batchId: number | string,
  reportId: number,
  filename: string,
  originalFilename: string
): Promise<void> {
  const from = intakeDir(userId, batchId)
  const to = reportDir(userId, reportId)
  await fs.mkdir(to, { recursive: true })
  await fs.rename(path.join(from, filename), path.join(to, filename))
  if (originalFilename && originalFilename !== filename) {
    await fs.rename(path.join(from, originalFilename), path.join(to, originalFilename))
  }
  // Gecachtes Vorschaubild mitnehmen (falls schon berechnet); sonst egal.
  await fs
    .rename(path.join(from, `${filename}.thumb.jpg`), path.join(to, `${filename}.thumb.jpg`))
    .catch(() => {})
}

type PhotoRow = mysql.RowDataPacket & {
  id: number
  filename: string
  mimetype: string
  original_filename: string
  original_mimetype: string
  captured_at: string | null
  gps_lat: string | null
  gps_lon: string | null
  report_id: number | null
}

/** Fotos eines Batches laden; captured_at als Wanduhrzeit-String (keine TZ-Drehung über JS-Date). */
async function loadPhotos(batchId: number, onlyUnassigned = false): Promise<PhotoRow[]> {
  const [rows] = await pool.execute<PhotoRow[]>(
    `SELECT id, filename, mimetype, original_filename, original_mimetype,
            DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s') AS captured_at,
            gps_lat, gps_lon, report_id
       FROM intake_photos
      WHERE batch_id = ?${onlyUnassigned ? ' AND report_id IS NULL' : ''}
      ORDER BY captured_at IS NULL, captured_at, id`,
    [batchId]
  )
  return rows
}

export default async function intakeRoutes(app: FastifyInstance) {
  // Upload-Seite; listet auch bestehende Batches (offenen Upload fortsetzen/verwerfen).
  app.get('/import', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [batches] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT b.id, b.status, b.created_at,
              COUNT(p.id) AS photo_count,
              SUM(p.report_id IS NOT NULL) AS assigned_count
         FROM intake_batches b
         LEFT JOIN intake_photos p ON p.batch_id = b.id
        WHERE b.user_id = ?
        GROUP BY b.id
        ORDER BY b.id DESC
        LIMIT 20`,
      [userId]
    )
    return reply.view('/intake/upload.ejs', viewData(request, {
      title: 'Foto-Import',
      batches,
      chunkSize: CHUNK_SIZE,
    }))
  })

  // Neuen Batch anlegen (wird vom Upload-JS vor dem ersten Chunk aufgerufen).
  app.post('/import/batch', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO intake_batches (user_id, status) VALUES (?, 'open')",
      [userId]
    )
    return reply.send({ batchId: result.insertId })
  })

  // Ein Upload-Chunk (<= CHUNK_SIZE Dateien, Feld "bilder").
  app.post('/import/:batchId/photos', { preHandler: requireAuth }, async (request, reply) => {
    const { batchId } = request.params as { batchId: string }
    const userId = request.session.userId as number
    const batch = await loadBatch(batchId, userId)
    if (!batch) return reply.status(404).send({ error: 'not found' })
    if (batch.status !== 'open') return reply.status(409).send({ error: 'batch closed' })

    const saved: { id: number; name: string; capturedAt: string | null; hasGps: boolean }[] = []
    const errors: string[] = []
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        if (part.fieldname !== 'bilder' || !part.filename) continue
        const buffer = await part.toBuffer()
        if (buffer.length === 0) continue
        try {
          // EXIF aus dem Original – die HEIC-Konvertierung entfernt die Metadaten.
          const meta = await extractPhotoMeta(buffer)
          const prepared = await prepareImage(buffer, part.filename, part.mimetype || '')
          const { filename, originalFilename } = await writePreparedImage(
            intakeDir(userId, batch.id),
            prepared
          )
          // Vorschaubild sofort mitschreiben, damit die Übersicht später nicht
          // dutzende Vollbilder synchron dekodieren muss.
          await writeThumbnailCache(intakeDir(userId, batch.id), filename, prepared.buffer, prepared.mimetype)
          const [result] = await pool.execute<mysql.ResultSetHeader>(
            `INSERT INTO intake_photos
               (batch_id, filename, mimetype, original_filename, original_mimetype,
                upload_name, captured_at, gps_lat, gps_lon)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [batch.id, filename, prepared.mimetype, originalFilename, prepared.originalMimetype,
             part.filename, meta.capturedAt, meta.lat, meta.lon]
          )
          saved.push({
            id: result.insertId,
            name: part.filename,
            capturedAt: meta.capturedAt,
            hasGps: meta.lat !== null,
          })
        } catch {
          errors.push(`${part.filename}: Nur JPG-, PNG- und HEIC/HEIF-Bilder werden unterstützt.`)
        }
      }
    } catch {
      return reply.status(413).send({ error: 'Bild zu groß (max. 20 MB).', photos: saved, errors })
    }
    return reply.send({ photos: saved, errors })
  })

  // Gruppierung + Entwurfs-Erzeugung. Claim über den Status, damit ein doppelter
  // Aufruf (Reload, zweiter Tab) nicht doppelte Entwürfe erzeugt.
  app.post('/import/:batchId/finish', { preHandler: requireAuth }, async (request, reply) => {
    const { batchId } = request.params as { batchId: string }
    const userId = request.session.userId as number
    const batch = await loadBatch(batchId, userId)
    if (!batch) return reply.status(404).send({ error: 'not found' })
    if (batch.status !== 'open') {
      // done/grouping: einfach zur Übersicht – die zeigt den aktuellen Stand.
      return reply.send({ redirect: `/import/${batch.id}` })
    }

    const [claim] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE intake_batches SET status = 'grouping' WHERE id = ? AND status = 'open'",
      [batch.id]
    )
    if (claim.affectedRows === 0) return reply.send({ redirect: `/import/${batch.id}` })

    try {
      const photos = await loadPhotos(batch.id, true)
      if (photos.length === 0) {
        await pool.execute("UPDATE intake_batches SET status = 'open' WHERE id = ?", [batch.id])
        return reply.status(400).send({ error: 'Keine Fotos hochgeladen.' })
      }

      const byId = new Map(photos.map((p) => [p.id, p]))
      const input: IntakePhoto[] = photos.map((p) => ({
        id: p.id,
        capturedAt: p.captured_at,
        lat: p.gps_lat !== null ? Number(p.gps_lat) : null,
        lon: p.gps_lon !== null ? Number(p.gps_lon) : null,
      }))
      const { incidents } = groupPhotos(input)

      for (const incident of incidents) {
        // Adresse aus den Koordinaten; Photon-Ausfall darf nie blockieren.
        const address =
          incident.lat !== null && incident.lon !== null
            ? await reverseGeocode(incident.lat, incident.lon)
            : null

        // Mehr als MAX_IMAGES Fotos -> chronologisch in mehrere Entwürfe teilen.
        for (let i = 0; i < incident.photoIds.length; i += MAX_IMAGES_PER_REPORT) {
          const chunkIds = incident.photoIds.slice(i, i + MAX_IMAGES_PER_REPORT)
          const draft = await createDraft(userId, {
            tattag: incident.day,
            tatzeitVon: incident.timeFrom,
            tatzeitBis: incident.timeTo,
            tatort: address?.label ?? null,
            tatortLat: incident.lat,
            tatortLon: incident.lon,
            intakeBatchId: batch.id,
          })
          for (let s = 0; s < chunkIds.length; s++) {
            const p = byId.get(chunkIds[s])
            if (!p) continue
            await movePhotoFiles(userId, batch.id, draft.id, p.filename, p.original_filename)
            const imageId = await insertImageRow(draft.id, {
              filename: p.filename,
              mimetype: p.mimetype,
              originalFilename: p.original_filename,
              originalMimetype: p.original_mimetype,
              sortOrder: s + 1,
              capturedAt: p.captured_at,
              gpsLat: p.gps_lat !== null ? Number(p.gps_lat) : null,
              gpsLon: p.gps_lon !== null ? Number(p.gps_lon) : null,
            })
            // Kennzeichen im Hintergrund erkennen (füllt das leere Feld des Entwurfs).
            queuePlateAnalysis(userId, draft.id, imageId, p.filename, p.mimetype)
            await pool.execute('UPDATE intake_photos SET report_id = ? WHERE id = ?', [
              draft.id,
              p.id,
            ])
          }
        }
      }

      await pool.execute(
        "UPDATE intake_batches SET status = 'done', grouped_at = NOW() WHERE id = ?",
        [batch.id]
      )
      return reply.send({ redirect: `/import/${batch.id}` })
    } catch (err) {
      // Fehler mittendrin: bereits erzeugte Entwürfe bleiben bestehen, die
      // restlichen Fotos bleiben unzugeordnet und lassen sich manuell verteilen.
      request.log.error({ err }, 'Intake-Gruppierung fehlgeschlagen')
      await pool.execute("UPDATE intake_batches SET status = 'done', grouped_at = NOW() WHERE id = ?", [batch.id])
      return reply.send({ redirect: `/import/${batch.id}` })
    }
  })

  // Batch-Übersicht: erzeugte Entwürfe + unzugeordnete Fotos.
  app.get('/import/:batchId', { preHandler: requireAuth }, async (request, reply) => {
    const { batchId } = request.params as { batchId: string }
    const userId = request.session.userId as number
    const batch = await loadBatch(batchId, userId)
    if (!batch) return reply.status(404).send('Import nicht gefunden.')
    if (batch.status === 'open') return reply.redirect('/import')

    const [drafts] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.id, r.aktenzeichen, r.status, r.tattag, r.tatzeit_von, r.tatzeit_bis,
              r.tatort, r.tatort_lat, r.tatort_lon, r.verstoss_art, r.kennzeichen, r.kennzeichen_land,
              r.fahrzeug_marke, r.beschreibung, r.fahrzeug_verlassen, r.behinderung, r.behinderung_text,
              DATE_FORMAT(r.tattag, '%d.%m.%Y') AS tattag_fmt,
              TIME_FORMAT(r.tatzeit_von, '%H:%i') AS von_fmt,
              TIME_FORMAT(r.tatzeit_bis, '%H:%i') AS bis_fmt,
              (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = r.id) AS image_count
         FROM reports r
        WHERE r.intake_batch_id = ? AND r.user_id = ?
        ORDER BY r.tattag, r.tatzeit_von, r.id`,
      [batch.id, userId]
    )
    // Alle Fotos der Batch-Entwürfe für die Thumbnail-Leisten (Drag & Drop).
    const [draftImages] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.id, ri.report_id
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE r.intake_batch_id = ? AND r.user_id = ?
        ORDER BY ri.report_id, ri.sort_order, ri.id`,
      [batch.id, userId]
    )
    const imagesByReport = new Map<number, number[]>()
    for (const img of draftImages) {
      const list = imagesByReport.get(img.report_id) ?? []
      list.push(img.id)
      imagesByReport.set(img.report_id, list)
    }

    const unassigned = await loadPhotos(batch.id, true)
    const openDrafts = drafts.filter((d) => d.status === 'entwurf')
    return reply.view('/intake/overview.ejs', viewData(request, {
      title: 'Foto-Import – Ergebnis',
      batch,
      drafts,
      imagesByReport: Object.fromEntries(imagesByReport),
      unassigned,
      firstOpenAz: openDrafts.length ? openDrafts[0].aktenzeichen : null,
      openCount: openDrafts.length,
      // Für die Inline-Bearbeitung der Entwürfe direkt in der Liste.
      verstossAlle: VERSTOSS_ARTEN,
      verstossHaeufig: await mostUsedVerstoesse(),
    }))
  })

  // Vollbild eines (unzugeordneten) Intake-Fotos (Lightbox in der Übersicht).
  app.get('/import/:batchId/photo/:photoId', { preHandler: requireAuth }, async (request, reply) => {
    const { batchId, photoId } = request.params as { batchId: string; photoId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT p.filename, p.mimetype
         FROM intake_photos p
         JOIN intake_batches b ON b.id = p.batch_id
        WHERE p.id = ? AND p.batch_id = ? AND b.user_id = ? AND p.report_id IS NULL`,
      [photoId, batchId, userId]
    )
    const photo = rows[0]
    if (!photo) return reply.status(404).send('Bild nicht gefunden.')

    try {
      const buffer = await fs.readFile(path.join(intakeDir(userId, batchId), photo.filename))
      return reply
        .header('Content-Type', photo.mimetype || 'application/octet-stream')
        .header('Cache-Control', 'private, max-age=3600')
        .send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })

  // Thumbnail eines (unzugeordneten) Intake-Fotos.
  app.get('/import/:batchId/photo/:photoId/thumb.jpg', { preHandler: requireAuth }, async (request, reply) => {
    const { batchId, photoId } = request.params as { batchId: string; photoId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT p.filename, p.mimetype
         FROM intake_photos p
         JOIN intake_batches b ON b.id = p.batch_id
        WHERE p.id = ? AND p.batch_id = ? AND b.user_id = ? AND p.report_id IS NULL`,
      [photoId, batchId, userId]
    )
    const photo = rows[0]
    if (!photo) return reply.status(404).send('Bild nicht gefunden.')

    try {
      const { buffer, type } = await cachedThumbnail(
        intakeDir(userId, batchId),
        photo.filename,
        photo.mimetype
      )
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', 'private, max-age=3600')
        .send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })

  // Unzugeordnetes Foto einem Entwurf des Batches zuordnen (oder neuen anlegen).
  app.post('/import/:batchId/photos/:photoId/assign', { preHandler: requireAuth }, async (request, reply) => {
    const { batchId, photoId } = request.params as { batchId: string; photoId: string }
    const userId = request.session.userId as number
    const body = (request.body || {}) as { az?: string; newDraft?: boolean }
    const batch = await loadBatch(batchId, userId)
    if (!batch) return reply.status(404).send({ error: 'not found' })

    const [rows] = await pool.execute<PhotoRow[]>(
      `SELECT id, filename, mimetype, original_filename, original_mimetype,
              DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s') AS captured_at,
              gps_lat, gps_lon, report_id
         FROM intake_photos WHERE id = ? AND batch_id = ?`,
      [photoId, batch.id]
    )
    const photo = rows[0]
    if (!photo || photo.report_id !== null) return reply.status(404).send({ error: 'not found' })

    let reportId: number
    if (body.newDraft) {
      const draft = await createDraft(userId, {
        tattag: photo.captured_at ? photo.captured_at.slice(0, 10) : null,
        tatzeitVon: photo.captured_at ? photo.captured_at.slice(11, 19) : null,
        tatortLat: photo.gps_lat !== null ? Number(photo.gps_lat) : null,
        tatortLon: photo.gps_lon !== null ? Number(photo.gps_lon) : null,
        intakeBatchId: batch.id,
      })
      reportId = draft.id
    } else {
      const [reports] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM reports WHERE aktenzeichen = ? AND user_id = ? AND status = 'entwurf'`,
        [body.az ?? '', userId]
      )
      if (!reports[0]) return reply.status(404).send({ error: 'Entwurf nicht gefunden.' })
      reportId = reports[0].id
      const [cnt] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ?',
        [reportId]
      )
      if (Number(cnt[0].c) >= MAX_IMAGES_PER_REPORT) {
        return reply.status(400).send({ error: `Maximal ${MAX_IMAGES_PER_REPORT} Bilder pro Anzeige.` })
      }
    }

    await movePhotoFiles(userId, batch.id, reportId, photo.filename, photo.original_filename)
    const [maxRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM report_images WHERE report_id = ?',
      [reportId]
    )
    const imageId = await insertImageRow(reportId, {
      filename: photo.filename,
      mimetype: photo.mimetype,
      originalFilename: photo.original_filename,
      originalMimetype: photo.original_mimetype,
      sortOrder: Number(maxRows[0].next),
      capturedAt: photo.captured_at,
      gpsLat: photo.gps_lat !== null ? Number(photo.gps_lat) : null,
      gpsLon: photo.gps_lon !== null ? Number(photo.gps_lon) : null,
    })
    queuePlateAnalysis(userId, reportId, imageId, photo.filename, photo.mimetype)
    await pool.execute('UPDATE intake_photos SET report_id = ? WHERE id = ?', [reportId, photo.id])
    return reply.send({ ok: true })
  })

  // Offenen Batch verwerfen (Fotos + Dateien löschen).
  app.post('/import/:batchId/discard', { preHandler: requireAuth }, async (request, reply) => {
    const { batchId } = request.params as { batchId: string }
    const userId = request.session.userId as number
    const batch = await loadBatch(batchId, userId)
    if (!batch) return reply.status(404).send({ error: 'not found' })
    if (batch.status !== 'open') return reply.status(409).send({ error: 'batch closed' })

    await pool.execute('DELETE FROM intake_batches WHERE id = ?', [batch.id])
    await fs.rm(intakeDir(userId, batch.id), { recursive: true, force: true })
    setFlash(reply, 'success', 'Foto-Import verworfen.')
    return reply.send({ redirect: '/import' })
  })
}
