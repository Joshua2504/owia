import './types'
import { startJobRunner, purgeJobs, jobStats } from './services/jobs'
import { setLogger } from './services/logger'
import { assertProductionMailConfig } from './config/mail'
import path from 'path'
import fs from 'fs/promises'
import Fastify, { FastifyError } from 'fastify'
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
import reviewRoutes from './routes/review'
import stickerRoutes from './routes/sticker'
import kameraRoutes from './routes/kamera'
import intakeRoutes from './routes/intake'
import settingsRoutes from './routes/settings'
import geoRoutes from './routes/geo'
import tilesRoutes from './routes/tiles'
import publicRoutes from './routes/public'
import legalRoutes from './routes/legal'
import statistikRoutes from './routes/statistik'
import analyseRoutes from './routes/analyse'
import logosRoutes from './routes/logos'
import { verjaehrung } from './services/verjaehrung'
import { FAHRZEUG_TYPEN, FAHRZEUG_MARKEN, FAHRZEUG_FARBEN } from './config/fahrzeug'
import adminRoutes from './routes/admin'
import portalRoutes from './routes/portal'
import { resumeWatchers, portalHealthy } from './services/portalDispatch'
import { alprHealthy } from './services/alpr'
import { unlockedCities } from './config/cities'
import { startSelbsttestPlan } from './services/portalSelbsttest'
import { startInboxPolling, processInboundMail } from './services/mailInbox'
import { failStalePlateAnalyses } from './services/plateAnalysis'
import { viewData } from './middleware/auth'
import { PdfService } from './services/pdf'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { initDb } from './db/init'
import { MySQLSessionStore } from './db/session-store'
import { pool } from './db/connection'
import { purgeTrash } from './services/drafts'
import { fillMissingTatorte } from './services/tatortFill'
import { verstossGesperrt } from './services/portale'

