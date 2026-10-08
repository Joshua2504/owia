import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { cachedThumbnail, cachedPixelate, thumbFilename } from './pixelate'
import type { BildAnalyse } from './alpr'

export type IntakeImageResult = {
  filename: string
  originalFilename: string
  mimetype: string
  originalMimetype: string
  meta: { capturedAt: string | null; lat: number | null; lon: number | null }
}
type Job = {
  kind: 'prepare' | 'thumbnail' | 'derivatives' | 'prepare-path' | 'pixel'; buffer?: Buffer; rawPath?: string; filename: string; mimetype: string; dir: string
  analyse?: BildAnalyse | null
  resolve: (result: IntakeImageResult | undefined) => void; reject: (error: Error) => void
}
const jobs: Job[] = []
let worker: Worker | null = null
let active: Job | null = null

function startNext() {
  if (active || !jobs.length) return
  if (!worker) {
    // Die App führt TypeScript direkt aus. Derselbe lokale tsx-Loader gilt
    // auch im Worker (kein Build und keine zusätzliche Laufzeitabhängigkeit).
    // resourceLimits: ein einzelnes Riesenbild (PNG-Dekompressionsbombe) soll
    // den Worker killen, nicht den ganzen App-Prozess; der Worker wird dann
    // beim nächsten Job neu gestartet (failed() unten).
    const current = new Worker(`require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(path.join(__dirname, 'intakeImageWorker.ts'))});`, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 128 },
    })
    worker = current
    current.on('message', (message: { ok: boolean; result?: IntakeImageResult }) => {
      if (worker !== current || !active) return
      const job = active
      active = null
      current.unref()
      if (message.ok) job.resolve(message.result)
      else job.reject(new Error('Bild konnte nicht verarbeitet werden.'))
      startNext()
    })
    function failed() {
      if (worker !== current) return
      worker = null
      const job = active
      active = null
      job?.reject(new Error('Bildverarbeitung wurde unterbrochen. Bitte erneut versuchen.'))
      void current.terminate()
      startNext()
    }
    current.on('error', failed)
    current.on('exit', failed)
  }
  active = jobs.shift()!
  worker.ref()
  // Eigener übertragbarer Puffer: niemals einen Buffer-Pool oder andere
  // Originalbytes durch Detaching beschädigen. Nur begrenzt viele Jobs aktiv.
  const bytes = active.buffer ? Uint8Array.from(active.buffer) : undefined
  worker.postMessage({ kind: active.kind, buffer: bytes, rawPath: active.rawPath, filename: active.filename, mimetype: active.mimetype, dir: active.dir, analyse: active.analyse ?? null }, bytes ? [bytes.buffer] : [])
}

export function processIntakeImage(buffer: Buffer, filename: string, mimetype: string, dir: string): Promise<IntakeImageResult> {
  return new Promise<IntakeImageResult | undefined>((resolve, reject) => {
    jobs.push({ kind: 'prepare', buffer, filename, mimetype, dir, resolve, reject })
    startNext()
  }).then(result => {
    if (!result) throw new Error('Bild konnte nicht verarbeitet werden.')
    return result
  })
}

export function processIntakeRaw(rawPath: string, filename: string, mimetype: string, dir: string): Promise<IntakeImageResult> {
  return new Promise<IntakeImageResult | undefined>((resolve, reject) => {
    jobs.push({ kind: 'prepare-path', rawPath, filename, mimetype, dir, resolve, reject })
    startNext()
  }).then(result => {
    if (!result) throw new Error('Bild konnte nicht verarbeitet werden.')
    return result
  })
}

// Interaktive Aufgaben (Editor, Liste) laufen vor einem evtl. laufenden
// 150-Foto-Import, sonst wartet ein einzelnes Bild minutenlang in der Schlange.
function enqueue(job: Job, priority: boolean) {
  if (priority) jobs.unshift(job)
  else jobs.push(job)
  startNext()
}

/** Vorschaubild + Versandfassung eines gespeicherten Anzeigenfotos im Worker
 *  berechnen (beides als Datei-Cache neben dem Bild, s. pixelate.ts). */
