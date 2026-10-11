// Versand über ein Online-Portal (Frankfurt: ekom21) statt per Mail.
//
// Ablauf: startPortalRun() sperrt die Anzeige (versand_status='vorbereitung',
// wie reportDispatch.ts), baut die Daten (services/portalFfm.ts) und startet im
// Portal-Container (docker/portal) einen Lauf, der das Formular bis zur
// Zusammenfassung ausfüllt. Die Live-Seite (/versand, routes/portal.ts) zeigt
// das Browserbild; abgeschickt wird erst mit submitPortalRun() – vorher wird
// versand_status='versand' gesetzt. Ein Watcher pollt den Lauf und schließt ab:
//   done                       → status='versendet', versand_art='portal',
//                                Vorgangs-ID + Beleg in report_replies
//   abgebrochen/Fehler vor Absenden → Sperre lösen (bleibt 'eingereicht')
//   Lauf verloren vor Absenden (Neustart/Deploy des Portal-Dienstes oder der
//   App mitten im Start) → Sperre lösen und komplett neu starten (Job
//                                portal.start, Formular von vorn)
//   Fehler nach Absenden / Lauf verloren nach Absenden
//                              → bleibt 'versand' = unklar, Mensch prüft
//                                (resolveUncertain, Knöpfe auf /versand)
//   Lauf meldet submitted (z. B. im Live-Bild selbst abgesendet, vom Dienst
//   erkannt) → sofort 'versand', nie freigeben oder neu starten
// Automatische Starts (Job portal.start) brauchen die Freigabe-Marke der
// Anzeige (reports.freigabe_token, services/reportDispatch.ts).
// versand_ergebnis enthält {"portal":{runId,…}}; darüber nimmt resumeWatchers()
// nach einem App-Neustart laufende Läufe wieder auf.

import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import mysql from 'mysql2/promise'
import type { FastifyBaseLogger } from 'fastify'
import { pool } from '../db/connection'
import { reportDir } from './drafts'
import { ensureMailVariant } from '../routes/reports'
import { cachedMailVariant } from './pixelate'
import { PortalDatenFehler } from './portalFfm'
import { portalFuer, erstMorgen } from './portale'
import { repliesDir } from './mailInbox'
import { getCity } from '../config/cities'
import { isProfileComplete, drittProblem } from '../routes/reports'
import { isVerjaehrt } from './verjaehrung'
import { prewarmPublicImages } from './publicImages'
import { versandBestaetigungEinreihen } from './versandBestaetigung'
import { enqueueJob, registerJob, JobRetryLater } from './jobs'
import { versandPlatzBelegen, versandPlatzFreigeben } from './versandTakt'
import { loadUser } from './users'
import { freigabeErteilen } from './reportDispatch'

export const PORTAL_URL = (process.env.PORTAL_URL || 'http://portal:8080').replace(/\/$/, '')

export class PortalError extends Error {}
/** Portal-Dienst ist belegt (immer nur ein Lauf gleichzeitig, MAX_ACTIVE in
 *  docker/portal/server.mjs). */
export class PortalBusyError extends PortalError {}
/** Portal-Dienst nicht erreichbar (z. B. startet nach einem Deploy noch). */
export class PortalUnerreichbarError extends PortalError {}
/** Tat von heute, das Portal nimmt sie erst ab morgen an. */
export class PortalAbMorgenError extends PortalError {}
/** Die Freigabe des Jobs gilt nicht mehr (Anzeige seitdem zurückgezogen,
 *  abgelehnt oder neu eingereicht). */
export class PortalFreigabeVeraltetError extends PortalError {}

export interface PortalRunStatus {
  id: string
  state: 'starting' | 'filling' | 'needs_input' | 'ready' | 'submitting' | 'done' | 'failed' | 'cancelled'
  message: string
  step: { n: number; title: string } | null
  submitted: boolean
  pauses?: number
  frameNo: number
  log: { t: string; msg: string }[]
  summary: string | null
  result: { vorgangsId: string | null; text: string; hasReceipt: boolean } | null
  error: string | null
  artifacts: string[]
}

