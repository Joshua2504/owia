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

/** Bildtyp aus den ersten Bytes statt aus dem vom Client gemeldeten Mimetype:
 *  JPEG (FF D8), PNG (89 50 4E 47), HEIC/HEIF (ISO-BMFF „ftyp“-Box mit heic/
 *  heix/hevc/mif1/msf1). Alles andere ist kein Bild – auch wenn der Upload
 *  „image/jpeg“ behauptet. Sonst landete z.B. HTML als „.jpg“ auf der Platte
 *  und wurde mit dem Client-Mimetype wieder ausgeliefert. */
export function sniffImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/heic' | null {
  if (buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1').toLowerCase()
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)/.test(brand)) return 'image/heic'
  }
  return null
}

/** Obergrenze der Pixelzahl für die HEIC-Dekodierung – dieselbe wie
 *  pixelate.ts MAX_PIXELS für JPEG/PNG (80 MP; aktuelle Handys liefern bis
 *  ~50 MP). heic-convert/libheif dekodiert in WebAssembly-Speicher, den die
 *  resourceLimits des Bild-Workers nicht erfassen: Eine kleine Datei mit
 *  riesigen deklarierten Maßen hätte sonst Gigabytes belegt. */
const MAX_HEIC_PIXELS = 80_000_000

/** Größte in einer HEIC/HEIF-Datei deklarierte Bildfläche aus den
 *  `ispe`-Boxen (Image Spatial Extents, meta → iprp → ipco) – ohne zu
 *  dekodieren. Berücksichtigt alle Einträge (Hauptbild, Kacheln, Vorschau),
 *  maßgeblich ist der größte. null, wenn keine `ispe` gefunden wurde
 *  (laut Norm Pflicht für jedes Bild-Item). */
export function heicDimensions(buffer: Buffer): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null
  // Container-Boxen, in die abgestiegen wird; `meta` ist eine FullBox (4 Byte
  // Version/Flags vor den Kind-Boxen).
  const container = new Set(['meta', 'iprp', 'ipco'])
  const walk = (start: number, end: number, depth: number) => {
    let i = start
    while (i + 8 <= end && depth < 6) {
      let size = buffer.readUInt32BE(i)
      const type = buffer.toString('latin1', i + 4, i + 8)
      let header = 8
      if (size === 1) {
        // 64-Bit-Größe; > 4 GB kommt bei 20-MB-Uploads nicht vor.
        if (i + 16 > end) return
        size = Number(buffer.readBigUInt64BE(i + 8))
        header = 16
      } else if (size === 0) {
        size = end - i // Box reicht bis zum Ende
      }
      if (size < header || i + size > end) return
      if (type === 'ispe' && size >= header + 12) {
        const width = buffer.readUInt32BE(i + header + 4)
        const height = buffer.readUInt32BE(i + header + 8)
        if (!best || width * height > best.width * best.height) best = { width, height }
      } else if (container.has(type)) {
        walk(i + header + (type === 'meta' ? 4 : 0), i + size, depth + 1)
      }
      i += size
    }
  }
  walk(0, buffer.length, 0)
  return best
}

/** Hochgeladenes Bild in ein nutzbares JPG/PNG (+ ggf. HEIC-Original) überführen.
 *  Läuft im Bild-Worker (intakeImageWorker.ts) – die HEIC-Dekodierung ist
 *  CPU-/speicherintensiv und gehört nie in den HTTP-Prozess. Typ und Endung
 *  kommen ausschließlich aus den Bytes (sniffImageType): Name und Mimetype
 *  des Clients werden bewusst ignoriert – ein als „image/jpeg“ gemeldetes HEIC
 *  landete sonst unkonvertiert als .jpg und war nirgends darstellbar. */
export async function prepareImage(
  buffer: Buffer,
  _filename: string,
  _mimetype: string
): Promise<PreparedImage> {
  const sniffed = sniffImageType(buffer)
  if (!sniffed) throw new Error('unsupported')
  if (DIRECT_IMAGE_TYPES.includes(sniffed)) {
    const ext = extFromMime(sniffed)
    return {
      buffer,
      mimetype: sniffed,
      ext,
      originalBuffer: buffer,
      originalMimetype: sniffed,
      originalExt: ext,
      converted: false,
    }
  }
  // HEIC/HEIF: Maße vor der Dekodierung prüfen (wie decode() für JPEG/PNG).
  const dims = heicDimensions(buffer)
  if (!dims || !dims.width || !dims.height || dims.width * dims.height > MAX_HEIC_PIXELS) {
    throw new Error(dims ? `Bild zu groß (${dims.width}×${dims.height} px)` : 'HEIC ohne Bildmaße')
  }
  const jpeg = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.85 }))
  return {
    buffer: jpeg,
    mimetype: 'image/jpeg',
    ext: 'jpg',
    originalBuffer: buffer,
    originalMimetype: 'image/heic',
    originalExt: 'heic',
    converted: true,
  }
}

/** Versionskennung einer Bildfassung für Cache-Busting in URLs: Jede neue
 *  Fassung (Schwärzen/Drehen → PUT) bekommt einen neuen Zufalls-Dateinamen,
 *  die Bild-ID bleibt gleich. Ohne ?v= zeigten Listen dank Cache-Control bis
 *  zu einer Stunde die alte, ungeschwärzte Vorschau. */
export function imageVersion(filename: string): string {
  return String(filename || '').replace(/^bild-/, '').replace(/\..*$/, '').slice(0, 16)
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

/** Ersatzfassung (z.B. geschwärzt) schreiben: nur die nutzbare Datei unter neuem
 *  Namen, niemals eine `-original`-Datei – das aufbewahrte Original des
 *  Erst-Uploads bleibt unangetastet (Schwärzungen sollen es nicht vernichten). */
export async function writeReplacementImage(dir: string, p: PreparedImage): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const filename = `bild-${crypto.randomBytes(6).toString('hex')}.${p.ext}`
  await fs.writeFile(path.join(dir, filename), p.buffer)
  return filename
}

/** Gecachte Ableitungen einer Bilddatei entfernen: Vorschau-/Pixelbilder
 *  (services/pixelate.ts), Kennzeichen-Ausschnitt (services/plateAnalysis.ts),
 *  Mail-Variante. */
export async function removeDerivedFiles(dir: string, filename: string): Promise<void> {
  try {
    await fs.rm(path.join(dir, `${filename}.thumb.jpg`), { force: true })
    await fs.rm(path.join(dir, `${filename}.pixel.jpg`), { force: true })
    await fs.rm(path.join(dir, `${filename}.plate.jpg`), { force: true })
    await fs.rm(path.join(dir, `${filename}.mail.jpg`), { force: true })
  } catch {
    /* Dateien evtl. schon weg */
  }
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
    await removeDerivedFiles(dir, filename)
  } catch {
    /* Dateien evtl. schon weg */
  }
}
