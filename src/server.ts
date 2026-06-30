import './types'
import path from 'path'
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
import settingsRoutes from './routes/settings'
import geoRoutes from './routes/geo'
import tilesRoutes from './routes/tiles'
import publicRoutes from './routes/public'
import legalRoutes from './routes/legal'
import { PdfService } from './services/pdf'
import { initDb } from './db/init'

const app = Fastify({ logger: { level: 'info' } })

async function main() {
  await initDb()

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
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    saveUninitialized: false,
  })
  await app.register(staticFiles, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/public/',
  })
  await app.register(view, {
    engine: { ejs },
    root: path.join(__dirname, 'views'),
    layout: '/layout.ejs',
    defaultContext: {},
  })

  await app.register(authRoutes)
  await app.register(dashboardRoutes)
  await app.register(reportsRoutes)
  await app.register(settingsRoutes)
  await app.register(geoRoutes)
  await app.register(tilesRoutes)
  await app.register(publicRoutes)
  await app.register(legalRoutes)

  if (process.env.NODE_ENV !== 'production') {
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
