import { FastifyInstance } from 'fastify'
import { viewData } from '../middleware/auth'
import { ladeStatistik } from '../services/statistik'

export default async function statistikRoutes(app: FastifyInstance) {
  // Öffentlich (kein requireAuth) und in Sitemap/robots.txt (routes/public.ts):
  // zeigt nur Aggregate über versendete Anzeigen, siehe services/statistik.ts.
  app.get('/statistik', async (request, reply) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    return reply.view('/public/statistik.ejs', viewData(request, {
      title: 'Statistik',
      pageTitle: 'Statistik: gemeldete Falschparker und mögliche Bußgelder | OWiA-Anzeiger',
      metaDescription:
        'Wie viele Falschparker wurden über den OWiA-Anzeiger gemeldet – und welche Bußgelder sieht der Bußgeldkatalog dafür vor? Aufgeschlüsselt nach Tatbestand und Monat.',
      canonical: `${appUrl}/statistik`,
      statistik: await ladeStatistik(),
    }))
  })
}
