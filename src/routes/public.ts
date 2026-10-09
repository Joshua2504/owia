import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { viewData, setFlash } from '../middleware/auth'
import { loadPixelated } from '../services/intakeImageProcessing'
import { kartenAnalyse } from '../services/dritte'
import { getCity, unlockedCities, DEFAULT_CITY_ID } from '../config/cities'
import { isValidEmail, normalizeEmail } from './auth'
import { MailService } from '../services/mail'
import { createChallenge, verifyCaptcha } from '../services/captcha'
import { huPlaketten } from '../services/huPlakette'

// Öffentliche, anonyme Übersicht aller versendeter Anzeigen auf einer Karte.
// Bewusst ohne Auth: Startseite und Daten sind öffentlich sichtbar. Es werden
// nur Verstoßart, Tattag, Koordinaten und ein stark verpixeltes Foto geliefert –
// kein Kennzeichen, kein Name, kein Aktenzeichen, kein Adresstext.

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')

// Nur abgeschlossene (versendete) Anzeigen mit Koordinaten erscheinen öffentlich.
// `<> 0` filtert Altbestand mit 0/0 aus (Golf von Guinea): leere Hidden-Felder
// im Formular wurden früher als 0 gespeichert – siehe Kommentar bei `coord()`
// in src/routes/reports.ts. Ein solcher Marker zog die Karte auf die Weltkugel.
const PUBLIC_WHERE =
  "r.status='versendet' AND r.tatort_lat IS NOT NULL AND r.tatort_lon IS NOT NULL" +
  ' AND r.tatort_lat <> 0 AND r.tatort_lon <> 0'

/** Öffentliche Koordinaten: genaue Tatort-Position (~1 m, 5 Nachkommastellen).
 *  Nutzerentscheidung 09.10.2026 – die frühere ~100-m-Rundung reihte die Marker
 *  im Raster auf; Rückschluss auf Stellplätze bewusst in Kauf genommen. */
const genau = (v: unknown) => Math.round(Number(v) * 1e5) / 1e5

/** Startseiten-Kennzahlen kurz zwischenspeichern: drei COUNT-Abfragen und ein
 *  GROUP BY bei jedem Aufruf der (öffentlichen, nicht limitierten) Startseite
 *  wären bei Crawler-Traffic unnötige DB-Last. */
/** Fotos je Anzeige auf der öffentlichen Karte (wie publicImages.ts). */
const MAX_KARTENFOTOS = 10

let statsCache: { bis: number; stats: { total: number; last30: number; fotos: number }; top: string | null } | null = null
const STATS_TTL_MS = 5 * 60 * 1000
async function startseitenKennzahlen() {
  if (statsCache && statsCache.bis > Date.now()) return statsCache
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
  statsCache = {
    bis: Date.now() + STATS_TTL_MS,
    stats: { total: Number(statsRows[0]?.total || 0), last30: Number(statsRows[0]?.last30 || 0), fotos: Number(statsRows[0]?.fotos || 0) },
    top: topRows[0]?.verstoss_art || null,
  }
  return statsCache
}

