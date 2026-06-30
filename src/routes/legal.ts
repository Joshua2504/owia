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

  app.get('/nutzungsbedingungen', async (request, reply) => {
    return reply.view(
      '/legal/nutzungsbedingungen.ejs',
      viewData(request, { title: 'Nutzungsbedingungen' })
    )
  })
}
