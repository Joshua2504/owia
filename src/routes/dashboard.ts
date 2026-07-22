import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { VERSTOSS_ARTEN } from '../config/verstoss'
import { mostUsedVerstoesse } from './reports'

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get('/anzeigen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [reports] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, aktenzeichen, kennzeichen, kennzeichen_land, tattag, tatzeit_von, tatzeit_bis,
              tatort, tatort_lat, tatort_lon, verstoss_art, status, created_at,
              fahrzeug_marke, beschreibung, fahrzeug_verlassen, behinderung, behinderung_text,
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = reports.id AND rr.direction = 'in') AS reply_count,
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = reports.id AND rr.direction = 'in' AND rr.read_at IS NULL) AS unread_reply_count
       FROM reports WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    )

    // Foto-IDs pro Anzeige für die Thumbnail-Leiste (gemeinsames Tabellen-Partial).
    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.id, ri.report_id
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE r.user_id = ?
        ORDER BY ri.report_id, ri.sort_order, ri.id`,
      [userId]
    )
    const imagesByReport: Record<number, number[]> = {}
    for (const img of images) {
      ;(imagesByReport[img.report_id] ??= []).push(img.id)
    }

    return reply.view('/dashboard/index.ejs', viewData(request, {
      title: 'Meine Anzeigen',
      reports,
      imagesByReport,
      // Für die Inline-Bearbeitung der Entwürfe direkt in der Liste.
      verstossAlle: VERSTOSS_ARTEN,
      verstossHaeufig: await mostUsedVerstoesse(),
    }))
  })
}
