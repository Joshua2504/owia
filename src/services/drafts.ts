// Gemeinsame Helfer rund um Entwürfe (Anlegen, Datei-Ablage, Bild-Rows).
// Genutzt vom Anzeigen-Editor (src/routes/reports.ts) und vom Sammel-Import
// (src/routes/intake.ts), der pro Foto-Gruppe automatisch Entwürfe erzeugt.
import crypto from 'crypto'
import path from 'path'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { DEFAULT_CITY_ID } from '../config/cities'

export const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')

/** Zufälliges, nicht aus der ID ableitbares Aktenzeichen, z.B. "OWiAA-123456".
 *  Rein numerisch und 6-stellig (leichter zu diktieren/abzutippen); bei
 *  Kollision würfelt createDraft() neu. Bindestrich statt '#', damit es
 *  direkt in URLs/Links verwendbar ist. */
export function generateAktenzeichen(): string {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  return `OWiAA-${code}`
}

/** Verzeichnis der Bilddateien eines Entwurfs. */
export function reportDir(userId: number, reportId: number | string): string {
  return path.join(UPLOAD_DIR, String(userId), String(reportId))
}

export type DraftFields = {
  tattag?: string | null // 'YYYY-MM-DD'
  tatzeitVon?: string | null // 'HH:MM' oder 'HH:MM:SS'
  tatzeitBis?: string | null
  tatort?: string | null
  tatortLat?: number | null
  tatortLon?: number | null
  intakeBatchId?: number | null
}

/** Neuen Entwurf anlegen; Aktenzeichen wird bei (extrem seltener) Kollision neu gewürfelt.
 *  Ohne tattag/tatzeitVon wird der aktuelle Zeitpunkt vorbelegt (häufigster Fall: Vorfall jetzt). */
export async function createDraft(
  userId: number,
  fields: DraftFields = {}
): Promise<{ id: number; aktenzeichen: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateAktenzeichen()
    try {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO reports
           (user_id, status, tattag, tatzeit_von, tatzeit_bis, tatort, tatort_lat, tatort_lon,
            intake_batch_id, aktenzeichen, city)
         VALUES (?, 'entwurf', COALESCE(?, CURDATE()), COALESCE(?, CURTIME()), ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          fields.tattag ?? null,
          fields.tatzeitVon ?? null,
          fields.tatzeitBis ?? null,
          fields.tatort ?? null,
          fields.tatortLat ?? null,
          fields.tatortLon ?? null,
          fields.intakeBatchId ?? null,
          candidate,
          DEFAULT_CITY_ID,
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

export type ImageRowMeta = {
  filename: string
  mimetype: string
  originalFilename: string
  originalMimetype: string
  sortOrder: number
  capturedAt?: string | null // 'YYYY-MM-DD HH:MM:SS' (Wanduhrzeit)
  gpsLat?: number | null
  gpsLon?: number | null
}

/** Bild-Row zu einem Entwurf anlegen (Dateien liegen bereits auf Platte). */
export async function insertImageRow(reportId: number, meta: ImageRowMeta): Promise<number> {
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images
       (report_id, filename, mimetype, original_filename, original_mimetype,
        sort_order, captured_at, gps_lat, gps_lon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ]
  )
  return result.insertId
}
