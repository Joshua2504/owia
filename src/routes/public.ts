import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { viewData } from '../middleware/auth'
import { cachedPixelate } from '../services/pixelate'
import { getCity, DEFAULT_CITY_ID } from '../config/cities'

// Öffentliche, anonyme Übersicht aller versendeter Anzeigen auf einer Karte.
// Bewusst ohne Auth: Startseite und Daten sind öffentlich sichtbar. Es werden
// nur Verstoßart, Tattag, Koordinaten und ein stark verpixeltes Foto geliefert –
// kein Kennzeichen, kein Name, kein Aktenzeichen, kein Adresstext.

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')

// Nur abgeschlossene (versendete) Anzeigen mit Koordinaten erscheinen öffentlich.
const PUBLIC_WHERE = "r.status='versendet' AND r.tatort_lat IS NOT NULL AND r.tatort_lon IS NOT NULL"

export default async function publicRoutes(app: FastifyInstance) {
  // Öffentliche Startseite mit der Übersichtskarte.
  app.get('/', async (request, reply) => {
    const geo = getCity(DEFAULT_CITY_ID).geo

    // Öffentliche Kennzahlen – nur aggregierte Werte über versendete Anzeigen,
    // keine personenbezogenen Daten.
    const [statsRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM reports WHERE status='versendet') AS total,
         (SELECT COUNT(*) FROM reports WHERE status='versendet'
            AND tattag >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS last30,
         (SELECT COUNT(*) FROM report_images ri
            JOIN reports r ON r.id = ri.report_id WHERE r.status='versendet') AS fotos`
    )
    const [topRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT verstoss_art, COUNT(*) AS c FROM reports
        WHERE status='versendet' AND verstoss_art IS NOT NULL
        GROUP BY verstoss_art ORDER BY c DESC LIMIT 1`
    )

    return reply.view('/public/index.ejs', viewData(request, {
      title: 'Übersicht',
      centerLat: geo.biasLat,
      centerLon: geo.biasLon,
      stats: {
        total: Number(statsRows[0]?.total || 0),
        last30: Number(statsRows[0]?.last30 || 0),
        fotos: Number(statsRows[0]?.fotos || 0),
        topVerstoss: topRows[0]?.verstoss_art || null,
      },
    }))
  })

  // Anonyme Marker-Daten für die Karte.
  app.get('/api/public/reports', async (_request, reply) => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT r.aktenzeichen, r.tattag, r.verstoss_art, r.tatort_lat, r.tatort_lon,
              (SELECT ri.id FROM report_images ri
                WHERE ri.report_id = r.id ORDER BY ri.sort_order, ri.id LIMIT 1) AS image_id
         FROM reports r
        WHERE ${PUBLIC_WHERE}
        ORDER BY r.tattag DESC
        LIMIT 1000`
    )
    const reports = rows.map((r) => ({
      lat: Number(r.tatort_lat),
      lon: Number(r.tatort_lon),
      verstossArt: r.verstoss_art || null,
      tattag: r.tattag || null,
      imageUrl: r.image_id ? `/api/public/reports/${r.aktenzeichen}/pixel.jpg` : null,
    }))
    return reply.send({ reports })
  })

  // Stark verpixeltes erstes Foto einer versendeter Anzeige. Das Original
  // verlässt den Server nie – pixelate() rechnet es serverseitig herunter.
  app.get('/api/public/reports/:az/pixel.jpg', async (request, reply) => {
    const { az } = request.params as { az: string }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.user_id, r.id AS report_id, ri.filename, ri.mimetype
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE r.aktenzeichen = ? AND r.status='versendet'
        ORDER BY ri.sort_order, ri.id LIMIT 1`,
      [az]
    )
    const img = rows[0]
    if (!img) return reply.status(404).send('Nicht gefunden.')

    const imageDir = path.join(UPLOAD_DIR, String(img.user_id), String(img.report_id))
    try {
      const pixelated = await cachedPixelate(imageDir, img.filename, img.mimetype)
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=3600')
        .send(pixelated)
    } catch (err) {
      request.log.warn({ err }, 'Verpixeltes Bild konnte nicht erzeugt werden')
      return reply.status(404).send('Nicht gefunden.')
    }
  })
}
