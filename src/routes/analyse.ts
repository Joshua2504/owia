import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import fs from 'fs/promises'
import path from 'path'
import { pool } from '../db/connection'
import { requireAdmin, viewData } from '../middleware/auth'
import { ladeAnalyse } from '../services/analyse'
import { loadThumbnail } from '../services/intakeImageProcessing'
import { reportDir } from '../services/drafts'
import { appUrl } from '../config/app'

export default async function analyseRoutes(app: FastifyInstance) {
  // Öffentlich: Wiederholungs-Ranking nur pseudonymisiert (services/analyse.ts).
  app.get('/analyse', async (request, reply) => {
    return reply.view('/public/analyse.ejs', viewData(request, {
      title: 'Analyse',
      pageTitle: 'Analyse: Wiederholungstäter, Zeiten, Fahrzeuge | OWiA-Anzeiger',
      metaDescription:
        'Explorative Auswertung aller versendeten Falschparker-Anzeigen: Wiederholungstäter, Wochentage und Uhrzeiten, Fahrzeugmarken und Tatbestände.',
      canonical: `${appUrl()}/analyse`,
      analyse: await ladeAnalyse(),
      admin: false,
    }))
  })

  // Dieselbe Seite mit echten Kennzeichen, Tatort und exakten Daten.
  app.get('/admin/analyse', { preHandler: requireAdmin }, async (request, reply) => {
    return reply.view('/public/analyse.ejs', viewData(request, {
      title: 'Analyse (Admin)',
      analyse: await ladeAnalyse({ mitKennzeichen: true }),
      admin: true,
    }))
  })

  // Fotos versendeter Anzeigen für die Hover-Karte der Admin-Analyse
  // (gespeicherte, ggf. geschwärzte Fassung – nicht das Original).
  async function bild(imageId: string) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.mimetype, r.id AS report_id, r.user_id
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE ri.id = ? AND r.status = 'versendet'`,
      [imageId]
    )
    return rows[0]
  }

  app.get('/admin/analyse/bild/:imageId/thumb.jpg', { preHandler: requireAdmin }, async (request, reply) => {
    const img = await bild((request.params as { imageId: string }).imageId)
    if (!img) return reply.status(404).send('Bild nicht gefunden.')
    try {
      const { buffer, type } = await loadThumbnail(reportDir(img.user_id, img.report_id), img.filename, img.mimetype)
      return reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=3600').send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })

  app.get('/admin/analyse/bild/:imageId', { preHandler: requireAdmin }, async (request, reply) => {
    const img = await bild((request.params as { imageId: string }).imageId)
    if (!img) return reply.status(404).send('Bild nicht gefunden.')
    try {
      const buffer = await fs.readFile(path.join(reportDir(img.user_id, img.report_id), path.basename(img.filename)))
      return reply.header('Content-Type', img.mimetype).header('Cache-Control', 'private, max-age=3600').send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })
}
