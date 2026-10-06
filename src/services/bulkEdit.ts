import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { VERSTOSS_ARTEN } from '../config/verstoss'

// Kurzlebige, signierte Vorschau: Änderungen nach der Vorschau werden nicht
// überschrieben. Ein Neustart macht offene Vorschauen bewusst ungültig.
export class BulkEditInputError extends Error {}

const previewKey = crypto.randomBytes(32)
type Change = { az: string; offense: string | null; left: number | null; nextOffense: string | null; nextLeft: number | null }
type Preview = { userId: number; expires: number; changes: Change[] }

export async function previewBulkEdit(userId: number, body: Record<string, unknown>) {
  if (!Array.isArray(body.az) || !body.az.length || body.az.length > 50 || body.az.some(a => typeof a !== 'string' || !/^OWiA-\d{6}$/.test(a))) {
    throw new BulkEditInputError('Bitte 1 bis 50 Entwürfe auswählen.')
  }
  const offenseMode = body.offenseMode
  const leftMode = body.leftMode
  if (!['keep', 'set', 'clear'].includes(String(offenseMode)) || !['keep', 'yes', 'no'].includes(String(leftMode))) throw new BulkEditInputError('Ungültige Bearbeitungsoption.')
  if (offenseMode === 'set' && (typeof body.offense !== 'string' || !VERSTOSS_ARTEN.includes(body.offense))) throw new BulkEditInputError('Bitte eine Verstoßart aus dem Katalog auswählen.')
  if (offenseMode === 'keep' && leftMode === 'keep') throw new BulkEditInputError('Bitte mindestens eine Änderung wählen.')
  const azList = [...new Set(body.az as string[])]
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT aktenzeichen, kennzeichen, tatort, status, versand_status, verstoss_art, fahrzeug_verlassen FROM reports WHERE user_id=? AND aktenzeichen IN (${azList.map(() => '?').join(',')})`,
    [userId, ...azList]
  )
  const changes: Change[] = []
  const items = azList.map(az => {
    const row = rows.find(r => r.aktenzeichen === az)
    if (!row || row.status !== 'entwurf' || row.versand_status !== null) return { az, reason: 'Nicht bearbeitbar oder nicht gefunden.' }
    const offense = row.verstoss_art as string | null
    const left = row.fahrzeug_verlassen === null ? null : Number(row.fahrzeug_verlassen)
    const nextOffense = offenseMode === 'keep' || (body.overwrite !== true && !!offense) ? offense : offenseMode === 'clear' ? null : body.offense as string
    const nextLeft = leftMode === 'keep' ? left : leftMode === 'yes' ? 1 : 0
    const change = { az, offense, left, nextOffense, nextLeft }
    if (offense !== nextOffense || left !== nextLeft) changes.push(change)
    return { ...change, plate: row.kennzeichen, place: row.tatort, reason: offense === nextOffense && left === nextLeft ? 'Unverändert.' : '' }
  })
  const payload = Buffer.from(JSON.stringify({ userId, expires: Date.now() + 10 * 60_000, changes } satisfies Preview)).toString('base64url')
  const signature = crypto.createHmac('sha256', previewKey).update(payload).digest('base64url')
  return { items, count: changes.length, token: payload + '.' + signature }
}

export async function applyBulkEdit(userId: number, token: unknown) {
  if (typeof token !== 'string' || token.length > 200_000) throw new BulkEditInputError('Ungültige Vorschau. Bitte erneut prüfen.')
  const [payload, signature, extra] = token.split('.')
  const expected = crypto.createHmac('sha256', previewKey).update(payload || '').digest('base64url')
  if (extra || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new BulkEditInputError('Ungültige Vorschau. Bitte erneut prüfen.')
  const preview = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Preview
  if (preview.userId !== userId || preview.expires < Date.now()) throw new BulkEditInputError('Die Vorschau ist abgelaufen. Bitte erneut prüfen.')
  const results: { az: string; ok: boolean; message: string }[] = []
  for (const change of preview.changes) {
    try {
      // Wie Autosave: Die Einreichung erzeugt das PDF aus aktuellen Angaben.
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `UPDATE reports SET verstoss_art=?, fahrzeug_verlassen=? WHERE aktenzeichen=? AND user_id=? AND status='entwurf' AND versand_status IS NULL AND verstoss_art <=> ? AND fahrzeug_verlassen <=> ?`,
        [change.nextOffense, change.nextLeft, change.az, userId, change.offense, change.left]
      )
      results.push({ az: change.az, ok: result.affectedRows > 0, message: result.affectedRows > 0 ? 'Gespeichert.' : 'Inzwischen geändert oder nicht mehr bearbeitbar. Bitte erneut prüfen.' })
    } catch {
      results.push({ az: change.az, ok: false, message: 'Speichern fehlgeschlagen. Bitte erneut versuchen.' })
    }
  }
  return results
}
