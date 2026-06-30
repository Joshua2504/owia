// Kennzeichen-Erkennung über den selbst-gehosteten ALPR-Dienst (docker/alpr).
// Muster wie src/routes/geo.ts: native fetch + AbortController, Fehler -> null.
import fs from 'fs/promises'

const ALPR_URL = (process.env.ALPR_URL || 'http://alpr:8000').replace(/\/$/, '')

export type PlateResult = { plate: string; confidence: number }

/** Erkennt das wahrscheinlichste Kennzeichen auf dem Bild. null bei Misserfolg. */
export async function recognizePlate(
  filePath: string,
  mimetype = 'image/jpeg'
): Promise<PlateResult | null> {
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

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    const res = await fetch(`${ALPR_URL}/recognize`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) return null
    const data = (await res.json()) as { plate?: string | null; confidence?: number | null }
    if (!data.plate) return null
    return {
      plate: String(data.plate).toUpperCase().trim(),
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    }
  } catch {
    // Dienst nicht erreichbar / Timeout – Feld bleibt einfach leer.
    return null
  }
}
