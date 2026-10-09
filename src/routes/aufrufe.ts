import { FastifyInstance } from 'fastify'
import { requireAdmin, viewData } from '../middleware/auth'
import { ladeAufrufe } from '../services/aufrufe'

// Seitenaufrufe & Wege (anonyme Tageszähler, services/aufrufe.ts).
const ZEITRAEUME = [7, 30, 90, 365]

export default async function aufrufeRoutes(app: FastifyInstance) {
  app.get('/admin/aufrufe', { preHandler: requireAdmin }, async (request, reply) => {
    const q = request.query as { tage?: string; seite?: string }
    const tage = ZEITRAEUME.includes(Number(q.tage)) ? Number(q.tage) : 30
    const seite = typeof q.seite === 'string' && q.seite.startsWith('/') ? q.seite.slice(0, 191) : undefined
    return reply.view('/admin/aufrufe.ejs', viewData(request, {
      title: 'Aufrufe',
      zeitraeume: ZEITRAEUME,
      a: await ladeAufrufe(tage, seite),
    }))
  })
}
