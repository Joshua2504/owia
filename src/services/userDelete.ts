// Vollständiges Löschen eines Benutzerkontos durch einen Admin (z.B. Spam-
// Konten). Anders als die Selbst-Anonymisierung (routes/settings.ts) bleibt
// hier nichts erhalten: users-Zeile weg (FK-CASCADE räumt Anzeigen, Fotos,
// Sammel-Importe, Transaktionen usw. ab), dazu alle Dateien auf der Platte.
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { UPLOAD_DIR, PDF_DIR } from './drafts'
import { repliesDir } from './mailInbox'

export class UserDeleteError extends Error {}

export async function deleteUser(userId: number): Promise<{ email: string }> {
  const conn = await pool.getConnection()
  let email: string
  let replyIds: number[] = []
  try {
    await conn.beginTransaction()
    const [users] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id, email FROM users WHERE id = ? FOR UPDATE', [userId]
    )
    if (!users[0]) throw new UserDeleteError('Benutzer nicht gefunden.')
    email = users[0].email
    // Wie bei der Kontoschließung: keinen laufenden Versand abschießen.
    const [reports] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id, versand_status FROM reports WHERE user_id = ? FOR UPDATE', [userId]
    )
    if (reports.some(r => r.versand_status !== null)) {
      throw new UserDeleteError('Eine Anzeige dieses Benutzers wird gerade versendet bzw. ihr Versand ist ungeklärt.')
    }
    // report_replies hängen per ON DELETE SET NULL an – Korrespondenz explizit löschen.
    if (reports.length) {
      const ph = reports.map(() => '?').join(',')
      const [replies] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM report_replies WHERE report_id IN (${ph})`, reports.map(r => r.id)
      )
      replyIds = replies.map(r => r.id)
      if (replyIds.length) {
        await conn.execute(`DELETE FROM report_replies WHERE id IN (${replyIds.map(() => '?').join(',')})`, replyIds)
      }
    }
    await conn.execute('DELETE FROM users WHERE id = ?', [userId])
    await conn.execute('DELETE FROM login_tokens WHERE email = ?', [email])
    await conn.execute("DELETE FROM sessions WHERE JSON_EXTRACT(data, '$.userId') = ?", [userId])
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  // Dateien erst nach erfolgreichem Commit entfernen.
  await fs.rm(path.join(UPLOAD_DIR, String(userId)), { recursive: true, force: true })
  await fs.rm(path.join(PDF_DIR, String(userId)), { recursive: true, force: true })
  for (const id of replyIds) await fs.rm(repliesDir(id), { recursive: true, force: true })
  return { email }
}
