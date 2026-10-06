import { FastifyInstance } from 'fastify'
import { viewData } from '../middleware/auth'

export default async function legalRoutes(app: FastifyInstance) {
  // Öffentlich erreichbar (kein requireAuth), damit Impressum und
  // Datenschutzerklärung auch ohne Anmeldung aufrufbar sind.
  app.get('/impressum', async (request, reply) => {
    return reply.view('/legal/impressum.ejs', viewData(request, { title: 'Impressum' }))
  })

  app.get('/datenschutz', async (request, reply) => {
    return reply.view(
      '/legal/datenschutz.ejs',
      viewData(request, { title: 'Datenschutzerklärung' })
    )
  })

  // Ratgeber: wen man bei gefährlichen Falschparkern (Feuerwehrzufahrt usw.)
  // sofort anruft. Öffentlich + in Sitemap/robots.txt (routes/public.ts).
  app.get('/falschparker-melden', async (request, reply) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    return reply.view(
      '/legal/falschparker-melden.ejs',
      viewData(request, {
        title: 'Feuerwehrzufahrt zugeparkt – Frankfurt',
        pageTitle: 'Zugeparkte Feuerwehrzufahrt in Frankfurt melden – Hotlines | OWiA-Anzeiger',
        metaDescription:
          'Feuerwehrzufahrt, Gehweg oder Radweg in Frankfurt zugeparkt? Die richtigen Nummern: Notruf 110, Städtische Verkehrspolizei 069 212-36360, Polizei 069 755-0 – und was du am Telefon sagst.',
        canonical: `${appUrl}/falschparker-melden`,
      })
    )
  })

  app.get('/nutzungsbedingungen', async (request, reply) => {
    return reply.view(
      '/legal/nutzungsbedingungen.ejs',
      viewData(request, { title: 'Nutzungsbedingungen' })
    )
  })
}
