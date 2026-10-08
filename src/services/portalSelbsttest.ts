// Nächtlicher Selbsttest des Portal-Versands: ändert eine Stadt ihr Formular,
// soll das nicht erst beim nächsten echten Versand auffallen. Der Test füllt das
// echte Portal mit erfundenen Daten und künstlichen Bildern bis zur
// Zusammenfassung aus und bricht dann ab – abgesendet wird NIE. Jede Nacht ein
// anderer Fall (Stadt × Tatbestand), damit über zwei Wochen alle Portale und
// Zweige laufen. Fehlschlag ⇒ Job 'failed' + Mail an die Admins.
// Ergebnis steht auf /versand (letzter Job dieses Typs).

import jpeg from 'jpeg-js'
import mysql from 'mysql2/promise'
import type { FastifyBaseLogger } from 'fastify'
import { pool } from '../db/connection'
import { VERSTOSS_ARTEN } from '../config/verstoss'
import { verstossVarianten } from './portalFfm'
import { portalFuer } from './portale'
import { MailService } from './mail'
import { enqueueJob, registerJob } from './jobs'

const PORTAL_URL = (process.env.PORTAL_URL || 'http://portal:8080').replace(/\/$/, '')

/** Testfälle: Frankfurt je Rubrik ein typischer Tatbestand, dazu Wiesbaden
 *  (Rubrik + „Sonstiges") und Mainz (Rubrik + Kreuzung). */
const FAELLE: { stadt: string; tbnr: string }[] = [
  ...['141174', '112454', '141312', '112042', '141245', '112216', '112464', '112262'].map((tbnr) => ({ stadt: 'frankfurt', tbnr })),
  { stadt: 'wiesbaden', tbnr: '141312' },
  { stadt: 'wiesbaden', tbnr: '112456' },
  { stadt: 'mainz', tbnr: '112454' },
  { stadt: 'mainz', tbnr: '112262' },
]
const TATORT: Record<string, string> = {
  frankfurt: 'Römerberg 1, 60311 Frankfurt am Main',
  wiesbaden: 'Wilhelmstraße 10, 65183 Wiesbaden',
  mainz: 'Große Bleiche 12, 55116 Mainz',
}

function testbild(rgb: [number, number, number]): string {
  const w = 800
  const h = 600
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const stripe = (i % w) & 32 ? 40 : 0
    data[i * 4] = Math.min(255, rgb[0] + stripe)
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 80).data).toString('base64')
}

