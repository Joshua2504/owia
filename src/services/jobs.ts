import crypto from 'crypto'
import mysql from 'mysql2/promise'
import type { FastifyBaseLogger } from 'fastify'
import { pool } from '../db/connection'

// Hintergrund-Jobs: alles, worauf der Nutzer nicht warten soll (Foto-Import
// gruppieren, PDF erzeugen, Mails, Versand ans Ordnungsamt), wird als Zeile in
// `jobs` (Migration 0038) abgelegt und hier abgearbeitet. Die Tabelle überlebt
// Neustarts; was beim Neustart lief, wird erneut eingereiht – Handler müssen
// daher wiederholbar sein (bzw. sich selbst gegen Doppelarbeit absichern, wie
// dispatchReport über versand_status).
//
// Nur eine App-Instanz pro DB: Claim per UPDATE … WHERE status='queued'.

export type JobHandler = (payload: any, log: FastifyBaseLogger) => Promise<void>

const handlers = new Map<string, JobHandler>()
const CONCURRENCY = 3
const POLL_MS = 5000
/** Zeitlimit je Job: ein hängender Handler (SMTP ohne Socket-Timeout, Photon
 *  ohne Antwort) soll nicht dauerhaft einen der CONCURRENCY-Plätze belegen.
 *  Nach Ablauf gilt der Versuch als gescheitert; der Handler selbst läuft im
 *  Hintergrund weiter. Gegen doppelte Ausführung (z. B. dieselbe Mail zweimal):
 *  Jeder Claim bekommt eine Lauf-Kennung (jobs.lauf_id, Migration 0050) – nur
 *  der Lauf, dessen Kennung noch passt, schreibt das Ergebnis. Der neue Versuch
 *  wartet mindestens ein weiteres Zeitlimit; endet der alte Handler bis dahin
 *  doch erfolgreich, gilt der Job als erledigt und der Versuch entfällt. Erst
 *  wenn er auch dann noch hängt, läuft der Job ein zweites Mal. */
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 10 * 60 * 1000)
/** Ein 'running'-Job, der länger als das ist, stammt aus einem früheren
 *  Prozess (Absturz ohne sauberes Requeue) und wird neu eingereiht. */
const STALE_RUNNING_MS = 2 * JOB_TIMEOUT_MS
let lastTickAt: Date | null = null

let log: FastifyBaseLogger | null = null
let running = 0
let ticking = false

/** Vom Handler geworfen, wenn er nur warten muss (z. B. Portal-Dienst voll
 *  belegt): kein Fehlversuch, der Job läuft nach `seconds` erneut. */
export class JobRetryLater extends Error {
  constructor(message: string, public seconds: number) {
    super(message)
  }
}

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler)
}

/** Job einreihen. Mit `key`: existiert bereits ein wartender Job mit diesem
 *  Schlüssel, wird kein zweiter angelegt (läuft er schon, kommt ein neuer dazu –
 *  der sieht dann den neuesten Stand). */
export async function enqueueJob(
  type: string,
  payload: unknown,
  opts: { key?: string; maxAttempts?: number } = {}
): Promise<void> {
  // Kein INSERT IGNORE: das verschluckte neben dem gewollten Schlüssel-Duplikat
  // auch echte Fehler (z.B. abgeschnittenes Payload) – der Job fehlte dann
  // stillschweigend. ER_DUP_ENTRY ist der einzige erwartete Fall.
  try {
    await pool.execute(
      'INSERT INTO jobs (type, payload, pending_key, max_attempts) VALUES (?, ?, ?, ?)',
      [type, JSON.stringify(payload ?? null), opts.key ?? null, opts.maxAttempts ?? 3]
    )
  } catch (err) {
    if ((err as { code?: string })?.code !== 'ER_DUP_ENTRY') throw err
  }
  setImmediate(() => void tick())
}

/** Kennzahlen für /health: ältester wartender Job, Fehlschläge der letzten
 *  Stunde, letzter Tick – damit ein stehender Runner im Monitoring auffällt. */
export async function jobStats(): Promise<{ queued: number; oldestQueuedMin: number | null; running: number; failedLastHour: number; lastTickSec: number | null }> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT
       SUM(status = 'queued') AS queued,
       SUM(status = 'running') AS running,
       TIMESTAMPDIFF(MINUTE, MIN(CASE WHEN status = 'queued' AND run_after <= NOW() THEN created_at END), NOW()) AS oldest_min,
       SUM(status = 'failed' AND finished_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)) AS failed_hour
     FROM jobs`
  )
  const r = rows[0] || {}
  return {
    queued: Number(r.queued || 0),
    running: Number(r.running || 0),
    oldestQueuedMin: r.oldest_min == null ? null : Number(r.oldest_min),
    failedLastHour: Number(r.failed_hour || 0),
    lastTickSec: lastTickAt ? Math.round((Date.now() - lastTickAt.getTime()) / 1000) : null,
  }
}

/** Offene (wartend/laufend) und zuletzt gescheiterte Jobs eines Typs – für
 *  Statusanzeigen („Versand läuft", „Versand fehlgeschlagen"). */
export async function recentJobs(type: string): Promise<{ status: string; payload: any; error: string | null }[]> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT status, payload, error FROM jobs
      WHERE type = ? AND (status IN ('queued','running') OR (status = 'failed' AND finished_at > DATE_SUB(NOW(), INTERVAL 7 DAY)))
      ORDER BY id`,
    [type]
  )
  return rows.map((r) => ({ status: r.status, payload: JSON.parse(r.payload), error: r.error }))
}

