import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', { preHandler: requireAuth }, async (request, reply) => {
    const [reports] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, kennzeichen, tattag, tatzeit_von, tatort, verstoss_art, status, created_at
       FROM reports WHERE user_id = ? ORDER BY created_at DESC`,
      [request.session.userId]
    )
    return reply.view('/dashboard/index.ejs', viewData(request, {
      title: 'Meine Anzeigen',
      reports,
    }))
  })
}
