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

    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    return reply.view('/public/index.ejs', viewData(request, {
      title: 'Übersicht',
      // SEO: sprechender Titel + Beschreibung für Suchmaschinen und Vorschauen.
      pageTitle: 'Falschparker melden in Frankfurt – kostenlos Anzeige erstatten | OWiA-Anzeiger',
      metaDescription:
        'Falschparker in Frankfurt anzeigen: Fotos hochladen, Tatort und Zeit automatisch aus den Bildern, fertiges PDF fürs Ordnungsamt – kostenlos und in wenigen Minuten. Gehweg, Radweg oder Feuerwehrzufahrt zugeparkt? Jetzt Ordnungswidrigkeit melden.',
      canonical: `${appUrl}/`,
      appUrl,
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

  // Favicon für Clients/Crawler, die stur /favicon.ico anfragen (das Layout
  // liefert modernen Browsern ein SVG-Emoji per <link rel="icon">).
  app.get('/favicon.ico', async (_request, reply) => {
    return reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'public, max-age=86400')
      .send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚗</text></svg>`)
  })

  // SEO: Crawler-Regeln (nur öffentliche Seiten indexieren) + Sitemap.
  app.get('/robots.txt', async (_request, reply) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    return reply.header('Content-Type', 'text/plain').send(
      [
        'User-agent: *',
        'Allow: /$',
        'Allow: /login',
        'Allow: /impressum',
        'Allow: /datenschutz',
        'Allow: /nutzungsbedingungen',
        'Disallow: /',
        `Sitemap: ${appUrl}/sitemap.xml`,
        '',
      ].join('\n')
    )
  })

  app.get('/sitemap.xml', async (_request, reply) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    const urls = ['/', '/login', '/impressum', '/datenschutz', '/nutzungsbedingungen']
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((u) => `  <url><loc>${appUrl}${u}</loc></url>`),
      '</urlset>',
      '',
    ].join('\n')
    return reply.header('Content-Type', 'application/xml').send(xml)
  })

  // Anonyme Marker-Daten für die Karte. Bewusst OHNE Aktenzeichen: das ist
  // der Schlüssel für die Antwort-Zuordnung im Mail-Postfach und darf nicht
  // öffentlich einsehbar sein (Bild-URL läuft über die Bild-ID).
  app.get('/api/public/reports', async (_request, reply) => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT r.tattag, r.verstoss_art, r.tatort_lat, r.tatort_lon,
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
      imageUrl: r.image_id ? `/api/public/bild/${r.image_id}/pixel.jpg` : null,
    }))
    return reply.send({ reports })
  })

  // Stark verpixeltes erstes Foto einer versendeter Anzeige. Das Original
  // verlässt den Server nie – pixelate() rechnet es serverseitig herunter.
  app.get('/api/public/bild/:imageId/pixel.jpg', async (request, reply) => {
    const { imageId } = request.params as { imageId: string }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.user_id, r.id AS report_id, ri.filename, ri.mimetype
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE ri.id = ? AND r.status='versendet'
        LIMIT 1`,
      [imageId]
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
