// Datenschutz-Analyse (report_images.analyse_json, Migration 0041) für Fotos
// offener Entwürfe nachholen. Das erkannte Kennzeichen bleibt unangetastet –
// es wird nur die vollständige Analyse (alle Kennzeichen, Gesichter) ergänzt.
// Aufruf: npx tsx src/scripts/analyse-nachholen.ts
import path from 'path'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { recognizePlate } from '../services/alpr'
import { reportDir } from '../services/drafts'

async function main(): Promise<void> {
  const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ri.id, ri.filename, ri.mimetype, r.id AS report_id, r.user_id
       FROM report_images ri JOIN reports r ON r.id = ri.report_id
      WHERE r.status IN ('entwurf','eingereicht') AND ri.analyse_json IS NULL
      ORDER BY r.id, ri.sort_order, ri.id`
  )
  let ok = 0
  let fehler = 0
  for (const img of imgs) {
    const res = await recognizePlate(path.join(reportDir(img.user_id, img.report_id), img.filename), img.mimetype)
    if (!res?.analyse) {
      fehler++
      continue
    }
    await pool.execute('UPDATE report_images SET analyse_json=? WHERE id=? AND filename=?', [JSON.stringify(res.analyse), img.id, img.filename])
    if (++ok % 50 === 0) console.log(`${ok}/${imgs.length} analysiert`)
  }
  console.log(`Fertig: ${ok} analysiert, ${fehler} ohne Ergebnis (Datei fehlt/Dienst-Fehler), von ${imgs.length}.`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
