// Automatisches Schwärzen von Daten Dritter (fremde Kennzeichen, Gesichter) auf
// gespeicherten Beweisfotos – serverseitiges Gegenstück zu „Schwärzung
// übernehmen" im Foto-Dialog (public/js/photo-edit.js). Grundlage ist die
// gespeicherte Bildanalyse (report_images.analyse_json, services/dritte.ts).
//
// Läuft von selbst (Nutzervorgabe 20.10.2026): als Job `fotos.schwaerzen` nach
// jeder Kennzeichen-Analyse (plateAnalysis.ts, Import, Verschieben) und alle
// 15 Minuten über alle offenen Anzeigen (server.ts – Bestand, nachträglich
// eingetragene Kennzeichen). Der Nutzer kann im Foto-Dialog „Schwärzung
// aufheben" (POST …/original); danach (und nach jeder eigenen Fassung, PUT)
// gilt report_images.auto_schwaerzen_aus und der Server lässt das Foto in Ruhe.
// Je Fassung wird höchstens einmal geschwärzt (auto_geschwaerzt) – was die
// Neu-Analyse danach noch findet, bleibt für den Foto-Dialog.
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
import { dritteFunde, istAngezeigtesKennzeichen, parseAnalyse, type DritteFund } from './dritte'
import { prepareImage, writeReplacementImage, removeDerivedFiles } from './images'
import { processReportImageDerivatives } from './intakeImageProcessing'
import { plateCropName, recognizeQueued } from './plateAnalysis'
import { enqueueJob, registerJob } from './jobs'
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
  auto_schwaerzen_aus?: number
  auto_geschwaerzt?: number
  analysis_status?: string | null
  kennzeichen: string | null
}

export type SchwaerzErgebnis =
  | { stand: 'nichts' }
  | { stand: 'offen'; offen: DritteFund[] }
  | { stand: 'geschwaerzt'; boxen: number; offen: DritteFund[]; filename: string }
  | { stand: 'fehler'; grund: string; offen: DritteFund[] }

/** Ein Foto automatisch schwärzen (trocken = nur planen, nichts ändern). */
export async function schwaerzeFoto(img: FotoZeile, opts: { trocken?: boolean } = {}): Promise<SchwaerzErgebnis> {
  if (img.dritte_ok || img.auto_schwaerzen_aus || img.auto_geschwaerzt) return { stand: 'nichts' }
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
  // Nur ersetzen, wenn das Foto inzwischen nicht anderweitig geändert, vom
  // Nutzer übernommen oder freigegeben wurde. Während der Neu-Analyse 'pending':
  // drittProblem (submit.ts) sperrt das Einreichen so lange.
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE report_images SET filename=?, mimetype=?, analyse_json=NULL, dritte_ok=0, auto_geschwaerzt=1, analysis_status='pending'
      WHERE id=? AND filename=? AND auto_schwaerzen_aus=0 AND dritte_ok=0`,
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
  // Über die serielle ALPR-Kette (plateAnalysis.ts), nicht an ihr vorbei.
  let offen = plan.offen
  const result = await recognizeQueued(path.join(dir, filename), prepared.mimetype)
  if (result?.analyse) {
    await pool.execute("UPDATE report_images SET analyse_json=?, analysis_status='done' WHERE id=? AND filename=?", [JSON.stringify(result.analyse), img.id, filename])
    offen = dritteFunde(result.analyse, img.kennzeichen)
  } else {
    // Dienst weg: Foto ohne Analyse – drittProblem verlangt dann die Sichtprüfung.
    const alt = img.analysis_status && img.analysis_status !== 'pending' ? img.analysis_status : 'failed'
    await pool.execute("UPDATE report_images SET analysis_status=? WHERE id=? AND filename=? AND analysis_status='pending'", [alt, img.id, filename])
  }
  return { stand: 'geschwaerzt', boxen: plan.boxen.length, offen, filename }
}

const FOTO_SPALTEN = `ri.id, ri.report_id, r.user_id, ri.filename, ri.original_filename, ri.mimetype, ri.detected_plate,
            ri.analyse_json, ri.dritte_ok, ri.auto_schwaerzen_aus, ri.auto_geschwaerzt, ri.analysis_status,
            r.kennzeichen, r.aktenzeichen`
/** Offene Anzeige: Entwurf oder eingereicht, aber nicht im (unklaren) Versand. */
const OFFEN = "r.status IN ('entwurf','eingereicht') AND r.versand_status IS NULL"
/** Kandidaten: analysiert, nicht freigegeben, nicht vom Nutzer übernommen, diese
 *  Fassung noch nicht automatisch geschwärzt. */
const KANDIDAT = `ri.analyse_json IS NOT NULL AND ri.dritte_ok = 0 AND ri.auto_schwaerzen_aus = 0
        AND ri.auto_geschwaerzt = 0 AND COALESCE(ri.analysis_status, '') <> 'pending'`

/** Fotos offener Anzeigen, die das automatische Schwärzen noch angehen kann. */
export async function offeneFotos(aktenzeichen?: string): Promise<FotoZeile[]> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ${FOTO_SPALTEN}
       FROM report_images ri JOIN reports r ON r.id = ri.report_id
      WHERE ${OFFEN} AND ${KANDIDAT}
        ${aktenzeichen ? 'AND r.aktenzeichen = ?' : ''}
      ORDER BY r.id, ri.sort_order, ri.id`,
    aktenzeichen ? [aktenzeichen] : []
  )
  return rows as FotoZeile[]
}

/** Alle schwärzbaren Fotos einer Anzeige schwärzen. Läuft noch eine Analyse
 *  dieser Anzeige, wartet es auf sie – deren Ende reiht den Job neu ein. */
export async function schwaerzeAnzeige(reportId: number): Promise<number> {
  const [pending] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT 1 FROM report_images WHERE report_id=? AND analysis_status='pending' LIMIT 1",
    [reportId]
  )
  if (pending.length) return 0
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ${FOTO_SPALTEN}
       FROM report_images ri JOIN reports r ON r.id = ri.report_id
      WHERE r.id = ? AND ${OFFEN} AND ${KANDIDAT}
      ORDER BY ri.sort_order, ri.id`,
    [reportId]
  )
  let n = 0
  for (const f of rows as FotoZeile[]) {
    const r = await schwaerzeFoto(f)
    if (r.stand === 'geschwaerzt') n++
  }
  return n
}

/** Automatisches Schwärzen einer Anzeige im Hintergrund anstoßen (nach einer
 *  Analyse). Ein wartender Job je Anzeige genügt. */
export function queueAutoSchwaerzen(reportId: number): void {
  void enqueueJob('fotos.schwaerzen', { reportId }, { key: `schwaerzen:${reportId}` }).catch(() => {})
}

/** Durchlauf über alle offenen Anzeigen (server.ts, alle 15 min): Bestand und
 *  Fotos, deren Anzeige erst später ein Kennzeichen bekam. Reiht nur Jobs für
 *  Anzeigen ein, auf denen es tatsächlich etwas zu schwärzen gibt. */
export async function schwaerzenNachholen(): Promise<number> {
  const fotos = await offeneFotos()
  const ids = new Set<number>()
  for (const f of fotos) if (schwaerzPlan(f.analyse_json, f.kennzeichen).boxen.length) ids.add(Number(f.report_id))
  for (const id of ids) queueAutoSchwaerzen(id)
  return ids.size
}

registerJob('fotos.schwaerzen', async ({ reportId }, log) => {
  const n = await schwaerzeAnzeige(Number(reportId))
  if (n) log.info({ reportId, fotos: n }, 'Daten Dritter automatisch geschwärzt')
})
