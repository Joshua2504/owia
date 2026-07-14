import './types'
import path from 'path'
import fs from 'fs/promises'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import formbody from '@fastify/formbody'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import view from '@fastify/view'
import ejs from 'ejs'

import authRoutes from './routes/auth'
import dashboardRoutes from './routes/dashboard'
import reportsRoutes from './routes/reports'
import intakeRoutes from './routes/intake'
import settingsRoutes from './routes/settings'
import geoRoutes from './routes/geo'
import tilesRoutes from './routes/tiles'
import publicRoutes from './routes/public'
import legalRoutes from './routes/legal'
import adminRoutes from './routes/admin'
import { startInboxPolling, processInboundMail } from './services/mailInbox'
import { failStalePlateAnalyses } from './services/plateAnalysis'
import { viewData } from './middleware/auth'
import { PdfService } from './services/pdf'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { initDb } from './db/init'
import { MySQLSessionStore } from './db/session-store'
import { pool } from './db/connection'

// trustProxy: hinter Caddy sonst falsches Protokoll (secure-Cookies) und
// Docker-interne IPs statt Client-IPs in Logs und Rate-Limits.
const app = Fastify({ logger: { level: 'info' }, trustProxy: true })

const IS_PROD = process.env.NODE_ENV === 'production'