// trustProxy: hinter Caddy sonst falsches Protokoll (secure-Cookies) und
// Docker-interne IPs statt Client-IPs in Logs und Rate-Limits. Nur Loopback
// und private Netze (Docker-Bridge, Caddy) gelten als Proxy – ein direkt
// erreichbarer Port 3000 könnte sonst per X-Forwarded-For jede IP vortäuschen
// und so die Login-Limits umgehen.
const app = Fastify({ logger: { level: 'info' }, trustProxy: ['loopback', 'uniquelocal'] })

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

  setLogger(app.log)
  assertProductionMailConfig()
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
        // Keine Inline-Scripts mehr (alles in public/js/, theme-init.js im
        // <head>); ein übersehenes <%- oder DOM-XSS kann so keinen Code
        // ausführen. <script type="application/json|ld+json"> ist davon
        // unberührt (wird nicht ausgeführt).
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        // Altcha-Widget (public/vendor/altcha.min.js) löst die Proof-of-Work-
        // Aufgabe in Web Workern aus blob:/data:-URLs.
        workerSrc: ["'self'", 'blob:', 'data:'],
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

  // CSRF-Schutz über Fetch Metadata: Alle zustandsändernden Requests müssen
  // von der eigenen Origin kommen. Moderne Browser schicken Sec-Fetch-Site bei
  // jedem Request; fremde Seiten (cross-site) werden abgewiesen, 'none' ist
  // eine Nutzer-Navigation (Adresszeile/Lesezeichen). Fehlt der Header (alte
  // Browser, curl, interne Dienste), greift weiterhin sameSite=lax des
  // Session-Cookies. Ergänzt das bisherige Lax-Cookie um einen zweiten Ring,
  // ohne Token in jedem Formular und jedem fetch.
  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
    const site = String(request.headers['sec-fetch-site'] || '')
    if (site && site !== 'same-origin' && site !== 'none') {
      request.log.warn({ site, url: request.url }, 'Cross-Site-Request abgewiesen')
      return reply.status(403).send('Anfrage von fremder Seite abgewiesen.')
    }
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
    // Fahrzeuglisten: Auswahl/Vorschläge der Inline-Felder in report-row.ejs.
    defaultContext: { isAdmin: false, verjaehrung, verstossGesperrt, fahrzeugTypen: FAHRZEUG_TYPEN, fahrzeugMarken: FAHRZEUG_MARKEN, fahrzeugFarben: FAHRZEUG_FARBEN },
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
  app.get('/dashboard', (_req, reply) => reply.redirect('/anzeigen', 301))
  app.get('/settings', (_req, reply) => reply.redirect('/einstellungen', 301))
  app.get('/intake', (_req, reply) => reply.redirect('/import', 301))
  app.get('/intake/*', (req, reply) =>
    reply.redirect(req.url.replace(/^\/intake/, '/import'), 301)
  )
  app.get('/report/*', (req, reply) =>
    reply.redirect(req.url.replace(/^\/report/, '/anzeige').replace(/\/edit(\?|$)/, '/bearbeiten$1'), 301)
  )

  await app.register(authRoutes)
  await app.register(dashboardRoutes)
  await app.register(reportsRoutes)
  await app.register(reviewRoutes)
  await app.register(stickerRoutes)
  await app.register(kameraRoutes)
  await app.register(intakeRoutes)
  await app.register(settingsRoutes)
  await app.register(geoRoutes)
  await app.register(tilesRoutes)
  await app.register(publicRoutes)
  await app.register(legalRoutes)
  await app.register(statistikRoutes)
  await app.register(analyseRoutes)
  await app.register(logosRoutes)
  await app.register(adminRoutes)
  await app.register(portalRoutes)

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
      // Nicht bestätigte Newsletter-Anmeldungen nach Ablauf der Frist löschen
      // (Double-Opt-In: ohne Bestätigung bleibt keine Adresse gespeichert).
      await pool.execute(
        'DELETE FROM newsletter_subscribers WHERE confirmed_at IS NULL AND expires_at < NOW()'
      )
      // Papierkorb: Entwürfe nach PAPIERKORB_TAGE endgültig löschen.
      await purgeTrash()
      await purgeJobs()
    } catch (err) {
      app.log.warn({ err }, 'Session-/Token-Aufräumen fehlgeschlagen')
    }
  }
  setInterval(purge, 6 * 60 * 60 * 1000)
  void purge()

  // Tatort aus Foto-GPS nachholen (services/tatortFill.ts): Entwürfe, bei denen
  // Photon beim Import nicht antwortete, und Altbestand. Erster Lauf kurz nach
  // dem Start, danach alle 15 Minuten.
  const fillTatorte = async () => {
    try {
      const n = await fillMissingTatorte()
      if (n) app.log.info({ n }, 'Tatort aus Fotos nachgetragen')
    } catch (err) {
      app.log.warn({ err }, 'Tatort-Nachtrag fehlgeschlagen')
    }
  }
  setTimeout(fillTatorte, 30 * 1000)
  setInterval(fillTatorte, 15 * 60 * 1000)

  // Hintergrund-Jobs (services/jobs.ts): Import-Gruppierung, PDFs, Mails, Versand.
  await startJobRunner(app.log)

  // Portal-Versand (Frankfurt/ekom21): offene Läufe nach Neustart weiter beobachten.
  await resumeWatchers(app.log).catch((err) => app.log.error({ err }, 'Portal-Läufe nicht wieder aufgenommen'))
  // Nächtlicher Trockenlauf gegen das Portal (services/portalSelbsttest.ts).
  startSelbsttestPlan(app.log)

  // Bei einem Neustart mitten in der Kennzeichen-Analyse liegengebliebene
  // 'pending'-Bilder auflösen, sonst zeigt das Formular dort endlos den Spinner.
  void failStalePlateAnalyses()

  // Healthcheck für Monitoring/Compose: ok nur mit DB. Dazu Warnfelder (kein
  // 503, sonst würde Compose die App bei einem hängenden Job neu starten):
  // Job-Runner (ältester wartender Job, Fehlschläge, letzter Tick), Portal-
  // und ALPR-Dienst – mit `?voll=1` auch die (langsameren) Dienst-Pings.
  app.get('/health', { config: { rateLimit: false } }, async (request, reply) => {
    try {
      await pool.execute('SELECT 1')
    } catch {
      return reply.status(503).send({ ok: false })
    }
    const jobs = await jobStats().catch(() => null)
    const warnungen: string[] = []
    if (jobs?.oldestQueuedMin != null && jobs.oldestQueuedMin > 15) warnungen.push(`ältester wartender Job ${jobs.oldestQueuedMin} min`)
    if (jobs?.lastTickSec != null && jobs.lastTickSec > 120) warnungen.push(`Job-Runner seit ${jobs.lastTickSec} s ohne Tick`)
    if (jobs?.failedLastHour) warnungen.push(`${jobs.failedLastHour} Job(s) in der letzten Stunde fehlgeschlagen`)
    const out: Record<string, unknown> = { ok: true, jobs, warnungen }
    if ((request.query as { voll?: string }).voll === '1') {
      const [portal, alpr] = await Promise.all([portalHealthy(), alprHealthy()])
      out.dienste = { portal, alpr }
      if (unlockedCities().some((c) => c.portal) && !portal) warnungen.push('Portal-Dienst nicht erreichbar')
      if (!alpr) warnungen.push('ALPR-Dienst nicht erreichbar')
    }
    return reply.send(out)
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

  // Fehlerhandler: Client-Fehler (400 ungültiges JSON, 413 zu groß, 415
  // Content-Type, 429 Rate-Limit, Schema-Fehler) behalten ihren Status – vorher
  // wurde alles zur 500-HTML-Seite, die fetch-Frontends (Autosave, Inline-
  // Bearbeitung) zeigten „Serverfehler" und das Log füllte sich mit Fehlalarmen.
  // Nur echte 5xx werden als error geloggt. Wer JSON akzeptiert, bekommt JSON.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500
    const wantsJson = String(req.headers.accept || '').includes('application/json')
    if (status >= 500) app.log.error({ err, url: req.url }, 'Unbehandelter Fehler')
    else req.log.info({ status, msg: err.message, url: req.url }, 'Client-Fehler')
    if (status === 429) return reply.status(429).send('Zu viele Anfragen – bitte kurz warten.')
    if (status < 500) {
      const texte: Record<number, string> = {
        400: 'Ungültige Anfrage.', 403: 'Nicht erlaubt.', 404: 'Nicht gefunden.',
        413: 'Die Datei ist zu groß.', 415: 'Dieses Format wird nicht unterstützt.',
      }
      const message = texte[status] || err.message || 'Ungültige Anfrage.'
      if (wantsJson) return reply.status(status).send({ error: message })
      return reply.status(status).view('/error.ejs', viewData(req, { title: 'Fehler', statusCode: status, message }))
    }
    if (wantsJson) return reply.status(500).send({ error: 'Interner Fehler.' })
    return reply.status(500).view('/error.ejs', viewData(req, { title: 'Fehler', statusCode: 500 }))
  })

  await app.listen({ port: 3000, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
