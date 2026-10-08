import { FastifyInstance } from 'fastify'
import { requireAdmin, viewData } from '../middleware/auth'
import { ladeAnalyse } from '../services/analyse'

export default async function analyseRoutes(app: FastifyInstance) {
  // Öffentlich: Wiederholungs-Ranking nur pseudonymisiert (services/analyse.ts).
  app.get('/analyse', async (request, reply) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    return reply.view('/public/analyse.ejs', viewData(request, {
      title: 'Analyse',
      pageTitle: 'Analyse: Wiederholungstäter, Zeiten, Fahrzeuge | OWiA-Anzeiger',
      metaDescription:
        'Explorative Auswertung aller versendeten Falschparker-Anzeigen: Wiederholungstäter, Wochentage und Uhrzeiten, Fahrzeugmarken und Tatbestände.',
      canonical: `${appUrl}/analyse`,
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
}
