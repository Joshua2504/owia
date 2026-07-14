// Einmaliger Backfill: Vorschaubilder (.thumb.jpg) für alle bereits
// hochgeladenen Fotos erzeugen. Neue Uploads schreiben ihr Thumbnail direkt
// mit (writeThumbnailCache); dieses Skript versorgt den Bestand, damit die
// Übersichtsseiten nicht beim ersten Aufruf dutzende Vollbilder synchron
// dekodieren müssen. Aufruf: npx tsx src/scripts/backfill-thumbs.ts
import path from 'path'
import fs from 'fs/promises'
import { thumbnail, thumbFilename, readOrientation } from '../services/pixelate'

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')

// Von writePreparedImage vergebene Namen ("bild-<hex>.jpg|png"), ohne Originale.
const IMAGE_NAME = /^bild-[0-9a-f]{12}\.(jpg|png)$/

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(p, out)
    else if (IMAGE_NAME.test(entry.name)) out.push(p)
  }
  return out
}

async function main() {
  const files = await walk(UPLOAD_DIR)
  let created = 0
  let skipped = 0
  let failed = 0
  for (const file of files) {
    const thumbPath = path.join(path.dirname(file), thumbFilename(path.basename(file)))
    try {
      await fs.access(thumbPath)
      skipped++
      continue
    } catch {
      /* fehlt noch */
    }
    try {
      const buffer = await fs.readFile(file)
      const mimetype = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
      const orientation = await readOrientation(buffer)
      await fs.writeFile(thumbPath, thumbnail(buffer, mimetype, undefined, orientation))
      created++
    } catch (err) {
      failed++
      console.warn(`Fehlgeschlagen: ${file}`, err)
    }
  }
  console.log(`Thumbnails: ${created} erzeugt, ${skipped} vorhanden, ${failed} fehlgeschlagen`)
}

main()
