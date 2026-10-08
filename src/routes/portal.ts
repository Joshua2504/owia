// Live-Versand über Online-Portale (Frankfurt: ekom21). Die Seite /versand
// zeigt die eingereichten Portal-Anzeigen und den Browser des Portal-Dienstes
// live (Einzelbilder, ~4/s). Eingriffe (Klick/Tippen ins Live-Bild) gehen an
// den Dienst durch. Logik und DB-Zustände: services/portalDispatch.ts.
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAdmin, viewData } from '../middleware/auth'
import { getCity, unlockedCities } from '../config/cities'
import { fahrzeugBeschreibung } from '../config/fahrzeug'
import { portalFuer, erstMorgen } from '../services/portale'
import {
  startPortalRun, submitPortalRun, cancelPortalRun, resolveUncertain, currentRunId, runStatus,
  lastKnownStatus, proxy, portalHealthy, PortalError,
} from '../services/portalDispatch'
import { letzterSelbsttest, enqueueSelbsttest } from '../services/portalSelbsttest'

const adapterOf = (r: mysql.RowDataPacket) => portalFuer(r.city)!
const portalCities = () => unlockedCities().filter((c) => c.portal).map((c) => c.id)

async function loadQueue() {
  const cities = portalCities()
  if (!cities.length) return { offen: [], gesendet: [] }
  const ph = cities.map(() => '?').join(',')
  const [offen] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT r.*, DATE_FORMAT(r.eingereicht_at, '%d.%m.%Y %H:%i') AS eingereicht_fmt,
            DATE_FORMAT(r.tattag, '%d.%m.%Y') AS tattag_fmt, DATE_FORMAT(r.tatzeit_von, '%H:%i') AS von_fmt,
            DATE_FORMAT(r.tatzeit_bis, '%H:%i') AS bis_fmt, u.email AS user_email,
            (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = r.id) AS image_count
       FROM reports r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'eingereicht' AND r.city IN (${ph})
      ORDER BY r.eingereicht_at, r.id`,
    cities
  )
  const [gesendet] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT r.id, r.aktenzeichen, r.kennzeichen, r.portal_vorgang_id, r.portal_beleg
       FROM reports r
      WHERE r.status = 'versendet' AND r.versand_art = 'portal'
      ORDER BY r.id DESC LIMIT 15`
  )
  return {
    offen: offen.map((r) => ({
      id: Number(r.id),
      az: r.aktenzeichen,
      kennzeichen: r.kennzeichen,
      fahrzeug: fahrzeugBeschreibung(r),
      tatort: r.tatort,
      tatzeit: `${r.tattag_fmt || ''} ${r.von_fmt || ''}${r.bis_fmt ? `–${r.bis_fmt}` : ''}`,
      verstoss: r.verstoss_art,
      variante: r.verstoss_variante,
      imPortal: adapterOf(r).versendbar(r.verstoss_art),
      abMorgen: erstMorgen(adapterOf(r), r),
      varianteFehlt: adapterOf(r).varianteFehlt(r),
      stadt: getCity(r.city).name,
      bilder: Number(r.image_count),
      userEmail: r.user_email,
      eingereicht: r.eingereicht_fmt,
      versandStatus: r.versand_status as string | null,
      unklar: r.versand_status === 'versand' && /"error"/.test(r.versand_ergebnis || ''),
      unklarGrund: (() => { try { return JSON.parse(r.versand_ergebnis || '{}').portal?.error || null } catch { return null } })(),
    })),
    gesendet,
  }
}

