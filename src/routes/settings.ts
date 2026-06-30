import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', { preHandler: requireAuth }, async (request, reply) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT email, vorname, nachname, strasse, plz, ort, telefon FROM users WHERE id = ?',
      [request.session.userId]
    )
    return reply.view('/settings/index.ejs', viewData(request, {
      title: 'Einstellungen',
      user: rows[0],
    }))
  })

  app.post('/settings', { preHandler: requireAuth }, async (request, reply) => {
    const { vorname, nachname, strasse, plz, ort, telefon } =
      request.body as Record<string, string>

    await pool.execute(
      `UPDATE users SET vorname=?, nachname=?, strasse=?, plz=?, ort=?, telefon=?
       WHERE id = ?`,
      [vorname, nachname, strasse, plz, ort, telefon, request.session.userId]
    )

    const name = [vorname, nachname].filter(Boolean).join(' ')
    request.session.userName = name || request.session.userEmail
    request.session.flash = { type: 'success', message: 'Einstellungen gespeichert.' }
    await request.session.save()
    return reply.redirect('/settings')
  })
}
