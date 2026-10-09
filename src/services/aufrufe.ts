import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { logger } from './logger'

// Seitenaufrufe & Wege ohne Tracking: Gezählt wird serverseitig, je Tag ein
// Zähler pro (Seite, vorige Seite). Kein Cookie, kein Script, keine IP, kein
// User-Agent, keine Nutzer-ID – ein „Weg" ist nur die Kante vorige Seite →
// Seite aus dem Referer, nie eine zusammenhängende Sitzung. Damit der Referer
// für eigene Seiten ankommt, setzt server.ts `Referrer-Policy: same-origin`
// (fremde Seiten bekommen weiterhin nichts).

// Diese Seite selbst nicht zählen, sonst dominiert ihr eigenes Neuladen.
const AUSGENOMMEN = new Set(['/admin/aufrufe'])

/**
 * Routen-Muster zu einem Pfad: `/anzeige/OWiA-000123` → `/anzeige/:az`. So
 * landen keine Aktenzeichen, Sticker-Codes oder Login-Tokens in der Tabelle.
 * findRoute liefert nur die Parameter, also werden deren Werte im Pfad
 * zurückersetzt. `null`, wenn es keine GET-Route gibt.
 */
export function routeMuster(app: FastifyInstance, pathname: string): string | null {
  const route = app.findRoute({ method: 'GET', url: pathname })
  if (!route) return null
  const params = route.params || {}
  // Wildcard (`/public/*`) umfasst mehrere Segmente: Rest durch `*` ersetzen.
  if (params['*'] !== undefined) {
    const rest = params['*']
    const basis = rest && pathname.endsWith(rest) ? pathname.slice(0, -rest.length) : pathname.slice(0, pathname.lastIndexOf('/') + 1)
    return `${basis}*`.slice(0, 191)
  }
  const namen = Object.entries(params)
  return pathname.split('/').map((seg) => {
    let wert = seg
    try { wert = decodeURIComponent(seg) } catch { /* Rohwert vergleichen */ }
    const p = namen.find(([, v]) => v === wert)
    return p ? `:${p[0]}` : seg
  }).join('/').slice(0, 191)
}

/** Herkunft eines Aufrufs: Muster der eigenen vorigen Seite, `extern:<host>` oder `direkt`. */
export function herkunft(app: FastifyInstance, referer: string | undefined, eigenerHost: string): string {
  if (!referer) return 'direkt'
  let url: URL
  try { url = new URL(referer) } catch { return 'direkt' }
  if (url.host !== eigenerHost) return `extern:${url.hostname.replace(/^www\./, '')}`.slice(0, 191)
  return routeMuster(app, url.pathname) ?? '(unbekannt)'
}

/**
 * onResponse-Hook: zählt nur echte Seitennavigationen (Sec-Fetch-Dest
 * document + Mode navigate) mit HTML-Antwort 200. fetch-Aufrufe, iframes
 * (`?embed=1`), Bilder, Prefetches und die meisten Bots (schicken keine
 * Fetch-Metadata) fallen damit von selbst heraus.
 */
export function zaehleAufruf(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  if (request.method !== 'GET' || reply.statusCode !== 200) return
  const h = request.headers
  if (h['sec-fetch-dest'] !== 'document' || h['sec-fetch-mode'] !== 'navigate') return
  if (h['sec-purpose'] || h['purpose']) return
  if (!String(reply.getHeader('content-type') || '').includes('text/html')) return
  const pfad = request.routeOptions.url
  if (!pfad || AUSGENOMMEN.has(pfad)) return
  const von = herkunft(app, h.referer, request.host)
  pool.execute(
    `INSERT INTO seitenaufrufe(tag, pfad, von, anzahl) VALUES (CURDATE(), ?, ?, 1)
     ON DUPLICATE KEY UPDATE anzahl = anzahl + 1`,
    [pfad.slice(0, 191), von]
  ).catch((err) => logger.warn({ err }, 'Seitenaufruf nicht gezählt'))
}

export type Zeile = { name: string; anzahl: number }
export type Weg = { von: string; pfad: string; anzahl: number }

