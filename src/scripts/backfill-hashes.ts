// Einmaliger Backfill: SHA-256 für alle bereits hochgeladenen Fotos nachtragen
// (Migration 0031). Neue Uploads schreiben den Hash direkt mit; erst mit
// gefülltem Bestand erkennt die Duplikat-Prüfung (services/photoDedup.ts) auch
// Fotos wieder, die vor der Einführung hochgeladen wurden.
//
// Gehasht wird die Original-Datei (original_filename) – dieselbe Basis wie beim
// Upload (Buffer vor Konvertierung/Schwärzung). Fehlt die Datei, bleibt sha256
// NULL (Foto ist dann für die Prüfung unsichtbar, aber sonst unbeeinträchtigt).
// Aufruf: npx tsx src/scripts/backfill-hashes.ts
import path from 'path'
import fs from 'fs/promises'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { photoSha256 } from '../services/photoDedup'
import { UPLOAD_DIR, reportDir } from '../services/drafts'

let updated = 0
let missing = 0

async function hashFile(file: string): Promise<string | null> {
  try {
    return photoSha256(await fs.readFile(file))
  } catch {
    return null
  }
}

async function backfillReportImages(): Promise<void> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ri.id, ri.original_filename, ri.report_id, r.user_id
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
      WHERE ri.sha256 IS NULL`
  )
  for (const row of rows) {
    const hash = await hashFile(path.join(reportDir(row.user_id, row.report_id), row.original_filename))
    if (!hash) {
      missing++
      console.warn(`Datei fehlt: report_images #${row.id} (${row.original_filename})`)
      continue
    }
    await pool.execute('UPDATE report_images SET sha256 = ? WHERE id = ?', [hash, row.id])
    updated++
  }
}

async function backfillIntakePhotos(): Promise<void> {
  // Zugeordnete Fotos liegen im Entwurfs-Verzeichnis, unzugeordnete noch im
  // Intake-Verzeichnis des Batches (vgl. movePhotoFiles in routes/intake.ts).
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT p.id, p.original_filename, p.report_id, p.batch_id, b.user_id
       FROM intake_photos p
       JOIN intake_batches b ON b.id = p.batch_id
      WHERE p.sha256 IS NULL`
  )
  for (const row of rows) {
    const dir = row.report_id !== null
      ? reportDir(row.user_id, row.report_id)
      : path.join(UPLOAD_DIR, String(row.user_id), 'intake', String(row.batch_id))
    const hash = await hashFile(path.join(dir, row.original_filename))
    if (!hash) {
      missing++
      console.warn(`Datei fehlt: intake_photos #${row.id} (${row.original_filename})`)
      continue
    }
    await pool.execute('UPDATE intake_photos SET sha256 = ? WHERE id = ?', [hash, row.id])
    updated++
  }
}

async function main() {
  await backfillReportImages()
  await backfillIntakePhotos()
  console.log(`Hashes: ${updated} nachgetragen, ${missing} Dateien fehlten`)
  await pool.end()
}

main()
