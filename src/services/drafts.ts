// Gemeinsame Helfer rund um Entwürfe (Anlegen, Löschen, Datei-Ablage, Bild-Rows).
// Genutzt vom Anzeigen-Editor (src/routes/reports.ts) und vom Sammel-Import
// (src/routes/intake.ts), der pro Foto-Gruppe automatisch Entwürfe erzeugt.
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { DEFAULT_CITY_ID } from '../config/cities'
import { detectCityByLabel } from './districts'

export const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')
export const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')

/** Zufälliges, nicht aus der ID ableitbares Aktenzeichen, z.B. "OWiA-123456".
 *  Rein numerisch und 6-stellig (leichter zu diktieren/abzutippen); bei
 *  Kollision würfelt createDraft() neu. Bindestrich statt '#', damit es
 *  direkt in URLs/Links verwendbar ist. */
export function generateAktenzeichen(): string {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  return `OWiA-${code}`
}

/** Verzeichnis der Bilddateien eines Entwurfs. */
export function reportDir(userId: number, reportId: number | string): string {
  return path.join(UPLOAD_DIR, String(userId), String(reportId))
}

/** Ablage der Fotos eines Sammel-Imports, bevor sie Entwürfen zugeordnet
 *  werden (routes/intake.ts; Datenexport und Hash-Backfill lesen sie auch). */
export function intakeDir(userId: number | string, batchId: number | string): string {
  return path.join(UPLOAD_DIR, String(userId), 'intake', String(batchId))
}

/** PDF-Verzeichnis eines Nutzers. */
export function pdfDir(userId: number | string): string {
  return path.join(PDF_DIR, String(userId))
}

/** Pfad eines erzeugten Anzeigen-PDFs (reports.pdf_filename). Getrennt von
 *  pdfDir, damit ein fehlender Dateiname nie still zum Verzeichnis wird. */
export function pdfPath(userId: number | string, filename: string): string {
  return path.join(PDF_DIR, String(userId), filename)
}

/** Noch bearbeitbarer Entwurf: Status 'entwurf' und kein Versand-Claim
 *  (versand_status gesetzt = Versand läuft oder ist ungeklärt, siehe
 *  services/reportDispatch.ts) – JS-Gegenstück zu
 *  `status = 'entwurf' AND versand_status IS NULL` in den SQL-Guards.
 *  Strikter Vergleich mit null wie bisher an allen Stellen. */
export function isEditableDraft(r: Record<string, unknown>): boolean {
  return r.status === 'entwurf' && r.versand_status === null
}

export type DraftFields = {
  tattag?: string | null // 'YYYY-MM-DD'
  tattagBis?: string | null // Ende an einem anderen Tag (über Mitternacht)
  tatzeitVon?: string | null // 'HH:MM' oder 'HH:MM:SS'
  tatzeitBis?: string | null
  tatort?: string | null
  tatortLat?: number | null
  tatortLon?: number | null
  intakeBatchId?: number | null
}

/** Höchstzahl neu angelegter Anzeigen je Nutzer und Kalendertag (Papierkorb zählt mit). */
export const MAX_DRAFTS_PER_DAY = 200

/** Wird von createDraft() geworfen, wenn das Tageslimit erreicht ist.
 *  statusCode 409 → der globale Fehlerhandler zeigt die Meldung an. */
export class DraftLimitError extends Error {
  statusCode = 409
  constructor() {
    super(`Tageslimit erreicht: maximal ${MAX_DRAFTS_PER_DAY} Anzeigen pro Tag. Bitte morgen weitermachen.`)
  }
}

/** Neuen Entwurf anlegen; Aktenzeichen wird bei (extrem seltener) Kollision neu gewürfelt.
 *  Ohne tattag/tatzeitVon wird der aktuelle Zeitpunkt vorbelegt (häufigster Fall: Vorfall jetzt). */
export async function createDraft(
  userId: number,
  fields: DraftFields = {}
): Promise<{ id: number; aktenzeichen: string }> {
  // Zuständige Stadt aus dem (beim Import bereits reverse-geocodierten) Tatort
  // ableiten, sonst Default. So landet ein importierter Bad-Soden-Entwurf sofort
  // bei der richtigen Stadt; der Nutzer kann im Formular weiterhin umstellen.
  const det = detectCityByLabel(fields.tatort)
  const initialCity = det.status === 'unlocked' ? det.city.id : DEFAULT_CITY_ID

  const [cnt] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM reports WHERE user_id = ? AND created_at >= CURDATE()',
    [userId]
  )
  if (Number(cnt[0].c) >= MAX_DRAFTS_PER_DAY) throw new DraftLimitError()

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateAktenzeichen()
    try {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO reports
           (user_id, status, tattag, tattag_bis, tatzeit_von, tatzeit_bis, tatort, tatort_lat, tatort_lon,
            intake_batch_id, aktenzeichen, city)
         VALUES (?, 'entwurf', COALESCE(?, CURDATE()), ?, COALESCE(?, CURTIME()), ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          fields.tattag ?? null,
          fields.tattagBis ?? null,
          fields.tatzeitVon ?? null,
          fields.tatzeitBis ?? null,
          fields.tatort ?? null,
          fields.tatortLat ?? null,
          fields.tatortLon ?? null,
          fields.intakeBatchId ?? null,
          candidate,
          initialCity,
        ]
      )
      return { id: result.insertId, aktenzeichen: candidate }
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY' && attempt < 4) continue
      throw err
    }
  }
  throw new Error('Aktenzeichen-Erzeugung fehlgeschlagen')
}

