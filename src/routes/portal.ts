// Live-Versand über Online-Portale (Frankfurt: ekom21). Die Seite /versand
// zeigt die eingereichten Portal-Anzeigen und den Browser des Portal-Dienstes
// live (Einzelbilder, ~4/s). Eingriffe (Klick/Tippen ins Live-Bild) gehen an
// den Dienst durch. Logik und DB-Zustände: services/portalDispatch.ts.
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAdmin, requireAuth, viewData } from '../middleware/auth'
import { isAdminEmail } from '../config/admin'
import { getCity, unlockedCities } from '../config/cities'
import { fahrzeugBeschreibung } from '../config/fahrzeug'
import { portalFuer, erstMorgen } from '../services/portale'
import {
  startPortalRun, submitPortalRun, cancelPortalRun, resolveUncertain, currentRunId, runStatus,
  lastKnownStatus, proxy, portalHealthy, PortalError, PortalUnerreichbarError, wartendeStarts,
} from '../services/portalDispatch'
import { letzterSelbsttest, enqueueSelbsttest } from '../services/portalSelbsttest'
import { versandWartezeiten } from '../services/versandWarte'
import {
  versandMerken, versandPlatzBelegen, versandPlatzFreigeben, versandAbstand, versandAbstandSetzen, ABSTAND_MIN_SEK, ABSTAND_MAX_SEK,
} from '../services/versandTakt'

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
  const wartet = await wartendeStarts()
  // Geplanter Start des wartenden Jobs (Versand-Takt / „ab morgen“) für den Countdown.
  const warte = await versandWartezeiten(offen.map((r) => Number(r.id)))
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
      // Nach der Freigabe eingereiht, Lauf startet automatisch (wartet ggf. auf einen freien Platz).
      autoStart: wartet.has(Number(r.id)),
      autoIn: warte.get(Number(r.id))?.sek || 0,
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
      abstandSek: await versandAbstand(),
      selectedAz: String((request.query as { az?: string }).az || ''),
      staedte: unlockedCities().filter((c) => c.portal).map((c) => c.name).join(', '),
    }))
  })

  const reportIdOf = (request: { params: unknown }) => Number((request.params as { id: string }).id)

  app.get('/versand/liste', { preHandler: requireAdmin }, async () => loadQueue())

  // Mini-Player (public/js/versand-mini.js, auf jeder Seite): laufender
  // Portal-Versand – Admins sehen jeden, Nutzer nur den ihrer eigenen Anzeige.
  // Nur ansehen, Eingriffe gibt es weiter nur auf /versand.
  async function liveReport(request: { session: { userId?: number; userEmail?: string } }, id?: number) {
    const admin = isAdminEmail(request.session.userEmail)
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, aktenzeichen FROM reports
        WHERE versand_status IN ('vorbereitung','versand') AND versand_ergebnis LIKE '%"portal"%'
          ${admin ? '' : 'AND user_id = ?'} ${id ? 'AND id = ?' : ''}
        ORDER BY id LIMIT 1`,
      [...(admin ? [] : [Number(request.session.userId)]), ...(id ? [id] : [])]
    )
    return rows[0] ? { id: Number(rows[0].id), az: String(rows[0].aktenzeichen) } : null
  }
  app.get('/api/versand/live', { preHandler: requireAuth, config: { rateLimit: false } }, async (request) => {
    const r = await liveReport(request)
    if (!r) return { live: null }
    const runId = await currentRunId(r.id)
    const run = (runId && (await runStatus(runId).catch(() => null))) || lastKnownStatus(r.id)
    return { live: { id: r.id, az: r.az, state: run?.state ?? 'starting', message: run?.message ?? '' } }
  })
  app.get('/api/versand/live/:id/frame', { preHandler: requireAuth, config: { rateLimit: false } }, async (request, reply) => {
    const r = await liveReport(request, reportIdOf(request))
    const runId = r && (await currentRunId(r.id))
    if (!runId) return reply.status(204).send()
    const res = await proxy(runId, '/frame').catch(() => null)
    if (!res || res.status !== 200) return reply.status(204).send()
    reply.header('Cache-Control', 'no-store')
    return reply.type('image/jpeg').send(Buffer.from(await res.arrayBuffer()))
  })

  // Selbsttest von Hand (sonst nachts, services/portalSelbsttest.ts).
  app.post('/versand/selbsttest', { preHandler: requireAdmin }, async () => {
    await enqueueSelbsttest()
    return { ok: true }
  })

  // Versand-Takt: Abstand zwischen zwei Portal-Anzeigen (Sekunden).
  app.post('/versand/abstand', { preHandler: requireAdmin }, async (request, reply) => {
    const sek = Number((request.body as { sek?: unknown } | null)?.sek)
    if (!Number.isInteger(sek) || sek < ABSTAND_MIN_SEK || sek > ABSTAND_MAX_SEK) {
      return reply.status(400).send({ error: `Abstand muss zwischen ${ABSTAND_MIN_SEK} und ${ABSTAND_MAX_SEK} Sekunden liegen.` })
    }
    await versandAbstandSetzen(sek)
    return { ok: true, sek }
  })

  const fail = (reply: any, err: unknown) => {
    if (err instanceof PortalError) return reply.status(409).send({ error: err.message })
    throw err
  }

  app.post('/versand/:id/start', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const b = (request.body || {}) as { auto?: unknown; takt?: unknown }
      const auto = b.auto === true
      // „Nacheinander senden": im Versand-Takt bleiben (services/versandTakt.ts),
      // ein einzelner Klick startet sofort und zählt nur mit.
      if (b.takt === true) {
        const warten = await versandPlatzBelegen()
        if (warten !== null) return reply.status(429).send({ error: 'Versand-Takt', warten })
        try {
          return { runId: await startPortalRun(reportIdOf(request), { auto }) }
        } catch (err) {
          await versandPlatzFreigeben()
          throw err
        }
      }
      const runId = await startPortalRun(reportIdOf(request), { auto })
      await versandMerken()
      return { runId }
    } catch (err) {
      // Portal der Stadt (oder Dienst) nicht erreichbar: später erneut versuchen.
      if (err instanceof PortalUnerreichbarError) return reply.status(503).send({ error: err.message, warten: 60 })
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
