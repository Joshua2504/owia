// Marke/Farbe/Modell (analyse_json.fahrzeug, docker/alpr/fahrzeug.py) für Fotos
// offener Entwürfe nachholen, bei denen eins davon noch leer ist, und Marke/Farbe
// danach wie beim Upload vorbefüllen (prefillReportFahrzeug: nur leere Felder,
// nur ab FAHRZEUG_MIN_P; das Modell bleibt reiner Vorschlag). Die übrige Analyse
// (Kennzeichen, Gesichter) wird dabei mit denselben Modellen neu gerechnet;
// detected_plate bleibt unangetastet.
// Aufruf: npx tsx src/scripts/fahrzeug-nachholen.ts
import path from 'path'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { recognizePlate } from '../services/alpr'
import { reportDir } from '../services/drafts'
import { prefillReportFahrzeug } from '../services/plateAnalysis'

async function main(): Promise<void> {
  const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ri.id, ri.filename, ri.mimetype, r.id AS report_id, r.user_id
       FROM report_images ri JOIN reports r ON r.id = ri.report_id
      WHERE r.status = 'entwurf'
        AND (COALESCE(r.fahrzeug_marke, '') = '' OR COALESCE(r.fahrzeug_farbe, '') = '' OR COALESCE(r.fahrzeug_modell, '') = '')
        AND (ri.analyse_json IS NULL OR ri.analyse_json NOT LIKE '%"modell"%')
      ORDER BY r.id, ri.sort_order, ri.id`
  )
  const reports = new Map<number, number>()
  let ok = 0
  let fehler = 0
  for (const img of imgs) {
    const res = await recognizePlate(path.join(reportDir(img.user_id, img.report_id), img.filename), img.mimetype)
    if (!res?.analyse?.fahrzeug) {
      fehler++
      continue
    }
    await pool.execute('UPDATE report_images SET analyse_json=? WHERE id=? AND filename=?', [JSON.stringify(res.analyse), img.id, img.filename])
    reports.set(Number(img.report_id), Number(img.user_id))
    if (++ok % 50 === 0) console.log(`${ok}/${imgs.length} analysiert`)
  }
  for (const [reportId, userId] of reports) await prefillReportFahrzeug(userId, reportId)
  const ids = [...reports.keys()]
  const [filled] = ids.length
    ? await pool.query<mysql.RowDataPacket[]>(
        `SELECT SUM(fahrzeug_marke IS NOT NULL AND fahrzeug_marke <> '') AS marke,
                SUM(fahrzeug_farbe IS NOT NULL AND fahrzeug_farbe <> '') AS farbe
           FROM reports WHERE id IN (?)`,
        [ids]
      )
    : [[{ marke: 0, farbe: 0 }]]
  console.log(
    `Fertig: ${ok} Fotos analysiert, ${fehler} ohne Ergebnis, ${ids.length} Entwürfe – ` +
      `danach mit Marke: ${filled[0].marke ?? 0}, mit Farbe: ${filled[0].farbe ?? 0}.`
  )
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