let log: FastifyBaseLogger | null = null
// Beides je Lauf (runId), nicht je Anzeige: Startet eine Anzeige neu, während
// der Watcher des alten Laufs noch ausläuft, darf dessen finally weder den
// neuen Watcher blockieren noch dessen „ohne Rückfrage absenden" löschen.
const watching = new Set<string>()
/** Läufe, die nach dem Ausfüllen sofort abgeschickt werden sollen. */
const autoSubmit = new Set<string>()
/** Letzter Status je Anzeige (auch nach Ende, für die Live-Seite). */
const lastStatus = new Map<number, PortalRunStatus & { reportId: number; finishedNote?: string }>()

async function portalFetch(p: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000)
  try {
    return await fetch(PORTAL_URL + p, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

export async function portalHealthy(): Promise<boolean> {
  try {
    return (await portalFetch('/health', { timeoutMs: 3000 })).ok
  } catch {
    return false
  }
}

export function usesPortal(report: Record<string, any>): boolean {
  return !!getCity(report.city).portal
}

function portalInfo(
  report: mysql.RowDataPacket
): { runId?: string; pendingRunId?: string; error?: string; submittedAt?: string; auto?: boolean } | null {
  try {
    const j = JSON.parse(report.versand_ergebnis || 'null')
    return j && j.portal ? j.portal : null
  } catch {
    return null
  }
}

async function loadReport(reportId: number): Promise<mysql.RowDataPacket | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM reports WHERE id=?', [reportId])
  return rows[0] ?? null
}

/** Läuft für die Anzeige ein Portal-Lauf? (Run-ID aus versand_ergebnis) */
export async function currentRunId(reportId: number): Promise<string | null> {
  const r = await loadReport(reportId)
  return r ? portalInfo(r)?.runId ?? null : null
}

/** Schnelle Vorab-Prüfungen (nur DB) vor einem Lauf. Wirft PortalError bzw.
 *  PortalAbMorgenError. */
async function checkStartbar(report: mysql.RowDataPacket): Promise<void> {
  if (report.status !== 'eingereicht') throw new PortalError('Die Anzeige ist nicht (mehr) zum Versand eingereicht.')
  const adapter = portalFuer(report.city)
  if (!adapter) throw new PortalError('Für diese Stadt gibt es keinen Portal-Versand.')
  if (!(await isProfileComplete(report.user_id))) throw new PortalError('Das Nutzerprofil ist unvollständig.')
  if (isVerjaehrt(report)) throw new PortalError('Die Tat ist verjährt.')
  if (!adapter.versendbar(report.verstoss_art)) throw new PortalError('Diesen Tatbestand bietet das Portal der Stadt nicht an.')
  const fehlt = adapter.problem(report, (await loadUser(report.user_id)) ?? null)
  if (fehlt) throw new PortalError(fehlt)
  if (erstMorgen(adapter, report)) throw new PortalAbMorgenError('Das Portal nimmt nur Taten vor dem heutigen Tag an – bitte ab morgen senden.')
}

/** Formular-Lauf starten. Wirft PortalError mit deutscher Meldung.
 *  freigabe: Marke der Admin-Freigabe (Job portal.start) – der Claim gelingt nur,
 *  solange die Anzeige sie noch trägt. Ohne (Klick auf /versand: der Admin sieht
 *  die Anzeige dort selbst) wird nur sichergestellt, dass die Anzeige eine Marke
 *  hat, damit ein Neustart des Laufs (restartFromScratch) sie mitnehmen kann. */
export async function startPortalRun(reportId: number, opts: { auto?: boolean; freigabe?: string | null } = {}): Promise<string> {
  const report = await loadReport(reportId)
  if (!report) throw new PortalError('Anzeige nicht gefunden.')
  await checkStartbar(report)
  const adapter = portalFuer(report.city)!

  // Lauf-ID selbst vergeben (Idempotenz im Portal-Dienst) und schon mit dem
  // Claim speichern: Geht die Antwort auf POST /runs verloren (Timeout,
  // Netzfehler) oder stirbt die App mittendrin, wäre im Dienst sonst ein
  // Chromium-Lauf gestartet, von dem die App nichts weiß – er belegte bis zum
  // 40-Minuten-Idle-Limit den einzigen Platz. Fehlerbehandlung bzw.
  // resumeWatchers() können ihn so gezielt abbrechen.
  let clientRunId: string | null = crypto.randomUUID()
  const startInfo = { pendingRunId: clientRunId, startedAt: new Date().toISOString(), ...(opts.auto ? { auto: true } : {}) }
  const freigabe = opts.freigabe ?? null
  const [claim] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE reports SET versand_status='vorbereitung', versand_ergebnis=?, freigabe_token=IFNULL(freigabe_token, ?)
      WHERE id=? AND status='eingereicht' AND versand_status IS NULL AND (? IS NULL OR freigabe_token=?)`,
    [JSON.stringify({ portal: startInfo }), crypto.randomUUID(), reportId, freigabe, freigabe]
  )
  if (!claim.affectedRows) {
    const r = freigabe ? await loadReport(reportId) : null
    if (r && !r.versand_status && r.freigabe_token !== freigabe) {
      throw new PortalFreigabeVeraltetError('Die Freigabe ist veraltet – die Anzeige wurde seitdem zurückgezogen oder neu eingereicht.')
    }
    throw new PortalError('Die Anzeige wird bereits versendet.')
  }

  try {
    const user = (await loadUser(report.user_id))!
    const [zeiten] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT DATE_FORMAT(MAX(captured_at), '%Y-%m-%d %H:%i') AS bis FROM report_images WHERE report_id=?",
      [reportId]
    )
    const payload = adapter.payload(report, user, zeiten[0]?.bis ?? null)
    const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, mimetype, detected_plate, analyse_json FROM report_images WHERE report_id=? ORDER BY sort_order, id',
      [reportId]
    )
    if (!imgs.length) throw new PortalError('Die Anzeige hat keine Fotos.')
    const dritte = await drittProblem(report)
    if (dritte) throw new PortalError(dritte)
    const roles = adapter.fotos(imgs)
    const dir = reportDir(report.user_id, reportId)
    const files: { role: string; name: string; data: string }[] = []
    for (const role of ['uebersicht', 'fahrzeug'] as const) {
      for (const img of roles[role]) {
        // Versandfassung (≤ 2200 px, JPEG): das Portal nimmt höchstens 10 MB je Datei.
        await ensureMailVariant(dir, img.filename, img.mimetype)
        const { buffer } = await cachedMailVariant(dir, img.filename, img.mimetype)
        files.push({ role, name: `${report.aktenzeichen}-${role}-${img.id}.jpg`, data: buffer.toString('base64') })
      }
    }
    const res = await portalFetch('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: clientRunId, payload, files }),
      timeoutMs: 60000,
    })
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string }
    if (res.status === 429) throw new PortalBusyError(body.error || 'Es läuft bereits ein Portal-Vorgang.')
    if (res.status === 503) throw new PortalUnerreichbarError(body.error || 'Der Portal-Dienst startet gerade neu.')
    if (!res.ok || !body.id) throw new PortalError(body.error || `Portal-Dienst antwortet nicht (HTTP ${res.status}).`)
    clientRunId = null
    await pool.execute('UPDATE reports SET versand_ergebnis=? WHERE id=?', [
      JSON.stringify({ portal: { runId: body.id, startedAt: startInfo.startedAt, ...(opts.auto ? { auto: true } : {}) } }),
      reportId,
    ])
    if (opts.auto) autoSubmit.add(body.id)
    watch(reportId, body.id)
    return body.id
  } catch (err) {
    await pool.execute(
      "UPDATE reports SET versand_status=NULL, versand_ergebnis=NULL WHERE id=? AND versand_status='vorbereitung'",
      [reportId]
    )
    // Evtl. doch gestarteten Lauf (Antwort verloren) im Dienst abbrechen.
    if (clientRunId) void proxy(clientRunId, '/cancel', { method: 'POST' }).catch(() => null)
    if (err instanceof PortalError) throw err
    if (err instanceof PortalDatenFehler) throw new PortalError(err.message)
    log?.error({ err, reportId }, 'Portal-Lauf konnte nicht gestartet werden')
    if (err instanceof Error && /fetch failed|abort/i.test(err.message)) {
      throw new PortalUnerreichbarError('Der Portal-Dienst ist nicht erreichbar (Container „portal" läuft?).')
    }
    throw new PortalError('Portal-Lauf konnte nicht gestartet werden.')
  }
}

/** Status eines Laufs vom Portal-Dienst (null = unbekannt, z.B. nach dessen Neustart). */
export async function runStatus(runId: string): Promise<PortalRunStatus | null> {
  const res = await portalFetch(`/runs/${encodeURIComponent(runId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Portal-Dienst HTTP ${res.status}`)
  return (await res.json()) as PortalRunStatus
}

/** Letzter bekannter Status (auch nach Abschluss) für die Live-Seite. */
export function lastKnownStatus(reportId: number) {
  return lastStatus.get(reportId) ?? null
}

/** Durchreichen an den Portal-Dienst (Live-Bild, Eingaben, Fortsetzen, Abbrechen). */
export async function proxy(runId: string, sub: string, init: RequestInit = {}): Promise<Response> {
  return portalFetch(`/runs/${encodeURIComponent(runId)}${sub}`, init)
}

/** „Absenden": erst die Sperre auf 'versand' (ab hier ist ein Ergebnis unklar,
 *  falls etwas abbricht), dann den Klick auslösen. */
export async function submitPortalRun(reportId: number): Promise<void> {
  const report = await loadReport(reportId)
  const info = report && portalInfo(report)
  if (!report || !info?.runId) throw new PortalError('Kein laufender Portal-Vorgang.')
  const [upd] = await pool.execute<mysql.ResultSetHeader>(
    "UPDATE reports SET versand_status='versand', versand_ergebnis=? WHERE id=? AND versand_status='vorbereitung'",
    [JSON.stringify({ portal: { ...info, submittedAt: new Date().toISOString() } }), reportId]
  )
  if (!upd.affectedRows) throw new PortalError('Die Anzeige ist nicht im Versand-Schritt.')
  let res: Response
  try {
    res = await proxy(info.runId, '/submit', { method: 'POST' })
  } catch (err) {
    // Keine Verbindung zustande gekommen (Container läuft nicht / Name nicht
    // auflösbar): Die Anfrage hat den Dienst nie erreicht, ein Klick ist
    // ausgeschlossen – Sperre zurück auf 'vorbereitung' wie bei einer Absage.
    const code = String((err as { cause?: { code?: string } })?.cause?.code || '')
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code)) {
      await pool.execute("UPDATE reports SET versand_status='vorbereitung', versand_ergebnis=? WHERE id=? AND versand_status='versand'", [
        JSON.stringify({ portal: info }),
        reportId,
      ])
      throw new PortalError('Der Portal-Dienst ist nicht erreichbar – nichts abgesendet, bitte später erneut versuchen.')
    }
    // Timeout/Netzfehler: Die Anfrage kann den Dienst erreicht und den Klick
    // ausgelöst haben, nur die Antwort fehlt. Also bleibt 'versand' (unklar);
    // meldet der Lauf später 'done', bucht der Watcher normal ab.
    await markUncertain(reportId, { ...info, submittedAt: new Date().toISOString() }, 'Absenden ohne Antwort des Portal-Dienstes – Ergebnis unklar.')
    throw new PortalError('Der Portal-Dienst hat auf „Absenden" nicht geantwortet – Ergebnis unklar, bitte prüfen.')
  }
  if (!res.ok) {
    // Echte Absage des Dienstes (z. B. 409 „nicht bereit", 404 Lauf unbekannt):
    // Der Klick ist nachweislich nicht passiert – Sperre zurück auf 'vorbereitung'.
    await pool.execute("UPDATE reports SET versand_status='vorbereitung', versand_ergebnis=? WHERE id=? AND versand_status='versand'", [
      JSON.stringify({ portal: info }),
      reportId,
    ])
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new PortalError(body.error || 'Absenden nicht möglich.')
  }
}

export async function cancelPortalRun(reportId: number): Promise<void> {
  const report = await loadReport(reportId)
  const info = report && portalInfo(report)
  if (info?.runId) autoSubmit.delete(info.runId)
  if (!report || !info?.runId) return
  if (report.versand_status === 'versand') throw new PortalError('Wird gerade abgesendet – Abbruch nicht mehr möglich.')
  await proxy(info.runId, '/cancel', { method: 'POST' }).catch(() => null)
  // Der Watcher löst die Sperre, sobald der Lauf als abgebrochen gemeldet wird;
  // ist der Dienst weg, sofort.
  if (!(await runStatus(info.runId).catch(() => null))) await releaseClaim(reportId)
}

async function releaseClaim(reportId: number): Promise<void> {
  await pool.execute(
    "UPDATE reports SET versand_status=NULL, versand_ergebnis=NULL WHERE id=? AND versand_status='vorbereitung'",
    [reportId]
  )
}

/** Lauf ging vor dem Absenden verloren (Portal-Dienst oder App neu gestartet,
 *  z. B. beim Deploy): Ein halb ausgefülltes Formular lässt sich nicht
 *  fortsetzen (die Portal-Sitzung lebte im alten Chromium) – also Sperre lösen
 *  und den Versand komplett von vorn starten. Nach dem Absenden-Klick
 *  ('versand') nie: dort ist unklar, ob die Anzeige angekommen ist. */
async function restartFromScratch(reportId: number, auto: boolean, grund: string): Promise<void> {
  // Der Neustart übernimmt die Marke der Anzeige (startPortalRun sorgt dafür,
  // dass jeder Lauf eine hat; IFNULL nur für Claims aus der Zeit davor). Zieht
  // der Nutzer in der Lücke zurück, ist sie gelöscht und der Job versendet nichts.
  const [rel] = await pool.execute<mysql.ResultSetHeader>(
    "UPDATE reports SET versand_status=NULL, versand_ergebnis=NULL, freigabe_token=IFNULL(freigabe_token, ?) WHERE id=? AND versand_status='vorbereitung'",
    [crypto.randomUUID(), reportId]
  )
  if (!rel.affectedRows) return
  const freigabe = (await loadReport(reportId))?.freigabe_token ?? null
  // neustart: kein neuer Versand, sondern derselbe – nicht erneut takten.
  await enqueueJob('portal.start', { reportId, auto, neustart: true, freigabe }, { key: `portal.start:${reportId}`, maxAttempts: 3 })
  log?.warn({ reportId, grund }, 'Portal-Lauf verloren – Versand startet neu')
}

/** Ergebnis unklar markieren. Greift auch aus 'vorbereitung', wenn der Lauf
 *  selbst meldet, dass abgesendet wurde (submitted/submitting – z. B. im
 *  Live-Bild geklickt): dann muss die Sperre auf 'versand', sonst gäbe ein
 *  Abbruch die Anzeige zum zweiten Versand frei. */
async function markUncertain(reportId: number, info: Record<string, unknown>, error: string | null, ausVorbereitung = false): Promise<void> {
  await pool.execute(
    `UPDATE reports SET versand_status='versand', versand_ergebnis=?
      WHERE id=? AND versand_status IN ('versand'${ausVorbereitung ? ", 'vorbereitung'" : ''})`,
    [JSON.stringify({ portal: { ...info, ...(error ? { error } : {}) } }), reportId]
  )
}

/** Erfolgreichen Lauf abschließen: Beleg sichern, Anzeige als versendet buchen. */
async function finishRun(reportId: number, runId: string, st: PortalRunStatus): Promise<void> {
  const report = await loadReport(reportId)
  if (!report || report.status === 'versendet') return
  const vorgangsId = st.result?.vorgangsId ?? null
  const files: { name: string; artifact: string; type: string }[] = []
  if (st.artifacts.includes('receipt.pdf')) files.push({ name: `${report.aktenzeichen}-Portal-Zusammenfassung.pdf`, artifact: 'receipt.pdf', type: 'application/pdf' })
  if (st.artifacts.includes('final.png')) files.push({ name: `${report.aktenzeichen}-Portal-Abschluss.png`, artifact: 'final.png', type: 'image/png' })
  if (st.artifacts.includes('summary.png')) files.push({ name: `${report.aktenzeichen}-Portal-Angaben.png`, artifact: 'summary.png', type: 'image/png' })
  const buffers: { name: string; type: string; buf: Buffer }[] = []
  for (const f of files) {
    try {
      const res = await proxy(runId, `/artifact/${f.artifact}`)
      if (res.ok) buffers.push({ name: f.name, type: f.type, buf: Buffer.from(await res.arrayBuffer()) })
    } catch {
      /* Beleg fehlt dann – Versand ist trotzdem erfolgt */
    }
  }
  const city = getCity(report.city)
  const portalName = portalFuer(report.city)?.bezeichnung || 'Online-Portal'
  const subject = `Online-Anzeige ${report.aktenzeichen} über das Portal (${city.ordnungsamt})${vorgangsId ? ` – Vorgangs-ID ${vorgangsId}` : ''}`
  const text = [
    `Über das Online-Angebot der Stadt (${portalName}) abgesendet am ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}.`,
    vorgangsId ? `Vorgangs-ID: ${vorgangsId}` : 'Eine Vorgangs-ID wurde auf der Abschlussseite nicht erkannt (siehe Anhang).',
    '',
    '--- Abschlussseite ---',
    (st.result?.text || '').trim(),
    '',
    '--- Übermittelte Angaben ---',
    (st.summary || '').trim(),
  ].join('\n')

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute<mysql.RowDataPacket[]>('SELECT status FROM reports WHERE id=? FOR UPDATE', [reportId])
    if (rows[0]?.status === 'versendet') {
      await conn.commit()
      return
    }
    const messageId = `<portal-${crypto.randomUUID()}@owia.local>`
    const [ins] = await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO report_replies (report_id, direction, message_id, from_address, subject, body_text, received_at, read_at)
       VALUES (?, 'out', ?, NULL, ?, ?, NOW(), NOW())`,
      [reportId, messageId, subject.slice(0, 500), text]
    )
    const replyId = ins.insertId
    let beleg: string | null = null
    if (buffers.length) {
      await fs.mkdir(repliesDir(replyId), { recursive: true })
      for (const b of buffers) {
        const stored = `${crypto.randomBytes(6).toString('hex')}${path.extname(b.name)}`
        await fs.writeFile(path.join(repliesDir(replyId), stored), b.buf)
        await conn.execute(
          `INSERT INTO report_reply_attachments (reply_id, filename, original_filename, mimetype, size_bytes)
           VALUES (?, ?, ?, ?, ?)`,
          [replyId, stored, b.name, b.type, b.buf.length]
        )
        beleg ??= `${replyId}/${stored}`
      }
    }
    await conn.execute(
      `UPDATE reports SET status='versendet', versand_art='portal', sent_message_id=?, portal_vorgang_id=?, portal_beleg=?,
         versand_status=NULL, versand_ergebnis=NULL WHERE id=?`,
      [messageId, vorgangsId, beleg, reportId]
    )
    await conn.commit()
    void prewarmPublicImages(reportId)
    await versandBestaetigungEinreihen(reportId).catch(() => {})
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Lauf bis zum Ende beobachten und das Ergebnis in die DB übernehmen. */
function watch(reportId: number, runId: string): void {
  if (watching.has(runId)) return
  watching.add(runId)
  void (async () => {
    let misses = 0
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500))
        let st: PortalRunStatus | null
        try {
          st = await runStatus(runId)
          misses = 0
        } catch {
          // Dienst kurz weg: ein paar Minuten weiter versuchen.
          if (++misses < 120) continue
          st = null
        }
        const report = await loadReport(reportId)
        if (!report || !portalInfo(report) || portalInfo(report)?.runId !== runId) return // anderweitig erledigt
        if (!st) {
          // Lauf unbekannt (Portal-Dienst neu gestartet).
          if (report.versand_status === 'versand') {
            await markUncertain(reportId, portalInfo(report)!, 'Portal-Dienst nach dem Absenden neu gestartet – Ergebnis unklar.')
            lastStatus.set(reportId, { ...(lastStatus.get(reportId) as PortalRunStatus), reportId, state: 'failed', message: 'Lauf ging nach dem Absenden verloren – Ergebnis unklar.' })
          } else {
            await restartFromScratch(reportId, !!portalInfo(report)?.auto, 'Portal-Dienst neu gestartet')
            lastStatus.set(reportId, { ...(lastStatus.get(reportId) as PortalRunStatus), reportId, state: 'failed', message: 'Lauf ging verloren (Portal-Dienst neu gestartet) – startet von vorn.' })
          }
          return
        }
        lastStatus.set(reportId, { ...st, reportId })
        // Der Lauf meldet „abgesendet", die DB steht noch auf 'vorbereitung'
        // (im Live-Bild selbst geklickt, vom Dienst erkannt): sofort sperren.
        if ((st.submitted || st.state === 'submitting') && report.versand_status === 'vorbereitung') {
          await markUncertain(reportId, { ...portalInfo(report)!, submittedAt: new Date().toISOString() }, null, true)
          report.versand_status = 'versand'
          log?.warn({ reportId, runId }, 'Portal-Lauf meldet abgesendet ohne „Jetzt absenden" – Sperre auf versand')
        }
        // „Ohne Rückfrage absenden" nur, wenn der Lauf ohne einen einzigen
        // Eingriff durchkam – sonst wartet er wie gewohnt auf den Klick.
        if (st.state === 'ready' && autoSubmit.has(runId) && report.versand_status === 'vorbereitung') {
          autoSubmit.delete(runId)
          if ((st.pauses ?? 0) === 0) {
            await submitPortalRun(reportId).catch((err) => log?.error({ err, reportId }, 'Automatisches Absenden fehlgeschlagen'))
          }
        }
        if (st.state === 'done') {
          await finishRun(reportId, runId, st)
          log?.info({ reportId, vorgangsId: st.result?.vorgangsId }, 'Anzeige über das Portal versendet')
          return
        }
        if (st.state === 'cancelled' || st.state === 'failed') {
          if (st.submitted || report.versand_status === 'versand') {
            await markUncertain(reportId, portalInfo(report)!, st.error || st.message, st.submitted)
            log?.error({ reportId, error: st.error }, 'Portal-Versand: Fehler nach dem Absenden – Ergebnis unklar')
          } else {
            await releaseClaim(reportId)
          }
          return
        }
      }
    } catch (err) {
      log?.error({ err, reportId }, 'Portal-Watcher abgebrochen')
    } finally {
      watching.delete(runId)
      autoSubmit.delete(runId)
      // Der Portal-Dienst ist frei: wartende Starts nach Freigabe sofort versuchen.
      void pool.execute("UPDATE jobs SET run_after=NOW() WHERE type='portal.start' AND status='queued'").catch(() => undefined)
    }
  })()
}

