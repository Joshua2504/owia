// CPU-intensive Konvertierung und Vorschauberechnung laufen außerhalb des
// HTTP-Eventloops. Ein Worker bearbeitet bewusst nur ein Foto gleichzeitig.
import fs from 'node:fs/promises'
import path from 'node:path'
import { parentPort } from 'node:worker_threads'
import { prepareImage, writePreparedImage, writeReplacementImage } from './images'
import { extractPhotoMeta } from './exif'
import { writeThumbnailCache, writeMailVariantCache, cachedPixelate } from './pixelate'
import type { BildAnalyse } from './alpr'

parentPort!.on('message', async (job: { kind: 'prepare' | 'thumbnail' | 'derivatives' | 'prepare-path' | 'pixel' | 'replace'; buffer?: Uint8Array; rawPath?: string; filename: string; mimetype: string; dir: string; analyse?: BildAnalyse | null; nurKonvertiert?: boolean }) => {
  try {
    if (job.kind === 'pixel') {
      // Schreibt <datei>.pixel.jpg als Cache (öffentliche Karte, routes/public.ts).
      await cachedPixelate(job.dir, job.filename, job.mimetype, job.analyse ?? null)
      parentPort!.postMessage({ ok: true })
      return
    }
    if (job.kind === 'thumbnail' || job.kind === 'derivatives') {
      const buffer = await fs.readFile(path.join(job.dir, job.filename))
      await writeThumbnailCache(job.dir, job.filename, buffer, job.mimetype)
      // Versandfassung gleich mit vorberechnen: sonst dekodiert regeneratePdf()
      // beim Speichern jedes Foto synchron im HTTP-Prozess (bis zu 14 s gemessen).
      if (job.kind === 'derivatives') await writeMailVariantCache(job.dir, job.filename, buffer, job.mimetype)
      parentPort!.postMessage({ ok: true })
      return
    }
    const raw = job.rawPath && !job.buffer ? await fs.readFile(job.rawPath) : undefined
    const bytes = job.buffer || raw!
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (job.kind === 'replace') {
      // Ersatzfassung (intakeImageProcessing.ts processReplacementImage): nur die
      // nutzbare Datei schreiben, nie ein „-original“ (das bleibt der Erst-Upload).
      const prepared = await prepareImage(buffer, '', '')
      const filename = job.nurKonvertiert && !prepared.converted ? '' : await writeReplacementImage(job.dir, prepared)
      parentPort!.postMessage({ ok: true, result: { filename, mimetype: prepared.mimetype, converted: prepared.converted } })
      return
    }
    const meta = await extractPhotoMeta(buffer)
    const prepared = await prepareImage(buffer, job.filename, job.mimetype)
    const names = await writePreparedImage(job.dir, prepared)
    parentPort!.postMessage({ ok: true, result: { ...names, mimetype: prepared.mimetype, originalMimetype: prepared.originalMimetype, meta } })
  } catch {
    parentPort!.postMessage({ ok: false })
  }
})
