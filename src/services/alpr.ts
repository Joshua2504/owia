// Kennzeichen-Erkennung über den selbst-gehosteten ALPR-Dienst (docker/alpr,
// YOLOv11 + PaddleOCR). Muster wie src/services/geocode.ts: native fetch +
// AbortController, jeder Fehler -> null (das Feld bleibt dann einfach leer).
import fs from 'fs/promises'

const ALPR_URL = (process.env.ALPR_URL || 'http://alpr:8000').replace(/\/$/, '')

/** Mindest-Konfidenz, ab der ein erkanntes Kennzeichen ein leeres Feld vorbefüllt. */
export const ALPR_MIN_CONFIDENCE = (() => {
  const v = Number(process.env.ALPR_MIN_CONFIDENCE)
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.75
})()

/**
 * Ob die Kennzeichenerkennung genutzt wird. Der alpr-Container läuft nur im
 * Production-Compose-Profil; in der Entwicklung ist die Analyse daher
 * standardmäßig AUS. Mit ALPR_ENABLED=on/off gezielt überschreibbar.
 */
export function alprEnabled(): boolean {
  const v = (process.env.ALPR_ENABLED || '').toLowerCase()
  if (['on', '1', 'true', 'yes'].includes(v)) return true
  if (['off', '0', 'false', 'no'].includes(v)) return false
  return process.env.NODE_ENV === 'production'
}

export type PlateResult = { plate: string; confidence: number; normalized: boolean }

/** Erfolgreiche Analyse; best=null heißt "kein Kennzeichen im Bild gefunden". */
export type RecognizeResult = { best: PlateResult | null }

/** Erkennt das wahrscheinlichste Kennzeichen auf dem Bild.
 *  null = Dienst nicht erreichbar/Fehler (Aufrufer markiert 'failed'). */
export async function recognizePlate(
  filePath: string,
  mimetype = 'image/jpeg'
): Promise<RecognizeResult | null> {
  let buffer: Buffer
  try {
    buffer = await fs.readFile(filePath)
  } catch {
    return null
  }

  try {
    const form = new FormData()
    // Buffer in ein eigenständiges Uint8Array kopieren (erfüllt den BlobPart-Typ
    // und entkoppelt von Node's geteiltem Buffer-Pool).
    const bytes = new Uint8Array(buffer)
    form.append('file', new Blob([bytes], { type: mimetype || 'image/jpeg' }), 'image.jpg')

    // CPU-Inferenz + mögliche Warteschlange im Dienst: großzügiges Timeout.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)
    const res = await fetch(`${ALPR_URL}/recognize`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) return null
    const data = (await res.json()) as {
      best?: { text?: string | null; confidence?: number | null; normalized?: boolean } | null
    }
    const best = data.best
    if (!best?.text) return { best: null }
    return {
      best: {
        plate: String(best.text).toUpperCase().trim().slice(0, 20),
        confidence: typeof best.confidence === 'number' ? best.confidence : 0,
        normalized: best.normalized === true,
      },
    }
  } catch {
    // Dienst nicht erreichbar / Timeout – Aufrufer markiert das Bild als 'failed'.
    return null
  }
}