/** Entwurf samt Dateien vollständig entfernen (DB-Zeile, Upload-Verzeichnis, PDF).
 *  Vorher die intake_photos-Buchhaltung löschen: deren FK ist ON DELETE SET NULL –
 *  die Fotos würden sonst in der Import-Übersicht als „nicht zugeordnet" wieder
 *  auftauchen, obwohl ihre Dateien mit dem Entwurfs-Verzeichnis verschwinden. */
export async function deleteDraft(
  userId: number,
  report: { id: number; pdf_filename?: string | null }
): Promise<void> {
  await pool.execute('DELETE FROM intake_photos WHERE report_id = ?', [report.id])
  await pool.execute('DELETE FROM reports WHERE id = ? AND user_id = ?', [report.id, userId])
  try {
    await fs.rm(reportDir(userId, report.id), { recursive: true, force: true })
  } catch {
    /* egal */
  }
  if (report.pdf_filename) {
    try {
      await fs.rm(pdfPath(userId, report.pdf_filename), { force: true })
    } catch {
      /* egal */
    }
  }
}

/** Tage, die ein Entwurf im Papierkorb bleibt, bevor er endgültig verschwindet. */
export const PAPIERKORB_TAGE = 30

/** Entwürfe in den Papierkorb verschieben (nur eigene, unversendete Entwürfe).
 *  Dateien bleiben liegen – erst purgeTrash/deleteDraft entfernt sie. */
export async function trashDrafts(userId: number, reportIds: number[]): Promise<number> {
  if (reportIds.length === 0) return 0
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE reports SET status = 'papierkorb', papierkorb_at = NOW()
      WHERE id IN (${reportIds.map(() => '?').join(',')}) AND user_id = ?
        AND status = 'entwurf' AND versand_status IS NULL`,
    [...reportIds, userId]
  )
  return res.affectedRows
}

/** Entwürfe aus dem Papierkorb wiederherstellen. */
export async function restoreDrafts(userId: number, reportIds: number[]): Promise<number> {
  if (reportIds.length === 0) return 0
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE reports SET status = 'entwurf', papierkorb_at = NULL
      WHERE id IN (${reportIds.map(() => '?').join(',')}) AND user_id = ? AND status = 'papierkorb'`,
    [...reportIds, userId]
  )
  return res.affectedRows
}

/** Papierkorb-Einträge endgültig löschen – ohne userId alle abgelaufenen
 *  (Aufräum-Job), mit userId die angegebenen bzw. alle des Nutzers. */
export async function purgeTrash(opts: { userId?: number; reportIds?: number[] } = {}): Promise<number> {
  const where = ["status = 'papierkorb'"]
  const params: (number | string)[] = []
  if (opts.userId === undefined) {
    where.push('papierkorb_at < DATE_SUB(NOW(), INTERVAL ? DAY)')
    params.push(PAPIERKORB_TAGE)
  } else {
    where.push('user_id = ?')
    params.push(opts.userId)
    if (opts.reportIds) {
      if (opts.reportIds.length === 0) return 0
      where.push(`id IN (${opts.reportIds.map(() => '?').join(',')})`)
      params.push(...opts.reportIds)
    }
  }
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, user_id, pdf_filename FROM reports WHERE ${where.join(' AND ')}`,
    params
  )
  for (const r of rows) await deleteDraft(r.user_id, { id: r.id, pdf_filename: r.pdf_filename })
  return rows.length
}

export type ImageRowMeta = {
  filename: string
  mimetype: string
  originalFilename: string
  originalMimetype: string
  sortOrder: number
  capturedAt?: string | null // 'YYYY-MM-DD HH:MM:SS' (Wanduhrzeit)
  gpsLat?: number | null
  gpsLon?: number | null
  sha256?: string | null // Hash des Original-Uploads (services/photoDedup.ts)
}

/** Anzahl Fotos einer Anzeige (für das Limit MAX_IMAGES in routes/reports/shared.ts;
 *  Aufrufer, die parallel hochladen, zählen unter withIntakeUploadLock). */
export async function imageCount(reportId: number): Promise<number> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ?',
    [reportId]
  )
  return Number(rows[0].c)
}

/** Beweisfotos in Versandreihenfolge mit deutsch formatierter Aufnahmezeit
 *  ("10.07.2026, 14:30") – für PDF-Fotoseiten, Mail-Anhänge und die
 *  Versandbestätigung. */
export async function evidenceImageRows(reportId: number | string): Promise<mysql.RowDataPacket[]> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT filename, mimetype, DATE_FORMAT(captured_at, '%d.%m.%Y, %H:%i') AS captured_at
       FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
    [reportId]
  )
  return rows
}

/** sort_order für ein neues Foto: ans Ende der bisherigen Reihenfolge. */
export async function nextSortOrder(reportId: number): Promise<number> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM report_images WHERE report_id = ?',
    [reportId]
  )
  return Number(rows[0].next)
}

/** Bild-Row zu einem Entwurf anlegen (Dateien liegen bereits auf Platte). */
export async function insertImageRow(reportId: number, meta: ImageRowMeta): Promise<number> {
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images
       (report_id, filename, mimetype, original_filename, original_mimetype,
        sort_order, captured_at, gps_lat, gps_lon, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reportId,
      meta.filename,
      meta.mimetype,
      meta.originalFilename,
      meta.originalMimetype,
      meta.sortOrder,
      meta.capturedAt ?? null,
      meta.gpsLat ?? null,
      meta.gpsLon ?? null,
      meta.sha256 ?? null,
    ]
  )
  return result.insertId
}
