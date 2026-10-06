import mysql from 'mysql2/promise'
import { pool } from '../db/connection'

export const MAX_LOGIN_ATTEMPTS = 5

/** Link und Code teilen denselben atomaren Verbrauch. Auch ein bereits zuvor
 *  gelesener Token darf nach Verbrauch/Ablauf nicht erneut anmelden. */
export async function consumeMagicLink(token: string): Promise<mysql.RowDataPacket | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM login_tokens WHERE token=? AND used_at IS NULL AND expires_at > NOW()', [token]
  )
  const row = rows[0]
  if (!row) return null
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    'UPDATE login_tokens SET used_at=NOW() WHERE id=? AND used_at IS NULL AND expires_at > NOW()',
    [row.id]
  )
  return result.affectedRows === 1 ? row : null
}

export async function consumeLoginCode(email: string, code: string): Promise<{
  token: mysql.RowDataPacket | null
  error?: string
}> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Der Zeilenlock umfasst Fehlversuch UND Verbrauch. Code- und Link-Logins
    // können sich dadurch auch bei gleichzeitiger Nutzung nicht überholen.
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM login_tokens WHERE email=? AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [email]
    )
    const token = rows[0]
    if (!token || token.attempts >= MAX_LOGIN_ATTEMPTS) {
      await conn.commit()
      return { token: null, error: 'Der Code ist abgelaufen. Bitte fordere einen neuen an.' }
    }
    const correct = code.trim() === token.code
    const [updated] = await conn.execute<mysql.ResultSetHeader>(
      `UPDATE login_tokens SET attempts=attempts+1, used_at=IF(?, NOW(), used_at)
       WHERE id=? AND used_at IS NULL AND expires_at > NOW()`, [correct, token.id]
    )
    await conn.commit()
    if (!updated.affectedRows) return { token: null, error: 'Der Code ist abgelaufen. Bitte fordere einen neuen an.' }
    return correct ? { token } : { token: null, error: 'Der Code ist nicht korrekt.' }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
