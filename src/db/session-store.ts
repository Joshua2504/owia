import { EventEmitter } from 'events'
import type { SessionStore } from '@fastify/session'
import type { Session } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from './connection'

// Persistenter Session-Store für @fastify/session, abgelegt in der MariaDB.
// Dadurch überlebt die Anmeldung App- und Stack-Neustarts (der voreingestellte
// In-Memory-Store verliert sie). Implementiert die callback-basierte
// Store-Schnittstelle (get/set/destroy) wie express-session.

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function expiryFrom(session: Session): Date {
  const exp = session?.cookie?.expires
  return exp ? new Date(exp) : new Date(Date.now() + DEFAULT_TTL_MS)
}

export class MySQLSessionStore extends EventEmitter implements SessionStore {
  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    const expiresAt = expiryFrom(session)
    const data = JSON.stringify(session)
    pool
      .execute(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
        [sessionId, data, expiresAt]
      )
      .then(() => callback())
      .catch(callback)
  }

  get(sessionId: string, callback: (err: unknown, result?: Session | null) => void): void {
    pool
      .execute<mysql.RowDataPacket[]>(
        'SELECT data, expires_at FROM sessions WHERE sid = ?',
        [sessionId]
      )
      .then(([rows]) => {
        const row = rows[0]
        if (!row) return callback(null)
        if (new Date(row.expires_at).getTime() < Date.now()) {
          // Abgelaufen – aufräumen und als nicht vorhanden behandeln.
          pool.execute('DELETE FROM sessions WHERE sid = ?', [sessionId]).catch(() => {})
          return callback(null)
        }
        try {
          const session = JSON.parse(row.data)
          // cookie.expires als Date zurückgeben (JSON liefert nur einen String).
          if (session.cookie && typeof session.cookie.expires === 'string') {
            session.cookie.expires = new Date(session.cookie.expires)
          }
          callback(null, session as Session)
        } catch (err) {
          callback(err)
        }
      })
      .catch(callback)
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    pool
      .execute('DELETE FROM sessions WHERE sid = ?', [sessionId])
      .then(() => callback())
      .catch(callback)
  }
}
