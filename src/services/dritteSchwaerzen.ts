// Automatisches Schwärzen von Daten Dritter (fremde Kennzeichen, Gesichter) auf
// gespeicherten Beweisfotos – serverseitiges Gegenstück zu „Schwärzung
// übernehmen" im Foto-Dialog (public/js/photo-edit.js). Grundlage ist die
// gespeicherte Bildanalyse (report_images.analyse_json, services/dritte.ts).
//
// Ohne Sichtprüfung wird bewusst vorsichtig geschwärzt:
// - Gesichter immer.
// - Fremde Kennzeichen nur, wenn das angezeigte Kennzeichen auf demselben Foto
//   erkannt wurde. Fehlt es, könnte die „fremde" Lesung das angezeigte Fahrzeug
//   mit OCR-Fehler sein – dann bliebe das Beweisfoto ohne Kennzeichen. Solche
//   Fälle bleiben für den Foto-Dialog offen (Einreichen ist weiter gesperrt).
//
// Ablauf je Foto wie PUT /anzeige/:az/images/:imageId: neue Fassung unter neuem
// Namen, Original bleibt, Ableitungen neu, Analyse für die neue Fassung erneuern.
import fs from 'fs/promises'
import path from 'path'
import jpeg from 'jpeg-js'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import type { BildAnalyse } from './alpr'
import { recognizePlate } from './alpr'
import { dritteFunde, istAngezeigtesKennzeichen, parseAnalyse, type DritteFund } from './dritte'
import { prepareImage, writeReplacementImage, removeDerivedFiles } from './images'
import { processReportImageDerivatives } from './intakeImageProcessing'
import { plateCropName } from './plateAnalysis'
import { applyOrientation, decode, readOrientation } from './pixelate'
import { reportDir } from './drafts'

/** Rand um jede Box (Anteil der Boxgröße) – wie der Vorschlag im Foto-Dialog. */
const RAND_X = 0.12
const RAND_Y = 0.15
/** JPEG-Qualität der geschwärzten Fassung (Beweisfoto, soll lesbar bleiben). */
const QUALITAET = 92

export type SchwaerzPlan = { boxen: DritteFund[]; offen: DritteFund[] }

/** Teilt die Funde in automatisch schwärzbare und offene (nur im Dialog). */
export function schwaerzPlan(analyseJson: unknown, kennzeichen: string | null | undefined): SchwaerzPlan {
  const funde = dritteFunde(analyseJson, kennzeichen)
  const a = parseAnalyse(analyseJson)
  const eigenesErkannt = !!a && a.plates.some((p) => istAngezeigtesKennzeichen(p.text, kennzeichen))
  const boxen: DritteFund[] = []
  const offen: DritteFund[] = []
  for (const f of funde) (f.art === 'gesicht' || eigenesErkannt ? boxen : offen).push(f)
  return { boxen, offen }
}

/** Boxen (Koordinaten des analysierten Bildes) mit Rand im Vollbild schwärzen
 *  und als JPEG kodieren. Wirft, wenn die Analyse nicht zum Bild passt. */
export function schwaerzeBoxen(buffer: Buffer, mimetype: string, orientation: number, analyse: BildAnalyse, boxen: DritteFund[]): Buffer {
  const img = applyOrientation(decode(buffer, mimetype), orientation)
  const sx = img.width / analyse.w
  const sy = img.height / analyse.h
  if (Math.abs(sx - sy) / Math.max(sx, sy) > 0.05) throw new Error('Bildausrichtung passt nicht zur Analyse')
  for (const { bbox } of boxen) {
    const [x1, y1, x2, y2] = bbox
    const rx = Math.abs(x2 - x1) * RAND_X
    const ry = Math.abs(y2 - y1) * RAND_Y
    const ax = Math.max(0, Math.floor((Math.min(x1, x2) - rx) * sx))
    const ay = Math.max(0, Math.floor((Math.min(y1, y2) - ry) * sy))
    const bx = Math.min(img.width, Math.ceil((Math.max(x1, x2) + rx) * sx))
    const by = Math.min(img.height, Math.ceil((Math.max(y1, y2) + ry) * sy))
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) {
        const i = (y * img.width + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 0
      }
    }
  }
  return Buffer.from(jpeg.encode({ data: img.data, width: img.width, height: img.height }, QUALITAET).data)
}