export function processReportImageDerivatives(filename: string, mimetype: string, dir: string): Promise<void> {
  return new Promise<IntakeImageResult | undefined>((resolve, reject) => {
    enqueue({ kind: 'derivatives', filename, mimetype, dir, resolve, reject }, true)
  }).then(() => {})
}

/** Bild für den Upload in eine Anzeige vorbereiten (HEIC→JPG, EXIF, Dateien
 *  schreiben) – wie processIntakeImage, aber vorrangig in der Warteschlange. */
export function processReportImage(buffer: Buffer, filename: string, mimetype: string, dir: string): Promise<IntakeImageResult> {
  return new Promise<IntakeImageResult | undefined>((resolve, reject) => {
    enqueue({ kind: 'prepare', buffer, filename, mimetype, dir, resolve, reject }, true)
  }).then(result => {
    if (!result) throw new Error('Bild konnte nicht verarbeitet werden.')
    return result
  })
}

/** Öffentliches Pixelbild (Karte) im Worker berechnen – nicht vorrangig, die
 *  Karte ist nicht interaktiv-kritisch, ein Nutzer-Upload schon. */
export function processPixelNow(filename: string, mimetype: string, dir: string, analyse: BildAnalyse | null): Promise<void> {
  return new Promise<IntakeImageResult | undefined>((resolve, reject) => {
    enqueue({ kind: 'pixel', filename, mimetype, dir, analyse, resolve, reject }, false)
  }).then(() => {})
}

/** Pixelbild ausliefern; fehlt der Cache, zuerst im Worker berechnen (wie
 *  loadThumbnail). cachedPixelate liest danach nur noch die Datei. */
export async function loadPixelated(dir: string, filename: string, mimetype: string, analyse: BildAnalyse | null): Promise<Buffer> {
  try {
    await fs.access(path.join(dir, `${filename}.pixel.jpg`))
  } catch {
    await processPixelNow(filename, mimetype, dir, analyse)
  }
  return cachedPixelate(dir, filename, mimetype, analyse)
}

/** Fehlendes Vorschaubild vorrangig nachrechnen (On-demand-Fallback der Listen). */
export function processThumbnailNow(filename: string, mimetype: string, dir: string): Promise<void> {
  return new Promise<IntakeImageResult | undefined>((resolve, reject) => {
    enqueue({ kind: 'thumbnail', filename, mimetype, dir, resolve, reject }, true)
  }).then(() => {})
}

/** Vorschaubild ausliefern; fehlt der Cache, zuerst im Worker berechnen statt
 *  synchron im Request (cachedThumbnail fiele sonst auf jpeg-js im Eventloop
 *  zurück und hielte bei einer Liste voller neuer Fotos alle Requests auf). */
export async function loadThumbnail(dir: string, filename: string, mimetype: string) {
  try {
    await fs.access(path.join(dir, thumbFilename(filename)))
  } catch {
    await processThumbnailNow(filename, mimetype, dir).catch(() => {})
  }
  return cachedThumbnail(dir, filename, mimetype)
}

// Erst nach dem Upload erzeugen. Die Warteschlange enthält nur Dateipfade,
// niemals die Originalbytes aller 150 Fotos gleichzeitig im Arbeitsspeicher.
export function processIntakeThumbnail(filename: string, mimetype: string, dir: string): Promise<void> {
  return new Promise<IntakeImageResult | undefined>((resolve, reject) => {
    jobs.push({ kind: 'thumbnail', filename, mimetype, dir, resolve, reject })
    startNext()
  }).then(() => {})
}

// Überlappende Uploads desselben Nutzers dürfen dieselben Bytes nicht zweimal
// zwischen Duplikatprüfung und INSERT speichern. Die App läuft als ein Prozess.
const userUploads = new Map<number, Promise<void>>()
export async function withIntakeUploadLock<T>(userId: number, task: () => Promise<T>): Promise<T> {
  const previous = userUploads.get(userId) || Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  userUploads.set(userId, next)
  await previous
  try { return await task() }
  finally {
    release()
    if (userUploads.get(userId) === next) userUploads.delete(userId)
  }
}
