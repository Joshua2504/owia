// Verwaiste PDF-Formulare von Portal-Städten entfernen. Frankfurt nimmt seit
// 10/2026 keine PDF-Anzeigen mehr an (Versand über das ekom21-Portal), für
// Portal-Städte wird kein PDF mehr erzeugt (config/cities.ts hasPdfForm) – die
// vorher erzeugten Dateien offener Anzeigen (Entwurf, eingereicht, Papierkorb)
// sollen auch nicht mehr angezeigt werden. Versendete Anzeigen bleiben
// unangetastet (Beleg dessen, was damals per Mail rausging).
// Aufruf: npx tsx src/scripts/pdf-aufraeumen.ts [--trocken]
import fs from 'fs/promises'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { getCity, hasPdfForm } from '../config/cities'
import { pdfPath } from '../services/drafts'

async function main(): Promise<void> {
  const trocken = process.argv.includes('--trocken')
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, user_id, city, status, pdf_filename FROM reports
      WHERE pdf_filename IS NOT NULL AND status IN ('entwurf','eingereicht','papierkorb')`
  )
  let n = 0
  const uebrig: Record<string, number> = {}
  for (const r of rows) {
    const city = getCity(r.city)
    if (hasPdfForm(city)) {
      uebrig[city.id] = (uebrig[city.id] || 0) + 1
      continue
    }
    n++
    if (trocken) continue
    await fs.rm(pdfPath(r.user_id, String(r.pdf_filename)), { force: true }).catch(() => {})
    await pool.execute('UPDATE reports SET pdf_filename=NULL WHERE id=? AND pdf_filename=?', [r.id, r.pdf_filename])
  }
  console.log(`${trocken ? '[trocken] ' : ''}${n} PDFs von Portal-Städten entfernt (von ${rows.length} offenen Anzeigen mit PDF).`)
  for (const [c, k] of Object.entries(uebrig)) console.log(`  behalten: ${k}× ${c} (Formular-Stadt)`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