/** Nach App-Neustart: offene Portal-Läufe wieder beobachten. Starb die App
 *  mitten im Start (Claim ohne bestätigte runId), wird ein evtl. doch
 *  angelegter Lauf abgebrochen und der Versand von vorn gestartet. */
export async function resumeWatchers(logger: FastifyBaseLogger): Promise<void> {
  log = logger
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM reports WHERE versand_status IN ('vorbereitung','versand') AND versand_ergebnis LIKE '%\"portal\"%'"
  )
  for (const r of rows) {
    const info = portalInfo(r)
    if (info?.runId && !info.error) {
      if (info.auto && r.versand_status === 'vorbereitung') autoSubmit.add(info.runId)
      watch(Number(r.id), info.runId)
    }
    else if (!info?.runId && r.versand_status === 'vorbereitung') {
      if (info?.pendingRunId) await proxy(info.pendingRunId, '/cancel', { method: 'POST' }).catch(() => null)
      await restartFromScratch(Number(r.id), !!info?.auto, 'App-Neustart während des Starts')
    }
  }
}

/** Unklaren Portal-Versand von Hand auflösen (nach Prüfung im Postfach/bei der Stadt). */
export async function resolveUncertain(reportId: number, outcome: 'gesendet' | 'nicht-gesendet', vorgangsId?: string): Promise<void> {
  const report = await loadReport(reportId)
  if (!report || report.versand_status !== 'versand' || !portalInfo(report)) throw new PortalError('Kein unklarer Portal-Versand.')
  if (outcome === 'nicht-gesendet') {
    await pool.execute("UPDATE reports SET versand_status=NULL, versand_ergebnis=NULL WHERE id=? AND versand_status='versand'", [reportId])
    // Steht der Lauf im Dienst noch (z. B. 'ready' nach einem Absenden ohne
    // Antwort), belegte er sonst bis zum Leerlauf-Limit den einzigen Platz.
    const runId = portalInfo(report)?.runId
    if (runId) await proxy(runId, '/cancel', { method: 'POST' }).catch(() => null)
    return
  }
  await finishRun(reportId, portalInfo(report)!.runId || '', {
    id: '', state: 'done', message: '', step: null, submitted: true, frameNo: 0, log: [], summary: 'Von Hand als versendet bestätigt.',
    result: { vorgangsId: (vorgangsId || '').trim().slice(0, 64) || null, text: '', hasReceipt: false }, error: null, artifacts: [],
  })
}