export type FotoZeile = {
  id: number
  report_id: number
  user_id: number
  filename: string
  original_filename: string
  mimetype: string
  detected_plate: string | null
  analyse_json: unknown
  dritte_ok: number
  kennzeichen: string | null
}

export type SchwaerzErgebnis =
  | { stand: 'nichts' }
  | { stand: 'offen'; offen: DritteFund[] }
  | { stand: 'geschwaerzt'; boxen: number; offen: DritteFund[]; filename: string }
  | { stand: 'fehler'; grund: string; offen: DritteFund[] }

/** Ein Foto automatisch schwärzen (trocken = nur planen, nichts ändern). */
export async function schwaerzeFoto(img: FotoZeile, opts: { trocken?: boolean } = {}): Promise<SchwaerzErgebnis> {
  if (img.dritte_ok) return { stand: 'nichts' }
  const plan = schwaerzPlan(img.analyse_json, img.kennzeichen)
  if (!plan.boxen.length) return plan.offen.length ? { stand: 'offen', offen: plan.offen } : { stand: 'nichts' }
  if (opts.trocken) return { stand: 'geschwaerzt', boxen: plan.boxen.length, offen: plan.offen, filename: img.filename }

  const dir = reportDir(img.user_id, img.report_id)
  const analyse = parseAnalyse(img.analyse_json)!
  let neu: Buffer
  try {
    const original = await fs.readFile(path.join(dir, img.filename))
    neu = schwaerzeBoxen(original, img.mimetype || 'image/jpeg', await readOrientation(original), analyse, plan.boxen)
  } catch (err) {
    return { stand: 'fehler', grund: (err as Error).message, offen: plan.offen }
  }

  const prepared = await prepareImage(neu, 'geschwaerzt.jpg', 'image/jpeg')
  const filename = await writeReplacementImage(dir, prepared)
  // Nur ersetzen, wenn das Foto inzwischen nicht anderweitig geändert wurde.
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    'UPDATE report_images SET filename=?, mimetype=?, analyse_json=NULL, dritte_ok=0 WHERE id=? AND filename=?',
    [filename, prepared.mimetype, img.id, img.filename]
  )
  if (!res.affectedRows) {
    await fs.rm(path.join(dir, filename), { force: true }).catch(() => {})
    return { stand: 'fehler', grund: 'Foto wurde zwischenzeitlich geändert', offen: plan.offen }
  }
  if (img.detected_plate !== null) {
    await fs.rename(path.join(dir, plateCropName(img.filename)), path.join(dir, plateCropName(filename))).catch(() => {})
  }
  // Alte Fassung aufräumen – das Original (Erst-Upload) niemals.
  if (img.filename !== img.original_filename) await fs.rm(path.join(dir, img.filename), { force: true }).catch(() => {})
  await removeDerivedFiles(dir, img.filename)
  await processReportImageDerivatives(filename, prepared.mimetype, dir).catch(() => {})

  // Analyse für die neue Fassung: weitere (nicht automatisch geschwärzte) Funde
  // bleiben so im Foto-Dialog sichtbar und sperren das Einreichen weiterhin.
  let offen = plan.offen
  const result = await recognizePlate(path.join(dir, filename), prepared.mimetype)
  if (result?.analyse) {
    await pool.execute('UPDATE report_images SET analyse_json=? WHERE id=? AND filename=?', [JSON.stringify(result.analyse), img.id, filename])
    offen = dritteFunde(result.analyse, img.kennzeichen)
  }
  return { stand: 'geschwaerzt', boxen: plan.boxen.length, offen, filename }
}

/** Fotos offener Anzeigen (Entwurf/eingereicht) mit Analyse, die noch nicht als
 *  unbedenklich bestätigt sind. */
export async function offeneFotos(aktenzeichen?: string): Promise<FotoZeile[]> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ri.id, ri.report_id, r.user_id, ri.filename, ri.original_filename, ri.mimetype, ri.detected_plate,
            ri.analyse_json, ri.dritte_ok, r.kennzeichen, r.aktenzeichen
       FROM report_images ri JOIN reports r ON r.id = ri.report_id
      WHERE r.status IN ('entwurf','eingereicht') AND ri.analyse_json IS NOT NULL AND ri.dritte_ok = 0
        ${aktenzeichen ? 'AND r.aktenzeichen = ?' : ''}
      ORDER BY r.id, ri.sort_order, ri.id`,
    aktenzeichen ? [aktenzeichen] : []
  )
  return rows as FotoZeile[]
}
