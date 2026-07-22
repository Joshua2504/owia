// Gemeinsame Bild-Pipeline: hochgeladene Fotos in ein nutzbares JPG/PNG überführen
// (HEIC/HEIF werden konvertiert, das Original bleibt erhalten) und auf Platte schreiben.
// Genutzt von den Beweisfotos (src/routes/reports.ts, src/routes/intake.ts).
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import heicConvert from 'heic-convert'

const DIRECT_IMAGE_TYPES = ['image/jpeg', 'image/png']

/** Direkt für PDF/Web verwendbares Bild plus aufbewahrtes Original. */
export type PreparedImage = {
  buffer: Buffer // JPG/PNG, wird eingebettet und im Web angezeigt
  mimetype: string
  ext: string
  originalBuffer: Buffer // exakt wie hochgeladen (z.B. HEIC)
  originalMimetype: string
  originalExt: string
  converted: boolean
}

function extFromMime(mime: string): string {
  return mime === 'image/png' ? 'png' : 'jpg'
}

function extFromName(filename: string, fallback: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : fallback
}

/** Browser melden HEIC uneinheitlich – daher MIME *und* Dateiendung prüfen. */
function isHeic(filename: string, mimetype: string): boolean {
  const f = filename.toLowerCase()
  return (
    mimetype.startsWith('image/heic') ||
    mimetype.startsWith('image/heif') ||
    f.endsWith('.heic') ||
    f.endsWith('.heif')
  )
}

/** Hochgeladenes Bild in ein nutzbares JPG/PNG (+ ggf. HEIC-Original) überführen. */
export async function prepareImage(
  buffer: Buffer,
  filename: string,
  mimetype: string
): Promise<PreparedImage> {
  if (DIRECT_IMAGE_TYPES.includes(mimetype)) {
    const ext = extFromMime(mimetype)
    return {
      buffer,
      mimetype,
      ext,
      originalBuffer: buffer,
      originalMimetype: mimetype,
      originalExt: ext,
      converted: false,
    }
  }
  if (isHeic(filename, mimetype)) {
    const jpeg = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.85 }))
    return {
      buffer: jpeg,
      mimetype: 'image/jpeg',
      ext: 'jpg',
      originalBuffer: buffer,
      originalMimetype: mimetype || 'image/heic',
      originalExt: extFromName(filename, 'heic'),
      converted: true,
    }
  }
  throw new Error('unsupported')
}

/** Vorbereitetes Bild (+ ggf. Original) in ein Verzeichnis schreiben; gibt die Dateinamen zurück. */
export async function writePreparedImage(
  dir: string,
  p: PreparedImage
): Promise<{ filename: string; originalFilename: string }> {
  await fs.mkdir(dir, { recursive: true })

  const base = `bild-${crypto.randomBytes(6).toString('hex')}`
  const filename = `${base}.${p.ext}`
  await fs.writeFile(path.join(dir, filename), p.buffer)

  let originalFilename = filename
  if (p.converted) {
    originalFilename = `${base}-original.${p.originalExt}`
    await fs.writeFile(path.join(dir, originalFilename), p.originalBuffer)
  }
  return { filename, originalFilename }
}

/** Bilddateien (nutzbare Fassung + Original + gecachte Ableitungen) entfernen. */
export async function removeImagePair(
  dir: string,
  filename: string,
  originalFilename: string
): Promise<void> {
  try {
    await fs.rm(path.join(dir, filename), { force: true })
    if (originalFilename && originalFilename !== filename) {
      await fs.rm(path.join(dir, originalFilename), { force: true })
    }
    // Gecachte Vorschau-/Pixelbilder (services/pixelate.ts) und den gespeicherten
    // Kennzeichen-Ausschnitt (services/plateAnalysis.ts) mit aufräumen.
    await fs.rm(path.join(dir, `${filename}.thumb.jpg`), { force: true })
    await fs.rm(path.join(dir, `${filename}.pixel.jpg`), { force: true })
    await fs.rm(path.join(dir, `${filename}.plate.jpg`), { force: true })
    await fs.rm(path.join(dir, `${filename}.mail.jpg`), { force: true })
  } catch {
    /* Dateien evtl. schon weg */
  }
}