/** Auswertung für /admin/aufrufe über die letzten `tage` Tage, optional mit Detail zu einer Seite. */
export async function ladeAufrufe(tage: number, seite?: string) {
  const ab = `DATE_SUB(CURDATE(), INTERVAL ${tage - 1} DAY)`
  const q = async (sql: string, values: string[] = []) =>
    (await pool.execute<mysql.RowDataPacket[]>(sql, values))[0]

  const proTagRows = await q(
    `SELECT DATE_FORMAT(tag, '%Y-%m-%d') AS tag, SUM(anzahl) AS anzahl
       FROM seitenaufrufe WHERE tag >= ${ab} GROUP BY tag`
  )
  const proTagMap = new Map(proTagRows.map((r) => [r.tag as string, Number(r.anzahl)]))
  // Lückenlose Tagesreihe (Tage ohne Aufruf = 0), Datum als String ohne JS-Date-Zeitzonen.
  const tagRows = await q(
    `SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL seq DAY), '%Y-%m-%d') AS tag
       FROM (SELECT ones.n + tens.n * 10 + hund.n * 100 AS seq
               FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) ones,
                    (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) tens,
                    (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3) hund) s
      WHERE seq < ${tage}
      ORDER BY seq DESC`
  )
  const proTag = tagRows.map((r) => ({ tag: r.tag as string, anzahl: proTagMap.get(r.tag) ?? 0 }))

  const zeilen = (rows: mysql.RowDataPacket[]): Zeile[] =>
    rows.map((r) => ({ name: r.name, anzahl: Number(r.anzahl) }))

  const seiten = zeilen(await q(
    `SELECT pfad AS name, SUM(anzahl) AS anzahl FROM seitenaufrufe
      WHERE tag >= ${ab} GROUP BY pfad ORDER BY anzahl DESC LIMIT 50`
  ))
  // Einstiege: Aufrufe, die nicht von einer eigenen Seite kamen.
  const quellen = zeilen(await q(
    `SELECT von AS name, SUM(anzahl) AS anzahl FROM seitenaufrufe
      WHERE tag >= ${ab} AND von NOT LIKE '/%' GROUP BY von ORDER BY anzahl DESC LIMIT 30`
  ))
  const einstiege = zeilen(await q(
    `SELECT pfad AS name, SUM(anzahl) AS anzahl FROM seitenaufrufe
      WHERE tag >= ${ab} AND von NOT LIKE '/%' GROUP BY pfad ORDER BY anzahl DESC LIMIT 20`
  ))
  // Wege zwischen eigenen Seiten; Neuladen/Filtern derselben Seite ausgenommen.
  const wege = (await q(
    `SELECT von, pfad, SUM(anzahl) AS anzahl FROM seitenaufrufe
      WHERE tag >= ${ab} AND von LIKE '/%' AND von <> pfad
      GROUP BY von, pfad ORDER BY anzahl DESC LIMIT 50`
  )).map((r) => ({ von: r.von, pfad: r.pfad, anzahl: Number(r.anzahl) })) as Weg[]

  let detail: { seite: string; woher: Zeile[]; wohin: Zeile[]; gesamt: number } | null = null
  if (seite) {
    const woher = zeilen(await q(
      `SELECT von AS name, SUM(anzahl) AS anzahl FROM seitenaufrufe
        WHERE tag >= ${ab} AND pfad = ? GROUP BY von ORDER BY anzahl DESC LIMIT 30`, [seite]
    ))
    const wohin = zeilen(await q(
      `SELECT pfad AS name, SUM(anzahl) AS anzahl FROM seitenaufrufe
        WHERE tag >= ${ab} AND von = ? GROUP BY pfad ORDER BY anzahl DESC LIMIT 30`, [seite]
    ))
    detail = { seite, woher, wohin, gesamt: woher.reduce((s, z) => s + z.anzahl, 0) }
  }

  const gesamt = proTag.reduce((s, t) => s + t.anzahl, 0)
  const extern = quellen.filter((z) => z.name.startsWith('extern:')).reduce((s, z) => s + z.anzahl, 0)
  return { tage, proTag, gesamt, seiten, quellen, einstiege, wege, extern, detail }
}
