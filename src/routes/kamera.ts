// Kamera-Modus fürs Handy (/kamera, Startseite der PWA): Kamera öffnet sofort,
// mehrere Fotos schießen, „Fertig" – daraus wird genau ein Entwurf. Danach
// optional den QR-Sticker scannen und verknüpfen, dann gleich den nächsten
// Verstoß fotografieren oder im Prüf-Modus vervollständigen und einreichen.
//
// Ablauf (public/js/kamera.js):
//   1. POST /kamera/entwurf          – beim ersten Foto, legt den Entwurf an
//   2. POST /kamera/:az/foto         – je Foto, nacheinander im Hintergrund
//   3. POST /kamera/:az/fertig       – Tatzeit aus den Aufnahmezeiten setzen
//   4. POST /kamera/:az/sticker      – optional, JSON {code}
//      POST /kamera/:az/verwerfen    – Abbruch: Entwurf in den Papierkorb
//
// Kamera-Fotos (Canvas/ImageCapture) haben kein EXIF. Aufnahmezeit (Wanduhr
// des Handys) und Standort schickt der Client deshalb als Formularfelder mit;
// sie gelten nur, wenn das Bild selbst keine Metadaten trägt (Galerie-Fotos
// behalten ihr EXIF).
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { createDraft, trashDrafts } from '../services/drafts'
import { withIntakeUploadLock } from '../services/intakeImageProcessing'
import { queuePlateAnalysis } from '../services/plateAnalysis'
import { queueTatortFill } from '../services/tatortFill'
import { photoSha256, findExistingPhoto } from '../services/photoDedup'
import { normalizeCode, linkCode, formatCode, LINK_MELDUNG } from '../services/stickers'
import { tatzeitBis } from '../services/tatzeit'
import { MAX_IMAGES, loadReportByAktenzeichen } from './reports/shared'
import { saveImageToReport } from './reports/images'

const ZEIT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
// Ungenauere Positionen (Funkzelle/WLAN, oft mehrere hundert Meter) würden
// einen falschen Tatort vorschlagen – dann lieber gar keinen.
const MAX_GENAUIGKEIT_M = 150

function koordinate(raw: string | undefined, max: number): number | null {
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && Math.abs(n) <= max && n !== 0 ? n : null
}