async function claim(): Promise<mysql.RowDataPacket | null> {
  for (let i = 0; i < 5; i++) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id, type, payload, attempts, max_attempts FROM jobs WHERE status = 'queued' AND run_after <= NOW() ORDER BY id LIMIT 1"
    )
    const job = rows[0]
    if (!job) return null
    const lauf = crypto.randomUUID()
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE jobs SET status = 'running', pending_key = NULL, attempts = attempts + 1, started_at = NOW(), lauf_id = ? WHERE id = ? AND status = 'queued'",
      [lauf, job.id]
    )
    if (res.affectedRows === 1) return Object.assign(job, { lauf_id: lauf })
  }
  return null
}

class JobTimeout extends Error {}

async function runJob(job: mysql.RowDataPacket): Promise<void> {
  const handler = handlers.get(job.type)
  const lauf = String(job.lauf_id)
  let timer: NodeJS.Timeout | null = null
  let work: Promise<void> | null = null
  try {
    if (!handler) throw new Error(`Unbekannter Job-Typ ${job.type}`)
    work = handler(JSON.parse(job.payload), log!)
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobTimeout(`Zeitlimit von ${Math.round(JOB_TIMEOUT_MS / 60000)} min überschritten`)), JOB_TIMEOUT_MS)
      }),
    ])
    await pool.execute(
      "UPDATE jobs SET status = 'done', finished_at = NOW(), error = NULL WHERE id = ? AND lauf_id = ?",
      [job.id, lauf]
    )
  } catch (err) {
    if (err instanceof JobRetryLater) {
      await pool.execute(
        `UPDATE jobs SET status = 'queued', attempts = ?, error = ?, started_at = NULL,
                run_after = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ? AND lauf_id = ?`,
        [Number(job.attempts), err.message.slice(0, 2000), Math.max(1, Math.round(err.seconds)), job.id, lauf]
      ).catch(() => undefined)
      return
    }
    const attempt = Number(job.attempts) + 1
    const final = !handler || attempt >= Number(job.max_attempts)
    log?.error({ err, jobId: job.id, type: job.type, attempt }, 'Hintergrund-Job fehlgeschlagen')
    // Erneuter Versuch mit Backoff: 1, 4, 9 … Minuten; nach einem Zeitlimit
    // mindestens ein weiteres Zeitlimit (der alte Handler bekommt die Chance,
    // noch fertig zu werden, siehe JOB_TIMEOUT_MS).
    const timeout = err instanceof JobTimeout
    const minuten = timeout ? Math.max(attempt * attempt, Math.ceil(JOB_TIMEOUT_MS / 60000)) : attempt * attempt
    await pool.execute(
      `UPDATE jobs SET status = ?, error = ?, finished_at = IF(? , NOW(), NULL),
              run_after = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ? AND lauf_id = ?`,
      [final ? 'failed' : 'queued', String((err as Error)?.message || err).slice(0, 2000), final, minuten, job.id, lauf]
    ).catch(() => undefined)
    if (timeout && work) {
      // Später Erfolg des alten Handlers: Job gilt als erledigt, solange noch
      // kein neuer Lauf ihn übernommen hat (lauf_id unverändert). Später Fehler:
      // ist als Fehlversuch schon gezählt.
      void work.then(
        () => pool.execute<mysql.ResultSetHeader>(
          "UPDATE jobs SET status = 'done', finished_at = NOW(), error = NULL WHERE id = ? AND lauf_id = ? AND status IN ('queued','failed')",
          [job.id, lauf]
        ).then(([r]) => {
          if (r.affectedRows) log?.warn({ jobId: job.id, type: job.type }, 'Job nach Zeitlimit doch erfolgreich beendet – Wiederholung entfällt')
        }),
        () => undefined
      ).catch(() => undefined)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function tick(): Promise<void> {
  if (ticking || !log) return
  ticking = true
  lastTickAt = new Date()
  try {
    while (running < CONCURRENCY) {
      const job = await claim()
      if (!job) break
      running++
      void runJob(job).finally(() => {
        running--
        void tick()
      })
    }
  } catch (err) {
    log.warn({ err }, 'Job-Abfrage fehlgeschlagen')
  } finally {
    ticking = false
  }
}

/** Beim Boot: liegengebliebene 'running'-Jobs (Neustart mittendrin) neu einreihen,
 *  dann regelmäßig nach Arbeit schauen. */
export async function startJobRunner(logger: FastifyBaseLogger): Promise<void> {
  log = logger
  await pool.execute("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'")
  setInterval(() => void tick(), POLL_MS)
  // Liegengebliebene 'running'-Jobs (Prozess verschwand ohne das Requeue oben,
  // z.B. OOM-Kill mit anschließendem Start einer zweiten Instanz) neu einreihen.
  setInterval(() => {
    void pool.execute(
      "UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < DATE_SUB(NOW(), INTERVAL ? SECOND)",
      [Math.round(STALE_RUNNING_MS / 1000)]
    ).catch((err) => log?.warn({ err }, 'Stale-Job-Prüfung fehlgeschlagen'))
  }, 5 * 60 * 1000).unref()
  void tick()
}

/** Erledigte Jobs nach 14 Tagen, fehlgeschlagene nach 60 Tagen löschen. */
export async function purgeJobs(): Promise<void> {
  await pool.execute(
    `DELETE FROM jobs WHERE (status = 'done' AND finished_at < DATE_SUB(NOW(), INTERVAL 14 DAY))
        OR (status = 'failed' AND finished_at < DATE_SUB(NOW(), INTERVAL 60 DAY))`
  )
}
