// Kennzeichen-Erkennung über den selbst-gehosteten ALPR-Dienst (docker/alpr,
// YOLOv9 + fast-plate-ocr). Muster wie src/services/geocode.ts: native fetch +
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

export type PlateResult = {
  plate: string
  confidence: number
  normalized: boolean
  /** Kennzeichen-Ausschnitt als JPEG (vom Dienst mitgeliefert), null wenn keiner kam. */
  cropJpeg: Buffer | null
}

/** Vollständige Bildanalyse für die Datenschutz-Prüfung (services/dritte.ts),
 *  gespeichert als report_images.analyse_json. Boxen in Bildpixeln [x1,y1,x2,y2]
 *  des analysierten Fotos (EXIF-Ausrichtung angewendet, wie im Browser). */
export type BildAnalyse = {
  w: number
  h: number
  plates: { text: string; confidence: number; bbox: number[] }[]
  faces: { score: number; bbox: number[] }[]
  /** Marke/Farbe des Autos am besten Kennzeichen (bzw. des ganzen Fotos):
   *  Top-5-Wahrscheinlichkeiten je Gruppe, Label → p. Fehlt bei älteren
   *  Analysen und wenn der Dienst die Klassifikation nicht liefern konnte. */
  fahrzeug?: { marke: Record<string, number>; farbe: Record<string, number> }
}

/** Wahrscheinlichkeiten aus der Dienst-Antwort übernehmen (nur endliche Zahlen). */
function probs(x: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[String(k).slice(0, 40)] = v
    }
  }
  return out
}

/** Erreichbarkeit des Dienstes für /health (nur wenn ALPR überhaupt genutzt wird). */
export async function alprHealthy(): Promise<boolean> {
  if (!alprEnabled()) return true
  try {
    const res = await fetch(`${ALPR_URL}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/** Erfolgreiche Analyse; best=null heißt "kein Kennzeichen im Bild gefunden". */
export type RecognizeResult = { best: PlateResult | null; analyse: BildAnalyse | null }

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
      width?: number
      height?: number
      plates?: { text?: string; confidence?: number; bbox?: number[] }[]
      faces?: { score?: number; bbox?: number[] }[]
      fahrzeug?: { marke?: unknown; farbe?: unknown } | null
      best?: {
        text?: string | null
        confidence?: number | null
        normalized?: boolean
        crop?: string | null
      } | null
    }
    // Ältere ALPR-Images liefern keine Bildgröße/Gesichter – dann keine Analyse.
    const analyse: BildAnalyse | null = data.width && data.height
      ? {
          w: data.width,
          h: data.height,
          plates: (data.plates || []).filter((p) => p.text && Array.isArray(p.bbox)).map((p) => ({
            text: String(p.text).toUpperCase().trim().slice(0, 20),
            confidence: typeof p.confidence === 'number' ? p.confidence : 0,
            bbox: p.bbox!.slice(0, 4).map(Number),
          })),
          faces: (data.faces || []).filter((f) => Array.isArray(f.bbox)).map((f) => ({ score: Number(f.score) || 0, bbox: f.bbox!.slice(0, 4).map(Number) })),
          ...(data.fahrzeug ? { fahrzeug: { marke: probs(data.fahrzeug.marke), farbe: probs(data.fahrzeug.farbe) } } : {}),
        }
      : null
    const best = data.best
    if (!best?.text) return { best: null, analyse }
    let cropJpeg: Buffer | null = null
    if (best.crop) {
      try {
        cropJpeg = Buffer.from(best.crop, 'base64')
      } catch {
        /* defekter Crop ist verzichtbar – Kennzeichen-Text reicht */
      }
    }
    return {
      best: {
        plate: String(best.text).toUpperCase().trim().slice(0, 20),
        confidence: typeof best.confidence === 'number' ? best.confidence : 0,
        normalized: best.normalized === true,
        cropJpeg,
      },
      analyse,
    }
  } catch {
    // Dienst nicht erreichbar / Timeout – Aufrufer markiert das Bild als 'failed'.
    return null
  }
}