export default async function kameraRoutes(app: FastifyInstance) {
  app.get('/kamera', async (request, reply) => {
    // Ausgeloggt (z. B. iOS-PWA mit eigenem Cookie-Speicher): nach dem Login
    // direkt zurück zur Kamera (Rücksprung-Pfade: WEITER_RE in auth.ts).
    if (!request.session.userId) return reply.redirect('/login?weiter=/kamera')
    return reply.view('/kamera/index.ejs', viewData(request, {
      title: 'Kamera',
      bare: true,
      maxImages: MAX_IMAGES,
    }))
  })

  app.post('/kamera/entwurf', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const { aktenzeichen } = await createDraft(userId)
    return reply.send({ az: aktenzeichen })
  })

  app.post('/kamera/:az/foto', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'Entwurf nicht gefunden.' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'Die Anzeige ist kein Entwurf mehr.' })

    const felder: Record<string, string> = {}
    let upload: { buffer: Buffer; filename: string; mimetype: string } | null = null
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer()
          if (part.fieldname === 'bild' && buffer.length > 0 && !upload) {
            upload = { buffer, filename: part.filename || 'kamera.jpg', mimetype: part.mimetype || '' }
          }
        } else {
          felder[part.fieldname] = String(part.value ?? '')
        }
      }
    } catch {
      return reply.status(413).send({ error: 'Bild zu groß (max. 20 MB).' })
    }
    if (!upload) return reply.status(400).send({ error: 'Kein Bild empfangen.' })

    const voll = await withIntakeUploadLock(userId, async () => {
      const [cnt] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ?',
        [report.id]
      )
      return Number(cnt[0].c) >= MAX_IMAGES
    })
    if (voll) return reply.status(409).send({ error: `Maximal ${MAX_IMAGES} Fotos pro Anzeige.` })

    const sha256 = photoSha256(upload.buffer)
    const existing = await findExistingPhoto(userId, sha256)
    if (existing) return reply.status(409).send({ error: `Dieses Foto ist schon vorhanden (${existing}).`, doppelt: true })

    let row
    try {
      row = await saveImageToReport(userId, report.id, upload, sha256)
    } catch {
      return reply.status(400).send({ error: 'Nur JPG-, PNG- und HEIC/HEIF-Bilder werden unterstützt.' })
    }

    // Metadaten vom Handy nur als Ersatz für fehlendes EXIF.
    const zeit = ZEIT_RE.test(felder.aufgenommen || '') ? felder.aufgenommen : null
    const genau = Number(felder.genauigkeit)
    const gpsOk = Number.isFinite(genau) && genau > 0 && genau <= MAX_GENAUIGKEIT_M
    const lat = gpsOk ? koordinate(felder.lat, 90) : null
    const lon = gpsOk ? koordinate(felder.lon, 180) : null
    if (zeit || (lat !== null && lon !== null)) {
      await pool.execute(
        `UPDATE report_images
            SET captured_at = COALESCE(captured_at, ?),
                gps_lat = IF(gps_lat IS NULL OR gps_lat = 0, ?, gps_lat),
                gps_lon = IF(gps_lon IS NULL OR gps_lon = 0, ?, gps_lon)
          WHERE id = ?`,
        [zeit, lat !== null && lon !== null ? lat : null, lat !== null && lon !== null ? lon : null, row.id]
      )
    }

    // Kennzeichen im Hintergrund erkennen, Tatort aus dem Standort nachtragen.
    queuePlateAnalysis(userId, report.id, row.id, row.filename, row.mimetype)
    queueTatortFill(report.id)
    return reply.send({ id: row.id })
  })

  // Aufnahme abgeschlossen: Tattag/Tatzeit aus den Fotos (erste bis letzte
  // Aufnahme, wie beim Foto-Import in intakeGrouping.ts).
  app.post('/kamera/:az/fertig', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'Entwurf nicht gefunden.' })
    if (report.status !== 'entwurf') return reply.send({ ok: true })

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT DATE_FORMAT(MIN(captured_at), '%Y-%m-%d') AS tag_von, DATE_FORMAT(MAX(captured_at), '%Y-%m-%d') AS tag_bis,
              DATE_FORMAT(MIN(captured_at), '%H:%i:%s') AS zeit_von, DATE_FORMAT(MAX(captured_at), '%H:%i:%s') AS zeit_bis,
              COUNT(*) AS fotos
         FROM report_images WHERE report_id = ?`,
      [report.id]
    )
    const t = rows[0]
    if (t?.tag_von) {
      const tagBis = t.tag_bis !== t.tag_von ? t.tag_bis : null
      const zeitBis = tatzeitBis(t.zeit_von, t.zeit_bis, !!tagBis)
      await pool.execute(
        `UPDATE reports SET tattag = ?, tattag_bis = ?, tatzeit_von = ?, tatzeit_bis = ?
          WHERE id = ? AND status = 'entwurf'`,
        [t.tag_von, tagBis, t.zeit_von, zeitBis, report.id]
      )
    }
    queueTatortFill(report.id)
    return reply.send({ ok: true, fotos: Number(t?.fotos ?? 0) })
  })

  app.post('/kamera/:az/sticker', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const code = normalizeCode((request.body as { code?: string } | undefined)?.code)
    if (!code) return reply.status(400).send({ error: 'Das ist kein gültiger Sticker-Code (8 Zeichen, z. B. 7KQ2-XM9P).' })
    const report = await loadReportByAktenzeichen(az, userId)
    const result = report ? await linkCode(userId, code, report.id) : 'anzeige'
    if (result !== 'ok') return reply.status(409).send({ error: LINK_MELDUNG[result] })
    return reply.send({ ok: true, code: formatCode(code) })
  })

  app.post('/kamera/:az/verwerfen', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (report) await trashDrafts(userId, [report.id])
    return reply.send({ ok: true })
  })
}
