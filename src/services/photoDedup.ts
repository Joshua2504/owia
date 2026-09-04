// Duplikat-Erkennung für Foto-Uploads: SHA-256 über den unveränderten
// Upload-Buffer (das Original, NICHT die konvertierte/geschwärzte Fassung –
// so bleibt der Hash über HEIC-Konvertierung und spätere Ersatzfassungen
// stabil). Geprüft wird pro Nutzer gegen alle Anzeigen-Bilder und alle noch
// unzugeordneten Import-Fotos; genutzt vom Foto-Import (src/routes/intake.ts)
// und vom Anzeigen-Editor (src/routes/reports.ts).
import crypto from 'crypto'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'

export function photoSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** Wo ein identisches Foto des Nutzers bereits liegt (deutsches Label für die
 *  Fehlermeldung), oder null wenn es neu ist. Bestand ohne Backfill (sha256
 *  NULL) kann nicht erkannt werden – die Prüfung findet ihn schlicht nicht. */
export async function findExistingPhoto(userId: number, sha256: string): Promise<string | null> {
  // Zuerst Anzeigen-Bilder: liefert das sprechendste Label (Aktenzeichen).
  const [images] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT r.aktenzeichen
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
      WHERE ri.sha256 = ? AND r.user_id = ?
      LIMIT 1`,
    [sha256, userId]
  )
  if (images[0]) return `Anzeige ${images[0].aktenzeichen}`

  // Dann unzugeordnete Import-Fotos (zugeordnete haben eine report_images-Zeile
  // mit demselben Hash und sind oben schon gefunden worden).
  const [photos] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT p.batch_id
       FROM intake_photos p
       JOIN intake_batches b ON b.id = p.batch_id
      WHERE p.sha256 = ? AND b.user_id = ? AND p.report_id IS NULL
      LIMIT 1`,
    [sha256, userId]
  )
  if (photos[0]) return `Foto-Import #${photos[0].batch_id}`

  return null
}