export default async function publicRoutes(app: FastifyInstance) {
  // Öffentliche Startseite mit der Übersichtskarte.
  app.get('/', async (request, reply) => {
    const geo = getCity(DEFAULT_CITY_ID).geo

    // Öffentliche Kennzahlen – nur aggregierte Werte über versendete Anzeigen,
    // keine personenbezogenen Daten (5 min gecacht).
    const kz = await startseitenKennzahlen()
    const statsRows = [kz.stats]
    const topRows = kz.top ? [{ verstoss_art: kz.top }] : []

    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    return reply.view('/public/index.ejs', viewData(request, {
      title: 'Übersicht',
      // SEO: sprechender Titel + Beschreibung für Suchmaschinen und Vorschauen.
      pageTitle: 'Falschparker melden – kostenlos Anzeige erstatten | OWiA-Anzeiger',
      metaDescription:
        'Falschparker anzeigen: Fotos hochladen, Tatort und Zeit automatisch aus den Bildern, fertige Anzeige fürs zuständige Ordnungsamt – kostenlos und in wenigen Minuten. Gehweg, Radweg oder Feuerwehrzufahrt zugeparkt? Jetzt Ordnungswidrigkeit melden – in immer mehr Städten.',
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
      cities: unlockedCities(),
      huPlaketten: huPlaketten(),
    }))
  })

  // ---------------------------------------------------------------------------
  // Newsletter: Benachrichtigung, wenn neue Städte/PLZ freigeschaltet werden.
  // Double-Opt-In: Anmeldung -> Bestätigungs-Mail -> Klick auf Link. Der Token
  // dient auch als Abmelde-Link in jeder Ankündigung.
  // ---------------------------------------------------------------------------

  // Service Worker unter der Root ausliefern: unter /public/ wäre sein Scope
  // auf /public/ beschränkt und die PWA nicht installierbar (Datei liegt
  // trotzdem bei den anderen statischen Assets in public/).
  app.get('/sw.js', async (_request, reply) => {
    return reply.type('application/javascript; charset=utf-8').sendFile('sw.js')
  })

  // Captcha-Challenge fürs Altcha-Widget (Login- und Newsletter-Formular).
  // Rate-limitiert, damit sich niemand Challenges auf Vorrat holt.
  app.get('/captcha', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (_request, reply) => {
    return reply.send(createChallenge())
  })

  // Anmeldung (Formular auf der Startseite). Streng rate-limitiert, weil hier
  // E-Mails an fremde Adressen ausgelöst werden können.
  app.post('/newsletter', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { email, plz, altcha } = (request.body || {}) as { email?: string; plz?: string; altcha?: string }
    if (!verifyCaptcha(altcha)) {
      setFlash(reply, 'error', 'Bitte die Sicherheitsprüfung abschließen und erneut absenden.')
      return reply.redirect('/#newsletter')
    }
    if (!email || !isValidEmail(email)) {
      setFlash(reply, 'error', 'Bitte gib eine gültige E-Mail-Adresse ein.')
      return reply.redirect('/#newsletter')
    }
    // PLZ ist optional (zeigt, wo Nachfrage sitzt); alles außer 5 Ziffern -> NULL.
    const plzValue = /^\d{5}$/.test((plz || '').trim()) ? (plz || '').trim() : null
    const normalized = normalizeEmail(email)

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, token, confirmed_at FROM newsletter_subscribers WHERE email = ?',
      [normalized]
    )
    const existing = rows[0]

    // Immer dieselbe neutrale Antwort (kein Rückschluss, ob eine Adresse
    // angemeldet ist). Bereits Bestätigte bekommen keine weitere Mail.
    const message =
      'Fast geschafft! Falls die Adresse noch nicht angemeldet ist, haben wir dir ' +
      'eine E-Mail mit einem Bestätigungslink geschickt.'

    try {
      if (!existing) {
        const token = crypto.randomBytes(32).toString('hex')
        await pool.execute(
          `INSERT INTO newsletter_subscribers (email, token, plz, expires_at)
           VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 48 HOUR))`,
          [normalized, token, plzValue]
        )
        const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
        await MailService.sendNewsletterConfirmation(normalized, `${appUrl}/newsletter/bestaetigen/${token}`)
      } else if (!existing.confirmed_at) {
        // Erneuter Versuch: Frist verlängern, PLZ ggf. aktualisieren und die
        // Bestätigung noch einmal senden.
        await pool.execute(
          `UPDATE newsletter_subscribers
              SET expires_at = DATE_ADD(NOW(), INTERVAL 48 HOUR), plz = COALESCE(?, plz)
            WHERE id = ?`,
          [plzValue, existing.id]
        )
        const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
        await MailService.sendNewsletterConfirmation(normalized, `${appUrl}/newsletter/bestaetigen/${existing.token}`)
      }
      setFlash(reply, 'success', message)
    } catch (err) {
      request.log.error({ err }, 'Newsletter-Anmeldung fehlgeschlagen')
      setFlash(reply, 'error', 'Anmeldung gerade nicht möglich. Bitte später erneut versuchen.')
    }
    return reply.redirect('/#newsletter')
  })

  // Double-Opt-In-Bestätigung aus der E-Mail.
  app.get('/newsletter/bestaetigen/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE newsletter_subscribers SET confirmed_at = NOW()
        WHERE token = ? AND confirmed_at IS NULL AND expires_at > NOW()`,
      [token]
    )
    if (result.affectedRows > 0) {
      setFlash(reply, 'success', 'Anmeldung bestätigt! Wir melden uns, sobald neue Städte dazukommen.')
    } else {
      setFlash(reply, 'error', 'Der Bestätigungslink ist ungültig oder abgelaufen. Bitte melde dich erneut an.')
    }
    return reply.redirect('/#newsletter')
  })

  // Abmelden (Link in jeder Ankündigungs-Mail). Eintrag wird vollständig gelöscht.
  app.get('/newsletter/abmelden/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    await pool.execute('DELETE FROM newsletter_subscribers WHERE token = ?', [token])
    setFlash(reply, 'success', 'Du bist abgemeldet und deine Adresse wurde gelöscht.')
    return reply.redirect('/')
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
        'Allow: /falschparker-melden',
        'Allow: /statistik',
        'Allow: /analyse',
        'Disallow: /',
        `Sitemap: ${appUrl}/sitemap.xml`,
        '',
      ].join('\n')
    )
  })

  app.get('/sitemap.xml', async (_request, reply) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    const urls = ['/', '/login', '/impressum', '/datenschutz', '/nutzungsbedingungen', '/falschparker-melden', '/statistik', '/analyse']
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
              (SELECT GROUP_CONCAT(ri.id ORDER BY ri.sort_order, ri.id) FROM report_images ri
                WHERE ri.report_id = r.id) AS image_ids
         FROM reports r
        WHERE ${PUBLIC_WHERE}
        ORDER BY r.tattag DESC
        LIMIT 1000`
    )
    const reports = rows.map((r) => {
      // Alle Fotos (Hover/Popup der Karte), höchstens MAX_KARTENFOTOS.
      const ids = String(r.image_ids || '').split(',').filter(Boolean).slice(0, MAX_KARTENFOTOS)
      const imageUrls = ids.map((id) => `/api/public/bild/${id}/pixel.jpg`)
      return {
      lat: genau(r.tatort_lat),
      lon: genau(r.tatort_lon),
      verstossArt: r.verstoss_art || null,
      tattag: r.tattag || null,
      imageUrl: imageUrls[0] || null,
      imageUrls,
    }})
    return reply.send({ reports })
  })

  // Öffentliche Fassung des ersten Fotos einer versendeten Anzeige: erkannte
  // Kennzeichen/Gesichter geschwärzt, sonst stark verpixelt (pixelate.ts).
  // Das Original verlässt den Server nie.
  app.get('/api/public/bild/:imageId/pixel.jpg', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { imageId } = request.params as { imageId: string }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.user_id, r.id AS report_id, ri.filename, ri.mimetype, ri.analyse_json, ri.kennzeichen_box, ri.kennzeichen_keins
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
      // Berechnung im Bild-Worker (nicht im Eventloop): ohne Cache dekodierte
      // cachedPixelate() das Vollbild synchron – ein Durchzählen der Bild-IDs
      // hätte die App sekundenweise angehalten.
      const pixelated = await loadPixelated(imageDir, img.filename, img.mimetype, kartenAnalyse(img.analyse_json, img.kennzeichen_box, img.kennzeichen_keins))
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
