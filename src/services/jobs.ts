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

let log: FastifyBaseLogger | null = null
let running = 0
let ticking = false

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
  await pool.execute(
    'INSERT IGNORE INTO jobs (type, payload, pending_key, max_attempts) VALUES (?, ?, ?, ?)',
    [type, JSON.stringify(payload ?? null), opts.key ?? null, opts.maxAttempts ?? 3]
  )
  setImmediate(() => void tick())
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
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE jobs SET status = 'running', pending_key = NULL, attempts = attempts + 1, started_at = NOW() WHERE id = ? AND status = 'queued'",
      [job.id]
    )
    if (res.affectedRows === 1) return job
  }
  return null
}

async function runJob(job: mysql.RowDataPacket): Promise<void> {
  const handler = handlers.get(job.type)
  try {
    if (!handler) throw new Error(`Unbekannter Job-Typ ${job.type}`)
    await handler(JSON.parse(job.payload), log!)
    await pool.execute("UPDATE jobs SET status = 'done', finished_at = NOW(), error = NULL WHERE id = ?", [job.id])
  } catch (err) {
    const attempt = Number(job.attempts) + 1
    const final = !handler || attempt >= Number(job.max_attempts)
    log?.error({ err, jobId: job.id, type: job.type, attempt }, 'Hintergrund-Job fehlgeschlagen')
    // Erneuter Versuch mit Backoff: 1, 4, 9 … Minuten.
    await pool.execute(
      `UPDATE jobs SET status = ?, error = ?, finished_at = IF(? , NOW(), NULL),
              run_after = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?`,
      [final ? 'failed' : 'queued', String((err as Error)?.message || err).slice(0, 2000), final, attempt * attempt, job.id]
    ).catch(() => undefined)
  }
}

async function tick(): Promise<void> {
  if (ticking || !log) return
  ticking = true
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
  void tick()
}

/** Erledigte Jobs nach 14 Tagen, fehlgeschlagene nach 60 Tagen löschen. */
export async function purgeJobs(): Promise<void> {
  await pool.execute(
    `DELETE FROM jobs WHERE (status = 'done' AND finished_at < DATE_SUB(NOW(), INTERVAL 14 DAY))
        OR (status = 'failed' AND finished_at < DATE_SUB(NOW(), INTERVAL 60 DAY))`
  )
}