export default async function portalRoutes(app: FastifyInstance) {
  app.get('/versand', { preHandler: requireAdmin }, async (request, reply) => {
    const queue = await loadQueue()
    return reply.view('/admin/versand.ejs', viewData(request, {
      title: 'Live-Versand',
      queue,
      portalOk: await portalHealthy(),
      selbsttest: await letzterSelbsttest(),
      selectedAz: String((request.query as { az?: string }).az || ''),
      staedte: unlockedCities().filter((c) => c.portal).map((c) => c.name).join(', '),
    }))
  })

  app.get('/versand/liste', { preHandler: requireAdmin }, async () => loadQueue())

  // Selbsttest von Hand (sonst nachts, services/portalSelbsttest.ts).
  app.post('/versand/selbsttest', { preHandler: requireAdmin }, async () => {
    await enqueueSelbsttest()
    return { ok: true }
  })

  const reportIdOf = (request: { params: unknown }) => Number((request.params as { id: string }).id)
  const fail = (reply: any, err: unknown) => {
    if (err instanceof PortalError) return reply.status(409).send({ error: err.message })
    throw err
  }

  app.post('/versand/:id/start', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const auto = (request.body as { auto?: unknown } | undefined)?.auto === true
      return { runId: await startPortalRun(reportIdOf(request), { auto }) }
    } catch (err) {
      return fail(reply, err)
    }
  })

  // Status: DB-Sicht + Lauf (live vom Dienst, sonst der zuletzt bekannte).
  app.get('/versand/:id/status', { preHandler: requireAdmin, config: { rateLimit: false } }, async (request) => {
    const id = reportIdOf(request)
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT status, versand_status, versand_art, portal_vorgang_id, aktenzeichen FROM reports WHERE id=?', [id]
    )
    const r = rows[0]
    const runId = await currentRunId(id)
    let run = null
    if (runId) run = await runStatus(runId).catch(() => null)
    if (!run) run = lastKnownStatus(id)
    return {
      report: r ? { status: r.status, versandStatus: r.versand_status, versandArt: r.versand_art, vorgangsId: r.portal_vorgang_id, az: r.aktenzeichen } : null,
      runId,
      run: run && { ...run, log: run.log?.slice(-40) },
    }
  })

  app.get('/versand/:id/frame', { preHandler: requireAdmin, config: { rateLimit: false } }, async (request, reply) => {
    const runId = await currentRunId(reportIdOf(request))
    if (!runId) return reply.status(204).send()
    const res = await proxy(runId, '/frame').catch(() => null)
    if (!res || res.status !== 200) return reply.status(204).send()
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Frame-No', res.headers.get('x-frame-no') || '0')
    return reply.type('image/jpeg').send(Buffer.from(await res.arrayBuffer()))
  })

  app.post('/versand/:id/input', { preHandler: requireAdmin, config: { rateLimit: false } }, async (request, reply) => {
    const runId = await currentRunId(reportIdOf(request))
    if (!runId) return reply.status(409).send({ error: 'Kein laufender Vorgang.' })
    const res = await proxy(runId, '/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body || {}),
    })
    return reply.status(res.status).send(await res.json().catch(() => ({})))
  })

  app.post('/versand/:id/fortsetzen', { preHandler: requireAdmin }, async (request, reply) => {
    const runId = await currentRunId(reportIdOf(request))
    if (!runId) return reply.status(409).send({ error: 'Kein laufender Vorgang.' })
    const res = await proxy(runId, '/resume', { method: 'POST' })
    return reply.status(res.status).send(await res.json().catch(() => ({})))
  })

  app.post('/versand/:id/absenden', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      await submitPortalRun(reportIdOf(request))
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post('/versand/:id/abbrechen', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      await cancelPortalRun(reportIdOf(request))
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })

  // Unklarer Ausgang (Fehler nach dem Absenden): nach Prüfung von Hand auflösen.
  app.post('/versand/:id/klaeren', { preHandler: requireAdmin }, async (request, reply) => {
    const b = (request.body || {}) as { ergebnis?: string; vorgangsId?: string }
    try {
      await resolveUncertain(reportIdOf(request), b.ergebnis === 'gesendet' ? 'gesendet' : 'nicht-gesendet', b.vorgangsId)
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })
}