async function main() {
  // Fail-fast statt unsicherem Betrieb: In Produktion MÜSSEN ein echtes
  // SESSION_SECRET und APP_URL gesetzt sein (sonst signierbare Sessions mit
  // öffentlich bekanntem Fallback bzw. Host-Header-Injection in Magic-Links).
  if (IS_PROD) {
    const secret = process.env.SESSION_SECRET || ''
    if (secret.length < 32 || secret.includes('change-this') || secret.includes('fallback-dev')) {
      app.log.fatal('SESSION_SECRET fehlt oder ist ein Platzhalter – Start in Produktion verweigert.')
      process.exit(1)
    }
    if (!process.env.APP_URL || !process.env.APP_URL.startsWith('https://')) {
      app.log.fatal('APP_URL fehlt oder ist nicht https – Start in Produktion verweigert.')
      process.exit(1)
    }
  }

  await initDb()

  // Lauter Selbsttest: sind die Daten-Verzeichnisse beschreibbar? Häufige
  // Ursache für "PDF wird nicht erzeugt" in Produktion sind falsche Rechte
  // auf den gemounteten Volumes – das soll direkt beim Start im Log stehen.
  for (const dir of [
    path.join(process.cwd(), 'data', 'pdfs'),
    path.join(process.cwd(), 'data', 'uploads'),
  ]) {
    try {
      await fs.mkdir(dir, { recursive: true })
      const probe = path.join(dir, '.write-probe')
      await fs.writeFile(probe, '')
      await fs.rm(probe, { force: true })
    } catch (err) {
      app.log.error({ err, dir }, 'Datenverzeichnis nicht beschreibbar – PDF/Uploads werden fehlschlagen!')
    }
  }

  // Security-Header (CSP: nur eigene Quellen – alle Assets werden selbst
  // gehostet; data: für das SVG-Favicon und Karten-Marker-Thumbnails).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Inline-Scripts in den Views (Theme, Lightbox, JSON-LD)
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"], // PDF-Vorschau im eigenen iframe erlaubt, Clickjacking von außen nicht
      },
    },
  })

  // Rate-Limits: global nur als grober Missbrauchs-Deckel. Bild-, Kachel- und
  // Asset-Requests summieren sich beim normalen Blättern schnell (eine Listen-
  // seite lädt viele Thumbnails, die Karte viele Kacheln) – daher hoch angesetzt;
  // die sensiblen, mail-versendenden Endpoints sind einzeln streng limitiert.
  await app.register(rateLimit, {
    global: true,
    max: 2000,
    timeWindow: '1 minute',
  })

  await app.register(formbody)
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB pro Bild
      files: 10,
    },
  })
  await app.register(cookie)
  await app.register(session, {
    secret: process.env.SESSION_SECRET || 'fallback-dev-secret-replace-in-production',
    // Sessions in der DB ablegen, damit ein App-/Stack-Neustart die Anmeldung
    // nicht verwirft (Default wäre ein flüchtiger In-Memory-Store).
    store: new MySQLSessionStore(),
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      // Default-Lebensdauer; bei „Angemeldet bleiben" auf 30 Tage erhöht (auth.ts).
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    saveUninitialized: false,
    // rolling:false = Sessions nur speichern, wenn sie sich tatsächlich geändert
    // haben (parallele Lese-Requests sollen keine veralteten Kopien zurückschreiben).
    // Flash-Meldungen laufen deshalb bewusst NICHT über die Session, sondern über
    // ein kurzlebiges Cookie (setFlash/readFlash in middleware/auth.ts).
    rolling: false,
  })
  await app.register(staticFiles, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/public/',
  })
  await app.register(view, {
    engine: { ejs },
    root: path.join(__dirname, 'views'),
    layout: '/layout.ejs',
    // isAdmin ist Standard-false, damit das Layout es immer referenzieren kann,
    // auch bei (seltenen) Views, die ohne viewData gerendert werden.
    defaultContext: { isAdmin: false },
  })

  // Flash-Cookie nach dem Ausliefern einer HTML-Seite löschen (die Seite hat
  // die Meldung dann angezeigt). Redirects (302) und Nicht-HTML-Antworten
  // (Bilder, PDF-iframe) lassen das Cookie unangetastet.
  app.addHook('onSend', async (request, reply, payload) => {
    const isHtml = String(reply.getHeader('content-type') || '').includes('text/html')
    if (request.cookies?.flash && isHtml && reply.statusCode < 300) {
      reply.clearCookie('flash', { path: '/' })
    }
    return payload
  })

  // Alte (englische) Pfade auf die neuen deutschen umleiten – Lesezeichen und
  // bereits versendete Mail-Links (/report/...) sollen weiter funktionieren.
  app.get('/dashboard', (_req, reply) => reply.redirect(301, '/anzeigen'))
  app.get('/settings', (_req, reply) => reply.redirect(301, '/einstellungen'))
  app.get('/intake', (_req, reply) => reply.redirect(301, '/import'))
  app.get('/intake/*', (req, reply) =>
    reply.redirect(301, req.url.replace(/^\/intake/, '/import'))
  )
  app.get('/report/*', (req, reply) =>
    reply.redirect(301, req.url.replace(/^\/report/, '/anzeige').replace(/\/edit(\?|$)/, '/bearbeiten$1'))
  )

  await app.register(authRoutes)
  await app.register(dashboardRoutes)
  await app.register(reportsRoutes)
  await app.register(intakeRoutes)
  await app.register(settingsRoutes)
  await app.register(geoRoutes)
  await app.register(tilesRoutes)
  await app.register(publicRoutes)
  await app.register(legalRoutes)
  await app.register(adminRoutes)

  // Antworten des Ordnungsamts aus dem Versand-Postfach abrufen (IMAP).
  startInboxPolling(app.log)

  // Aufräumen: abgelaufene Sessions und verbrauchte/abgelaufene Login-Tokens
  // sammeln sich sonst unbegrenzt an (Löschung passierte bislang nur bei
  // erneutem Zugriff auf genau dieselbe Session-ID).
  const purge = async () => {
    try {
      await pool.execute('DELETE FROM sessions WHERE expires_at < NOW()')
      await pool.execute(
        'DELETE FROM login_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'
      )
    } catch (err) {
      app.log.warn({ err }, 'Session-/Token-Aufräumen fehlgeschlagen')
    }
  }
  setInterval(purge, 6 * 60 * 60 * 1000)
  void purge()

  // Bei einem Neustart mitten in der Kennzeichen-Analyse liegengebliebene
  // 'pending'-Bilder auflösen, sonst zeigt das Formular dort endlos den Spinner.
  void failStalePlateAnalyses()

  // Healthcheck für Monitoring/Compose: prüft DB-Verbindung.
  app.get('/health', async (_request, reply) => {
    try {
      await pool.execute('SELECT 1')
      return reply.send({ ok: true })
    } catch {
      return reply.status(503).send({ ok: false })
    }
  })

  if (process.env.NODE_ENV !== 'production') {
    // Dev-Transport für den Posteingang (Mailpit spricht kein IMAP): rohe
    // RFC822-Mail per POST einspielen, läuft durch dieselbe Pipeline.
    app.addContentTypeParser('message/rfc822', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body)
    )
    app.post('/dev/inbound-mail', async (request, reply) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body))
      const result = await processInboundMail(raw, app.log)
      return reply.send({ result })
    })

    app.get('/debug/pdf-fields', async (_req, reply) => {
      try {
        const fields = await PdfService.listFields()
        return reply.send({ fields })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: msg })
      }
    })
  }

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).view('/error.ejs', viewData(_req, { title: 'Nicht gefunden', statusCode: 404 }))
  })

  app.setErrorHandler((err, req, reply) => {
    app.log.error(err)
    // Rate-Limit-Fehler behalten ihren Status (429) und die Plain-Antwort.
    if (err.statusCode === 429) {
      return reply.status(429).send('Zu viele Anfragen – bitte kurz warten.')
    }
    return reply.status(500).view('/error.ejs', viewData(req, { title: 'Fehler', statusCode: 500 }))
  })

  await app.listen({ port: 3000, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
