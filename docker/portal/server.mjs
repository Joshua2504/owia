// Portal-Dienst: führt Formular-Läufe in einem Headless-Chromium aus und
// stellt sie der App zur Verfügung (nur internes Docker-Netz, kein Port nach
// außen). Ein Lauf füllt das Formular bis zur Zusammenfassung, wartet dann auf
// „Absenden" (POST /runs/:id/submit) und liefert Vorgangs-ID + Zusammenfassung.
//
// Live-Ansicht: Chromium streamt per CDP-Screencast JPEG-Frames; die App holt
// sie als H.264-Video (GET /runs/:id/video), MJPEG (…/stream) bzw. als
// Einzelbild (…/frame). Klicks/Tastatur aus der
// Live-Ansicht kommen über POST /runs/:id/input zurück – damit kann der Nutzer
// eingreifen, wenn der Lauf pausiert (state 'needs_input').
//
// Zustände: starting → filling ⇄ needs_input → ready → submitting → done
//           (jederzeit vor 'submitting': cancelled; Fehler: failed)
// Läufe leben nur im Speicher. Ein Neustart verliert sie – die App erkennt das
// (404) und behandelt einen Lauf, der schon 'submitting' war, als unklar.

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { fillSteps, submitForm, readSummary, Cancelled } from './lib.mjs'
import { PROFILE as EKOM21 } from './ekom21.mjs'
import { PROFILE as MAINZ } from './mainz.mjs'

// Formular-Profile je Stadt; payload.portal wählt (Standard: Frankfurt).
const PROFILE = { ...EKOM21, ...MAINZ }

const PORT = 8080
const VIEWPORT = { width: 1100, height: 860 }
const IDLE_LIMIT_MS = 40 * 60 * 1000 // ekom21 beendet Sitzungen nach 60 min Inaktivität
const KEEP_FINISHED_MS = 6 * 60 * 60 * 1000
// Immer nur eine Anzeige gleichzeitig (Nutzervorgabe); weitere Starts
// bekommen 429, die App reiht sie als Job ein (portalDispatch.ts).
const MAX_ACTIVE = 1

const runs = new Map()
let browser = null
// Ab SIGTERM antwortet der Dienst nur noch 503: Die Läufe sterben mit dem
// Chromium und melden dabei 'failed' – das darf die App nicht als echten
// Formularfehler lesen. Sie sieht erst 503, dann (neuer Prozess) 404 und
// startet den Versand von vorn.
let shuttingDown = false

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] })
  }
  return browser
}

const ACTIVE = new Set(['starting', 'filling', 'needs_input', 'ready', 'submitting'])

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

function createRun(payload, files, dir) {
  const run = {
    id: crypto.randomUUID(),
    state: 'starting',
    message: '',
    step: null,
    log: [],
    frame: null,
    frameNo: 0,
    watchers: new Set(), // offene MJPEG-Streams (GET /runs/:id/stream)
    videos: new Set(), // offene H.264-Streams (GET /runs/:id/video)
    summary: null,
    result: null,
    error: null,
    submitted: false,
    pauses: 0, // Eingriffe des Nutzers – „ohne Rückfrage absenden" nur bei 0
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    payload,
    files,
    dir,
    artifacts: {},
    ctx: null,
    page: null,
    cancelled: false,
    waiter: null, // deferred für pause()/waitSubmit()
  }
  run.log = []
  run.logMsg = (msg) => {
    run.log.push({ t: new Date().toISOString(), msg })
    if (run.log.length > 300) run.log.shift()
    run.updatedAt = Date.now()
  }
  run.setState = (state, message = '') => {
    run.state = state
    run.message = message
    run.updatedAt = Date.now()
  }
  // Engine-API
  run.engine = {
    get page() { return run.page },
    get ctx() { return run.ctx },
    payload,
    files,
    log: run.logMsg,
    setStep: (s) => { run.step = s },
    check: () => { if (run.cancelled) throw new Cancelled('Abgebrochen.') },
    pause: async (message) => {
      run.engine.check()
      run.pauses++
      run.setState('needs_input', message)
      run.logMsg(`Wartet auf Eingabe: ${message}`)
      run.waiter = deferred()
      const what = await run.waiter.promise
      run.waiter = null
      if (what === 'cancel') throw new Cancelled('Abgebrochen.')
      run.setState('filling')
      run.logMsg('Fortgesetzt')
    },
  }
  runs.set(run.id, run)
  return run
}

