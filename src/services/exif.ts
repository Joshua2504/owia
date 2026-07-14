// Serverseitige EXIF-Extraktion (Aufnahmezeit + GPS) aus dem Original-Upload.
// Wichtig: immer aus dem Original-Buffer lesen – die HEIC->JPG-Konvertierung
// (heic-convert) entfernt sämtliche EXIF-Daten. EXIF-Zeiten sind Wanduhrzeit
// ohne Zeitzone; sie werden bewusst NIE durch ein JS-Date gedreht (Server läuft
// im Container oft in UTC), sondern als 'YYYY-MM-DD HH:MM:SS'-String geführt.
import exifr from 'exifr'

export type PhotoMeta = {
  capturedAt: string | null // 'YYYY-MM-DD HH:MM:SS' (Wanduhrzeit, wie DATETIME)
  lat: number | null
  lon: number | null
}

/** EXIF-Rohwert "2026:07:14 15:23:01" -> "2026-07-14 15:23:01" (oder null). */
function parseExifDateTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  // Platzhalter wie "0000:00:00 00:00:00" verwerfen.
  if (y === '0000' || mo === '00' || d === '00') return null
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`
}

/** Aufnahmezeit + GPS aus dem Original-Buffer lesen; Fehler ergeben null-Meta. */
export async function extractPhotoMeta(originalBuffer: Buffer): Promise<PhotoMeta> {
  let capturedAt: string | null = null
  let lat: number | null = null
  let lon: number | null = null

  try {
    // reviveValues:false liefert Datumsfelder als rohe Strings, damit keine
    // Zeitzonen-Interpretation über JS-Date stattfindet.
    const tags = await exifr.parse(originalBuffer, {
      reviveValues: false,
      pick: ['DateTimeOriginal', 'CreateDate'],
    })
    capturedAt =
      parseExifDateTime(tags?.DateTimeOriginal) ?? parseExifDateTime(tags?.CreateDate)
  } catch {
    /* kein/kaputtes EXIF – Upload darf daran nie scheitern */
  }

  try {
    const gps = await exifr.gps(originalBuffer)
    if (
      gps &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude) &&
      (gps.latitude !== 0 || gps.longitude !== 0)
    ) {
      lat = Math.round(gps.latitude * 1e6) / 1e6
      lon = Math.round(gps.longitude * 1e6) / 1e6
    }
  } catch {
    /* kein GPS */
  }

  return { capturedAt, lat, lon }
}
