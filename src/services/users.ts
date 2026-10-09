import mysql from 'mysql2/promise'
import { pool } from '../db/connection'

/**
 * Vollständige Nutzerzeile (alle Spalten – Mail-Absender, PDF-Felder und
 * Portal-Payloads brauchen das ganze Profil). `undefined`, wenn es den Nutzer
 * nicht (mehr) gibt; das entspricht dem früheren `users[0]` an jeder Stelle.
 */
export async function loadUser(id: number): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM users WHERE id = ?', [id])
  return rows[0]
}