const BOUNDARY = 'owiaframe'
function writePart(res, buf) {
  res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`)
  res.write(buf)
  res.write('\r\n')
}
// Neues Bild an alle offenen Streams, höchstens ~15/s je Zuschauer (der
// Screencast liefert bis zu 50/s). Ein zurückgehaltenes Bild wird nachgereicht,
// damit das letzte immer ankommt. Hängt ein Zuschauer hinterher (Puffer voll),
// wird übersprungen statt gestaut.
const STREAM_MIN_MS = 66
function sendTo(run, w) {
  w.timer = null
  if (!run.frame || w.res.writableNeedDrain) return
  w.last = Date.now()
  writePart(w.res, run.frame)
}
function pushFrame(run) {
  for (const w of run.watchers) {
    if (w.timer) continue
    const wait = w.last + STREAM_MIN_MS - Date.now()
    if (wait <= 0) sendTo(run, w)
    else w.timer = setTimeout(() => sendTo(run, w), wait)
  }
}
// Live-Video: je Zuschauer ein ffmpeg, das das jeweils neueste Screencast-Bild
// mit festen 25 fps zu H.264 kodiert (fragmentiertes MP4, im Browser per
// MediaSource abgespielt). Ein fast stehendes Formular kostet so nur wenige
// kbit/s; Bewegung bleibt flüssig. Ein eigener Encoder je Zuschauer, damit jeder
// mit Init-Segment und Keyframe beginnt (es schauen höchstens 1–2 zu).
const VIDEO_FPS = 25
function startVideo(run, req, res) {
  const ff = spawn('ffmpeg', [
    '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(VIDEO_FPS), '-i', 'pipe:0',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '4.0',
    '-crf', '26', '-maxrate', '1500k', '-bufsize', '750k', '-g', String(VIDEO_FPS * 2), '-threads', '2',
    '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '40000', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'inherit'] })
  const v = { ff, timer: null }
  const stop = () => {
    clearInterval(v.timer)
    run.videos.delete(v)
    ff.stdin.destroy()
    ff.kill('SIGKILL')
  }
  v.stop = stop
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
  ff.stdout.pipe(res)
  ff.on('exit', () => { clearInterval(v.timer); run.videos.delete(v); res.end() })
  ff.stdin.on('error', () => {})
  req.on('close', stop)
  v.timer = setInterval(() => {
    // Staut sich der Encoder, lieber ein Bild auslassen.
    if (run.frame && !ff.stdin.writableNeedDrain) ff.stdin.write(run.frame)
  }, 1000 / VIDEO_FPS)
  run.videos.add(v)
}

function endWatchers(run) {
  for (const v of run.videos) { clearInterval(v.timer); v.ff.stdin.end() }
  run.videos.clear()
  for (const w of run.watchers) {
    clearTimeout(w.timer)
    if (run.frame) writePart(w.res, run.frame)
    w.res.end()
  }
  run.watchers.clear()
}

async function startScreencast(run) {
  const { page } = run
  const setFrame = (buf) => {
    run.frame = buf
    run.frameNo++
    pushFrame(run)
  }
  try {
    const cdp = await run.ctx.newCDPSession(page)
    cdp.on('Page.screencastFrame', (f) => {
      setFrame(Buffer.from(f.data, 'base64'))
      run.lastCast = Date.now()
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height })
  } catch {
    /* Fallback unten */
  }
  // Fallback/Ergänzung: liefert der Screencast nichts (headless shell), alle
  // 700 ms ein Screenshot.
  run.shotTimer = setInterval(async () => {
    if (run.lastCast && Date.now() - run.lastCast < 2000) return
    try {
      setFrame(await page.screenshot({ type: 'jpeg', quality: 65, timeout: 3000 }))
    } catch { /* Seite gerade beschäftigt */ }
  }, 700)
}

async function finish(run) {
  clearInterval(run.shotTimer)
  run.finishedAt = Date.now()
  try {
    if (run.page && !run.page.isClosed()) run.frame = await run.page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => run.frame)
    run.frameNo++
  } catch { /* egal */ }
  endWatchers(run)
  await run.ctx?.close().catch(() => {})
  run.ctx = null
  run.page = null
  await fs.rm(run.dir, { recursive: true, force: true }).catch(() => {})
}

async function execute(run) {
  try {
    const b = await getBrowser()
    run.ctx = await b.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: VIEWPORT, acceptDownloads: true })
    run.page = await run.ctx.newPage()
    run.page.on('dialog', (d) => { run.logMsg(`Dialog: ${d.message()}`); d.accept().catch(() => {}) })
    await startScreencast(run)
    run.setState('filling')
    const profile = PROFILE[run.payload.portal || 'ekom21-ffm']
    if (!profile) throw new Error(`Unbekanntes Portal „${run.payload.portal}".`)
    await fillSteps(run.engine, profile)

    run.summary = await readSummary(run.page)
    run.artifacts['summary.png'] = await run.page.screenshot({ type: 'png', fullPage: true }).catch(() => null)
    run.setState('ready', 'Formular ausgefüllt – bitte Zusammenfassung prüfen und absenden.')
    run.logMsg('Zusammenfassung erreicht – wartet auf „Absenden"')
    run.waiter = deferred()
    const what = await run.waiter.promise
    run.waiter = null
    if (what !== 'submit') throw new Cancelled('Abgebrochen.')

    run.setState('submitting', 'Wird abgesendet …')
    run.submitted = true
    const result = await submitForm(run.engine)
    run.artifacts['final.png'] = await run.page.screenshot({ type: 'png', fullPage: true }).catch(() => null)
    if (result.receipt) run.artifacts['receipt.pdf'] = result.receipt.buffer
    run.result = { vorgangsId: result.vorgangsId, text: result.text, hasReceipt: !!result.receipt }
    run.setState('done', result.vorgangsId ? `Abgesendet – Vorgangs-ID ${result.vorgangsId}` : 'Abgesendet.')
  } catch (err) {
    if (err instanceof Cancelled) {
      run.setState('cancelled', 'Abgebrochen – nichts wurde abgesendet.')
      run.logMsg('Abgebrochen')
    } else {
      run.error = err.message
      run.setState('failed', run.submitted ? `Fehler nach dem Absenden: ${err.message}` : `Fehler: ${err.message}`)
      run.logMsg(`Fehler: ${err.stack || err.message}`)
      if (run.page && !run.page.isClosed()) {
        run.artifacts['error.png'] = await run.page.screenshot({ type: 'png', fullPage: true }).catch(() => null)
      }
    }
  } finally {
    await finish(run)
  }
}

