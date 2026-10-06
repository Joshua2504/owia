import path from 'node:path'
import { Worker } from 'node:worker_threads'

export type IntakeImageResult = {
  filename: string
  originalFilename: string
  mimetype: string
  originalMimetype: string
  meta: { capturedAt: string | null; lat: number | null; lon: number | null }
}
type Job = {
  kind: 'prepare' | 'thumbnail' | 'prepare-path'; buffer?: Buffer; rawPath?: string; filename: string; mimetype: string; dir: string
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
    const current = new Worker(`require(${JSON.stringify(require.resolve('tsx/cjs'))}); require(${JSON.stringify(path.join(__dirname, 'intakeImageWorker.ts'))});`, { eval: true })
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
  worker.postMessage({ kind: active.kind, buffer: bytes, rawPath: active.rawPath, filename: active.filename, mimetype: active.mimetype, dir: active.dir }, bytes ? [bytes.buffer] : [])
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
