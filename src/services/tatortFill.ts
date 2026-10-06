import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { reverseGeocode } from './geocode'
import { detectCityByLabel } from './districts'

// Tatort automatisch aus den Fotos: Entwürfe ohne Adresse bekommen sie aus den
// Koordinaten – sonst blieb der Tatort leer, wenn Photon beim Import nicht
// rechtzeitig antwortete oder ein Entwurf aus einem einzelnen Foto entstand
// (dort wurden nur Koordinaten gesetzt). Ein vorhandener Tatort wird NIE
// überschrieben (alle UPDATEs prüfen auf leeres Feld).
//
// Aufrufer: fire-and-forget nach Import/Upload/Verschieben (queueTatortFill),
// synchron im Prüf-Modus (routes/review.ts) und als Nachhol-Job in server.ts
// (fillMissingTatorte) für Photon-Ausfälle und Altbestand.

/** 0/0 und Unsinn sind keine Position (gleiche Regel wie persistFields). */
function valid(lat: unknown, lon: unknown): boolean {
  const a = Number(lat)
  const b = Number(lon)
  return lat !== null && lon !== null && Number.isFinite(a) && Number.isFinite(b) && a !== 0 && b !== 0 &&
    Math.abs(a) <= 90 && Math.abs(b) <= 180
}

/** Tatort eines Entwurfs nachtragen, falls leer. Koordinaten: die der Anzeige
 *  (Import-Mittelpunkt bzw. vom Nutzer gesetzter Marker), sonst das erste Foto
 *  mit GPS. Liefert die Adresse oder null (nichts zu tun / Photon ohne Treffer). */
export async function fillTatortFromPhotos(reportId: number): Promise<string | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT r.tatort_lat, r.tatort_lon,
            (SELECT CONCAT(ri.gps_lat, ',', ri.gps_lon) FROM report_images ri
              WHERE ri.report_id = r.id AND ri.gps_lat IS NOT NULL AND ri.gps_lon IS NOT NULL
                AND ri.gps_lat <> 0 AND ri.gps_lon <> 0
              ORDER BY ri.sort_order, ri.id LIMIT 1) AS foto_gps
       FROM reports r
      WHERE r.id = ? AND r.status = 'entwurf' AND r.versand_status IS NULL AND COALESCE(r.tatort, '') = ''`,
    [reportId]
  )
  const r = rows[0]
  if (!r) return null
  let lat: number
  let lon: number
  if (valid(r.tatort_lat, r.tatort_lon)) {
    lat = Number(r.tatort_lat)
    lon = Number(r.tatort_lon)
  } else if (r.foto_gps) {
    const [a, b] = String(r.foto_gps).split(',').map(Number)
    if (!valid(a, b)) return null
    lat = a
    lon = b
  } else {
    return null
  }
  const place = await reverseGeocode(lat, lon)
  if (!place?.label) return null
  const det = detectCityByLabel(place.label)
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE reports SET tatort = ?, tatort_lat = ?, tatort_lon = ?, city = COALESCE(?, city)
      WHERE id = ? AND status = 'entwurf' AND versand_status IS NULL AND COALESCE(tatort, '') = ''`,
    [place.label, lat, lon, det.status === 'unlocked' ? det.city.id : null, reportId]
  )
  return res.affectedRows ? place.label : null
}

// Fire-and-forget-Warteschlange: nacheinander, damit ein Import mit vielen
// Entwürfen Photon nicht mit parallelen Anfragen flutet.
const queue: number[] = []
let running = false
export function queueTatortFill(reportId: number): void {
  if (!queue.includes(reportId)) queue.push(reportId)
  if (running) return
  running = true
  void (async () => {
    while (queue.length) {
      const id = queue.shift() as number
      try {
        await fillTatortFromPhotos(id)
      } catch {
        // Nachhol-Job versucht es später erneut.
      }
    }
    running = false
  })()
}

/** Nachhol-Job: alle Entwürfe ohne Tatort, aber mit Koordinaten oder Foto-GPS.
 *  Begrenzt je Lauf, damit ein großer Altbestand Photon nicht blockiert. */
export async function fillMissingTatorte(limit = 200): Promise<number> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT r.id FROM reports r
      WHERE r.status = 'entwurf' AND r.versand_status IS NULL AND COALESCE(r.tatort, '') = ''
        AND ((r.tatort_lat IS NOT NULL AND r.tatort_lat <> 0)
          OR EXISTS (SELECT 1 FROM report_images ri WHERE ri.report_id = r.id
                      AND ri.gps_lat IS NOT NULL AND ri.gps_lat <> 0))
      ORDER BY r.id
      LIMIT ${Math.max(1, Math.floor(limit))}`
  )
  let filled = 0
  for (const row of rows) {
    if (await fillTatortFromPhotos(Number(row.id)).catch(() => null)) filled++
  }
  return filled
}