function publicRun(run) {
  return {
    id: run.id,
    state: run.state,
    message: run.message,
    step: run.step,
    submitted: run.submitted,
    pauses: run.pauses,
    frameNo: run.frameNo,
    log: run.log.slice(-80),
    summary: run.summary,
    result: run.result,
    error: run.error,
    artifacts: Object.keys(run.artifacts).filter((k) => run.artifacts[k]),
    createdAt: new Date(run.createdAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
  }
}

// Aufräumen: hängende Läufe abbrechen, alte vergessen.
setInterval(() => {
  const now = Date.now()
  for (const run of runs.values()) {
    if ((run.state === 'needs_input' || run.state === 'ready') && now - run.updatedAt > IDLE_LIMIT_MS) {
      run.cancelled = true
      run.logMsg('Zeitüberschreitung – Lauf wird abgebrochen')
      run.waiter?.resolve('cancel')
    }
    if (run.finishedAt && now - run.finishedAt > KEEP_FINISHED_MS) runs.delete(run.id)
  }
}, 30000).unref()

// ---------------------------------------------------------------------------
// HTTP

async function readBody(req, limit = 120 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('Anfrage zu groß'), { status: 413 })
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function portalErreichbar(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' })
    await r.arrayBuffer().catch(() => null)
    return r.status < 500
  } catch {
    return false
  }
}

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(data)
}

