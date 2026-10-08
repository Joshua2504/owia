// Öffentliche Bildfassungen (Karte: <foto>.pixel.jpg) vorab berechnen, sobald
// eine Anzeige versendet ist – im Bild-Worker, nicht beim ersten anonymen
// Abruf. Der öffentliche Endpunkt (routes/public.ts) liest danach nur noch die
// Cache-Datei; ohne Vorberechnung konnte jeder unauthentifizierte Request eine
// Vollbild-Dekodierung auslösen.
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { reportDir } from './drafts'
import { kartenAnalyse } from './dritte'
import { processPixelNow } from './intakeImageProcessing'

export async function prewarmPublicImages(reportId: number): Promise<void> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT r.user_id, ri.filename, ri.mimetype, ri.analyse_json, ri.kennzeichen_box, ri.kennzeichen_keins
       FROM report_images ri JOIN reports r ON r.id = ri.report_id
      WHERE ri.report_id = ? ORDER BY ri.sort_order, ri.id LIMIT 1`,
    [reportId]
  )
  const img = rows[0]
  if (!img) return
  await processPixelNow(img.filename, img.mimetype, reportDir(img.user_id, reportId), kartenAnalyse(img.analyse_json, img.kennzeichen_box, img.kennzeichen_keins)).catch(() => {})
}
