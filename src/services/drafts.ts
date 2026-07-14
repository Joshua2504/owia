// Gemeinsame Helfer rund um Entwürfe (Anlegen, Datei-Ablage, Bild-Rows).
// Genutzt vom Anzeigen-Editor (src/routes/reports.ts) und vom Sammel-Import
// (src/routes/intake.ts), der pro Foto-Gruppe automatisch Entwürfe erzeugt.
import crypto from 'crypto'
import path from 'path'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { DEFAULT_CITY_ID } from '../config/cities'

export const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')

// Aktenzeichen-Alphabet ohne leicht verwechselbare Zeichen (0/O, 1/I).
// 32 Zeichen → 256 % 32 == 0, daher kein Modulo-Bias bei randomBytes.
const AKTENZEICHEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Zufälliges, nicht aus der ID ableitbares Aktenzeichen, z.B. "OWiAA-7K3QF2".
 *  Bindestrich statt '#', damit es direkt in URLs/Links verwendbar ist. */
export function generateAktenzeichen(): string {
  const bytes = crypto.randomBytes(6)
  let code = ''
  for (let i = 0; i < bytes.length; i++) {
    code += AKTENZEICHEN_ALPHABET[bytes[i] % AKTENZEICHEN_ALPHABET.length]
  }
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
