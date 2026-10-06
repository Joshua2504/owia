// Einmaliger Lauf nach dem ALPR-Modellwechsel (Commit 3ce1155): alle Fotos
// offener Entwürfe mit dem neuen Modell erneut analysieren und das Kennzeichen
// der Anzeige nach der neuen Mehrheitsregel (bestPlateForReport) setzen.
//
// Überschrieben wird nur, was die alte Erkennung selbst eingetragen hat: Ist
// das Feld leer oder gleich einer ALTEN Foto-Lesung, wird es durch den neuen
// Vorschlag ersetzt. Von Hand eingetragene Werte (keiner alten Lesung gleich)
// bleiben unangetastet. Ohne neuen sicheren Vorschlag bleibt das Feld, wie es ist.
// Aufruf: npx tsx src/scripts/reanalyze-plates.ts
import path from 'path'
import fs from 'fs/promises'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { recognizePlate } from '../services/alpr'
import { reportDir } from '../services/drafts'
import { bestPlateForReport, plateCropName } from '../services/plateAnalysis'


async function main(): Promise<void> {
  const [reports] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, user_id, aktenzeichen, kennzeichen FROM reports
      WHERE status='entwurf' AND versand_status IS NULL ORDER BY id`
  )
  let changed = 0
  for (const r of reports) {
    const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, mimetype, detected_plate FROM report_images WHERE report_id=? ORDER BY sort_order, id',
      [r.id]
    )
    if (!imgs.length) continue
    const oldPlates = new Set(imgs.map((i) => i.detected_plate).filter(Boolean))
    for (const img of imgs) {
      const file = path.join(reportDir(r.user_id, r.id), img.filename)
      const res = await recognizePlate(file, img.mimetype)
      if (!res) continue // Datei fehlt / Dienst-Fehler: alte Lesung behalten
      const best = res.best
      {
        await pool.execute(
          `UPDATE report_images SET detected_plate=?, plate_confidence=?, analysis_status='done', analyzed_at=NOW()
            WHERE id=?`,
          [best?.plate ?? null, best?.confidence ?? null, img.id]
        )
        if (best?.cropJpeg) {
          await fs.writeFile(path.join(reportDir(r.user_id, r.id), plateCropName(img.filename)), best.cropJpeg).catch(() => {})
        }
      }
    }
    const best = await bestPlateForReport(r.id)
    const current = (r.kennzeichen || '').trim()
    const auto = !current || oldPlates.has(current)
    if (best && auto && best.plate !== current) {
      changed++
      console.log(`${r.aktenzeichen}: ${current || '(leer)'} -> ${best.plate}`)
      {
        await pool.execute(
          `UPDATE reports SET kennzeichen=? WHERE id=? AND status='entwurf' AND (kennzeichen IS NULL OR kennzeichen=?)`,
          [best.plate, r.id, r.kennzeichen ?? '']
        )
      }
    }
  }
  console.log(`Fertig: ${reports.length} Entwürfe, ${changed} Kennzeichen geändert.`)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