async function portal(p: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(PORTAL_URL + p, { ...init, signal: AbortSignal.timeout(60000) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Portal-Dienst HTTP ${res.status}`)
  return body
}

export async function runSelbsttest(index = Math.floor(Date.now() / 86400000)): Promise<{ tatbestand: string; dauerSek: number }> {
  const { stadt, tbnr } = FAELLE[index % FAELLE.length]
  const adapter = portalFuer(stadt)
  if (!adapter) throw new Error(`Kein Portal für ${stadt}.`)
  const label = VERSTOSS_ARTEN.find((l) => l.startsWith(`${tbnr} – `))
  if (!label) throw new Error(`Test-Tatbestand ${tbnr} fehlt im Katalog.`)
  // Das Portal nimmt nur Tattage vor heute an.
  const gestern = new Date(Date.now() - 86400000)
  const report = {
    verstoss_art: label,
    verstoss_variante: verstossVarianten(label)[0]?.value ?? null,
    kennzeichen: 'F-OW 1234',
    kennzeichen_land: 'D',
    fahrzeug_marke: 'VW',
    fahrzeug_modell: 'Golf',
    fahrzeug_farbe: 'grau',
    tattag: gestern,
    tatzeit_von: '10:00:00',
    tatzeit_bis: '10:20:00',
    tatort: TATORT[stadt],
    city: stadt,
    behinderung: 0,
  } as unknown as mysql.RowDataPacket
  const user = {
    anrede: 'herr', vorname: 'Max', nachname: 'Mustermann', strasse: 'Römerberg', hausnummer: '1',
    // Wiesbaden verlangt eine E-Mail, Mainz eine Telefonnummer – Test-Werte,
    // abgesendet wird nie.
    plz: '60311', ort: 'Frankfurt am Main', telefon: '069 0000000', email: 'selbsttest@example.org',
  } as unknown as mysql.RowDataPacket
  const payload = adapter.payload(report, user)
  const files = [
    { role: 'uebersicht', name: 'selbsttest-uebersicht.jpg', data: testbild([180, 60, 60]) },
    { role: 'fahrzeug', name: 'selbsttest-fahrzeug.jpg', data: testbild([60, 60, 180]) },
  ]
  const start = Date.now()
  const run = await portal('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload, files }) })
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000))
      const st = await portal(`/runs/${run.id}`)
      if (st.state === 'ready') {
        if (st.pauses) throw new Error(`Zusammenfassung erreicht, aber mit ${st.pauses} Pause(n) – Ablauf geändert?`)
        return { tatbestand: `${stadt}: ${label}`, dauerSek: Math.round((Date.now() - start) / 1000) }
      }
      if (st.state === 'needs_input' || st.state === 'failed' || st.state === 'cancelled') {
        const letzte = (st.log || []).slice(-6).map((l: { msg: string }) => l.msg).join('\n')
        throw new Error(`${st.message || st.state} (Schritt ${st.step?.n ?? '?'} ${st.step?.title ?? ''})\n${letzte}`)
      }
      if (Date.now() - start > 4 * 60 * 1000) throw new Error(`Zeitüberschreitung in Schritt ${st.step?.n ?? '?'} ${st.step?.title ?? ''}`)
    }
  } finally {
    // Immer abbrechen – ein Selbsttest wird nie abgesendet.
    await portal(`/runs/${run.id}/cancel`, { method: 'POST' }).catch(() => {})
  }
}

registerJob('portal.selbsttest', async (_payload, log) => {
  try {
    const r = await runSelbsttest()
    log.info(r, 'Portal-Selbsttest erfolgreich')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await MailService.sendAdminHinweis(
      'OWiA: Portal-Selbsttest fehlgeschlagen (Frankfurt/ekom21)',
      [
        'Der nächtliche Testlauf gegen das Frankfurter Online-Portal ist fehlgeschlagen.',
        'Vermutlich hat sich das Formular geändert – Portal-Versand vor dem nächsten',
        'Einsatz unter /versand prüfen (Trockenlauf bis zur Zusammenfassung).',
        '',
        msg,
      ].join('\n')
    ).catch((e) => log.error({ err: e }, 'Hinweis-Mail zum Selbsttest nicht versendet'))
    throw err
  }
})

/** Selbsttest einreihen (Knopf auf /versand oder Zeitplan). */
export async function enqueueSelbsttest(): Promise<void> {
  await enqueueJob('portal.selbsttest', {}, { key: 'portal.selbsttest', maxAttempts: 1 })
}

/** Zeitplan: einmal je Nacht gegen 3 Uhr (Berliner Zeit), sofern heute noch keiner lief. */
export function startSelbsttestPlan(log: FastifyBaseLogger): void {
  const tick = async () => {
    try {
      const stunde = Number(new Intl.DateTimeFormat('de-DE', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Berlin' }).format(new Date()))
      if (stunde !== 3) return
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT 1 FROM jobs WHERE type='portal.selbsttest' AND created_at > DATE_SUB(NOW(), INTERVAL 20 HOUR) LIMIT 1"
      )
      if (!rows.length) await enqueueSelbsttest()
    } catch (err) {
      log.error({ err }, 'Portal-Selbsttest nicht eingereiht')
    }
  }
  setInterval(tick, 10 * 60 * 1000).unref()
}

/** Letztes Ergebnis für die Anzeige auf /versand. */
export async function letzterSelbsttest(): Promise<{ ok: boolean; laeuft: boolean; zeit: string; meldung: string } | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT status, error, DATE_FORMAT(COALESCE(finished_at, created_at), '%d.%m. %H:%i') AS zeit
       FROM jobs WHERE type='portal.selbsttest' ORDER BY id DESC LIMIT 1`
  )
  const j = rows[0]
  if (!j) return null
  const laeuft = j.status === 'queued' || j.status === 'running'
  return { ok: j.status === 'done' || laeuft, laeuft, zeit: laeuft ? 'läuft' : j.zeit, meldung: j.error || (laeuft ? 'Test läuft' : 'Formular bis zur Zusammenfassung durchgelaufen') }
}