// Freigabe einer Portal-Anzeige (Admin: /admin/anzeigen „Freigeben", eigene
// Anzeige „Einreichen & versenden") startet den Lauf direkt im Hintergrund –
// ohne Klick auf /versand. Abgeschickt wird ohne Rückfrage nur, wenn der Lauf
// ohne Eingriff durchkommt; sonst wartet er auf /versand auf „Jetzt absenden".
// Es läuft immer nur ein Lauf gleichzeitig; ist der Dienst belegt, wartet der Job;
// Taten von heute (Frankfurt) starten kurz nach Mitternacht.

function sekundenBisMorgen(): number {
  const [h, m, s] = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour12: false }).split(':').map(Number)
  return 24 * 3600 - (h * 3600 + m * 60 + s) + 5 * 60
}

// Freigabe-Marke (services/reportDispatch.ts): Der Job startet nur, solange die
// Anzeige noch die Marke seiner Freigabe trägt. Jobs ohne Marke (vor Migration
// 0050 eingereiht und dort nicht der aktuellen Fassung zuzuordnen) starten nie –
// ob der Admin genau diesen Stand gesehen hat, ist nicht mehr belegbar.
registerJob('portal.start', async ({ reportId, auto, neustart, freigabe }, jobLog) => {
  const report = await loadReport(Number(reportId))
  // Inzwischen abgelehnt, von Hand auf /versand gestartet oder erledigt.
  if (!report || report.status !== 'eingereicht' || report.versand_status) return
  if (!freigabe || report.freigabe_token !== freigabe) {
    jobLog.warn({ reportId, mitMarke: !!freigabe }, 'Portal-Start verworfen – Freigabe gehört zu einem älteren Stand der Anzeige')
    return
  }
  // Höchstens eine Anzeige je eingestelltem Abstand (services/versandTakt.ts).
  const warten = neustart ? null : await versandPlatzBelegen()
  if (warten !== null) throw new JobRetryLater('Versand-Takt: nächster Versand frühestens in ' + Math.ceil(warten / 60) + ' min', warten)
  try {
    // auto fehlt bei Starts nach der Freigabe (= ohne Rückfrage absenden);
    // ein Neustart übernimmt die Einstellung des verlorenen Laufs.
    await startPortalRun(Number(reportId), { auto: auto !== false, freigabe: String(freigabe) })
  } catch (err) {
    if (!neustart) await versandPlatzFreigeben()
    if (err instanceof PortalFreigabeVeraltetError) {
      jobLog.warn({ reportId }, err.message)
      return
    }
    // Belegt oder (nach Deploy/Neustart) noch nicht wieder da: warten, kein Fehlversuch.
    if (err instanceof PortalBusyError || err instanceof PortalUnerreichbarError) throw new JobRetryLater(err.message, 60)
    if (err instanceof PortalAbMorgenError) throw new JobRetryLater(err.message, sekundenBisMorgen())
    throw err
  }
})