const ARTIFACT_TYPES = { 'summary.png': 'image/png', 'final.png': 'image/png', 'error.png': 'image/png', 'receipt.pdf': 'application/pdf' }

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean)

  if (shuttingDown) return send(res, 503, { error: 'Portal-Dienst wird beendet.' })
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, runs: runs.size })

  if (req.method === 'POST' && url.pathname === '/runs') {
    const active = [...runs.values()].filter((r) => ACTIVE.has(r.state)).length
    if (active >= MAX_ACTIVE) return send(res, 429, { error: 'Es läuft bereits ein Portal-Vorgang – bitte warten, bis er fertig ist.' })
    const body = await readBody(req)
    if (!body.payload) return send(res, 400, { error: 'payload fehlt' })
    // Idempotenz: Die App gibt eine eigene Lauf-ID mit. Kommt dieselbe ID noch
    // einmal (Antwort beim ersten Mal verloren, Timeout), liefern wir den
    // vorhandenen Lauf statt einen zweiten Chromium-Tab zu öffnen.
    if (typeof body.id === 'string' && /^[0-9a-f-]{36}$/.test(body.id) && runs.has(body.id)) {
      return send(res, 200, publicRun(runs.get(body.id)))
    }
    // Antwortet das Portal der Stadt gerade nicht (ekom21 hing am 08.10.2026
    // minutenlang), gar nicht erst starten – sonst hängt der Lauf womöglich
    // nach „Absenden" und das Ergebnis bleibt unklar.
    const startUrl = PROFILE[body.payload.portal || 'ekom21-ffm']?.startUrl
    if (startUrl && !(await portalErreichbar(startUrl))) {
      return send(res, 503, { error: 'Das Online-Portal der Stadt antwortet gerade nicht – neuer Versuch in einer Minute.' })
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-'))
    const files = { uebersicht: [], fahrzeug: [] }
    let i = 0
    for (const f of body.files || []) {
      const role = f.role === 'fahrzeug' ? 'fahrzeug' : 'uebersicht'
      const name = `${String(++i).padStart(2, '0')}-${String(f.name || 'foto.jpg').replace(/[^\w.\-äöüÄÖÜß]/g, '_')}`
      const p = path.join(dir, name)
      await fs.writeFile(p, Buffer.from(f.data, 'base64'))
      files[role].push(p)
    }
    const run = createRun(body.payload, files, dir)
    if (typeof body.id === 'string' && /^[0-9a-f-]{36}$/.test(body.id)) {
      runs.delete(run.id)
      run.id = body.id
      runs.set(run.id, run)
    }
    run.logMsg(`Lauf angelegt (${files.uebersicht.length} Übersichts-, ${files.fahrzeug.length} Fahrzeugfoto(s))`)
    execute(run)
    return send(res, 201, publicRun(run))
  }

  if (parts[0] !== 'runs' || !parts[1]) return send(res, 404, { error: 'unbekannt' })
  const run = runs.get(parts[1])
  if (!run) return send(res, 404, { error: 'Lauf unbekannt' })
  const action = parts[2] || ''

  if (req.method === 'GET' && action === '') return send(res, 200, publicRun(run))

  if (req.method === 'GET' && action === 'frame') {
    if (!run.frame) return send(res, 204, '')
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-No': String(run.frameNo) })
    return res.end(run.frame)
  }

  if (req.method === 'GET' && action === 'video') {
    if (run.finishedAt || !run.frame) return send(res, 204, '')
    return startVideo(run, req, res)
  }

  if (req.method === 'GET' && action === 'stream') {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    })
    if (run.frame) writePart(res, run.frame)
    if (run.finishedAt) return res.end()
    const w = { res, last: Date.now(), timer: null }
    run.watchers.add(w)
    req.on('close', () => { clearTimeout(w.timer); run.watchers.delete(w) })
    return
  }

  if (req.method === 'GET' && action === 'artifact') {
    const name = parts[3]
    const buf = run.artifacts[name]
    if (!buf || !ARTIFACT_TYPES[name]) return send(res, 404, { error: 'nicht vorhanden' })
    res.writeHead(200, { 'Content-Type': ARTIFACT_TYPES[name], 'Cache-Control': 'no-store' })
    return res.end(buf)
  }

  if (req.method === 'POST' && action === 'resume') {
    if (run.state !== 'needs_input') return send(res, 409, { error: 'Lauf wartet nicht auf Eingabe.' })
    run.waiter?.resolve('resume')
    return send(res, 200, publicRun(run))
  }

  if (req.method === 'POST' && action === 'submit') {
    if (run.state !== 'ready') return send(res, 409, { error: 'Lauf ist nicht bereit zum Absenden.' })
    run.waiter?.resolve('submit')
    return send(res, 200, publicRun(run))
  }

  if (req.method === 'POST' && action === 'cancel') {
    if (run.state === 'submitting') return send(res, 409, { error: 'Wird gerade abgesendet – Abbruch nicht mehr möglich.' })
    if (!ACTIVE.has(run.state)) return send(res, 200, publicRun(run))
    run.cancelled = true
    run.waiter?.resolve('cancel')
    return send(res, 200, publicRun(run))
  }

  if (req.method === 'POST' && action === 'input') {
    const page = run.page
    if (!page || run.state === 'submitting') return send(res, 409, { error: 'Keine Eingabe möglich.' })
    const b = await readBody(req, 64 * 1024)
    if (b.type === 'click') await page.mouse.click(Math.round(b.x * VIEWPORT.width), Math.round(b.y * VIEWPORT.height))
    else if (b.type === 'wheel') await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(b.dy) || 0)))
    else if (b.type === 'type') await page.keyboard.type(String(b.text || '').slice(0, 500))
    else if (b.type === 'key') await page.keyboard.press(String(b.key || ''))
    else return send(res, 400, { error: 'unbekannte Eingabe' })
    run.updatedAt = Date.now()
    return send(res, 200, { ok: true })
  }

  return send(res, 404, { error: 'unbekannt' })
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message })
      else res.end()
    })
  })
  .listen(PORT, () => console.log(`portal listening on ${PORT}`))

process.on('SIGTERM', async () => {
  shuttingDown = true
  await browser?.close().catch(() => {})
  process.exit(0)
})
