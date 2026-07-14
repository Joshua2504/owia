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
import satRoutes from './routes/sat'
import publicRoutes from './routes/public'
import legalRoutes from './routes/legal'
import adminRoutes from './routes/admin'
import { startInboxPolling, processInboundMail } from './services/mailInbox'
import { PdfService } from './services/pdf'
import { initDb } from './db/init'
import { MySQLSessionStore } from './db/session-store'

const app = Fastify({ logger: { level: 'info' } })

async function main() {
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

  await app.register(authRoutes)
  await app.register(dashboardRoutes)
  await app.register(reportsRoutes)
  await app.register(intakeRoutes)
  await app.register(settingsRoutes)
  await app.register(geoRoutes)
  await app.register(tilesRoutes)
  await app.register(satRoutes)
  await app.register(publicRoutes)
  await app.register(legalRoutes)
  await app.register(adminRoutes)

  // Antworten des Ordnungsamts aus dem Versand-Postfach abrufen (IMAP).
  startInboxPolling(app.log)

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
    reply.status(404).send('Seite nicht gefunden')
  })

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err)
    reply.status(500).send('Interner Serverfehler')
  })

  await app.listen({ port: 3000, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