/** Nach der Freigabe: Portal-Lauf einreihen. Gibt einen Hinderungsgrund zurück
 *  (dann wird nichts gestartet) oder null; „ab morgen" wird eingereiht. */
export async function enqueuePortalStart(reportId: number): Promise<{ problem: string | null; abMorgen: boolean }> {
  const report = await loadReport(reportId)
  if (!report) return { problem: 'Anzeige nicht gefunden.', abMorgen: false }
  let abMorgen = false
  try {
    await checkStartbar(report)
  } catch (err) {
    if (err instanceof PortalAbMorgenError) abMorgen = true
    else if (err instanceof PortalError) return { problem: err.message, abMorgen: false }
    else throw err
  }
  // Marke an den jetzt geprüften Stand binden (verwirft ältere wartende Starts).
  const freigabe = await freigabeErteilen(reportId)
  if (!freigabe) return { problem: 'Die Anzeige wird bereits versendet oder wurde inzwischen geändert.', abMorgen: false }
  await enqueueJob('portal.start', { reportId, freigabe }, { key: `portal.start:${reportId}`, maxAttempts: 3 })
  return { problem: null, abMorgen }
}

/** Anzeigen, deren automatischer Start noch aussteht (für /versand). */
export async function wartendeStarts(): Promise<Set<number>> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT payload FROM jobs WHERE type='portal.start' AND status IN ('queued','running')"
  )
  return new Set(rows.map((r) => Number(JSON.parse(r.payload)?.reportId)))
}
