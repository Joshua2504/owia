import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { viewData } from '../middleware/auth'
import { pool } from '../db/connection'
import { regelsatzEuro } from '../config/verstoss'
import { logger } from '../services/logger'
import { appUrl } from '../config/app'
import { RATGEBER_THEMEN } from '../config/ratgeber'

// Frankfurt-Landingpage: Keyword in der URL („falschparker melden frankfurt").
// Auch in Sitemap/robots.txt (routes/public.ts) und in den Links von Footer/Startseite.
export const LANDING_FFM = '/falschparker-melden-frankfurt'

// Inhaltlicher Stand der Landingpage (sichtbar + dateModified im Schema).
// Bei Änderungen an Nummern/Texten in falschparker-melden.ejs mitziehen.
const STAND = { iso: '2026-10-09', text: 'Oktober 2026' }
export const LANDING_STAND = STAND.iso

// Bußgeld-Beispiele: [Beschriftung, TBNR ohne Behinderung, TBNR mit Behinderung].
// Beträge liefert regelsatzEuro() aus dem KBA-Katalog – TBNR ohne Betrag fällt weg.
const BUSSGELD_BEISPIELE: [string, string, string | null][] = [
  ['Parken auf dem Gehweg', '141184', '141785'],
  ['Parken auf dem Radweg / Radfahrstreifen', '141174', '141775'],
  ['Parken in der Feuerwehrzufahrt', '112216', '112612'],
  ['Parken an einer Bushaltestelle (15 m)', '141402', '141818'],
  ['Parken auf einem Schwerbehinderten-Parkplatz', '142278', null],
  ['Parken auf einem E-Ladeplatz ohne Berechtigung', '142284', null],
  ['Parken im absoluten Halteverbot', '141312', '141313'],
  ['Parken im eingeschränkten Halteverbot', '141322', '141323'],
]

// Frankfurt-Zahlen für die Landingpage (nur Aggregate, 10 min gecacht).
let ffmCache: { bis: number; werte: { total: number; last30: number } | null } = { bis: 0, werte: null }
async function frankfurtKennzahlen(): Promise<{ total: number; last30: number } | null> {
  if (Date.now() < ffmCache.bis) return ffmCache.werte
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS total,
              SUM(tattag >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS last30
         FROM reports WHERE status = 'versendet' AND city = 'frankfurt'`
    )
    ffmCache = { bis: Date.now() + 10 * 60_000, werte: { total: Number(rows[0]?.total || 0), last30: Number(rows[0]?.last30 || 0) } }
  } catch (err) {
    logger.error({ err }, 'Frankfurt-Kennzahlen nicht ladbar')
    ffmCache = { bis: Date.now() + 60_000, werte: null }
  }
  return ffmCache.werte
}

/** Bußgeld-Beispiele mit Beträgen (auch für die übrigen Stadtseiten, routes/ratgeber.ts). */
export function bussgeldBeispiele(): { label: string; ohne: number | null; mit: number | null }[] {
  return BUSSGELD_BEISPIELE
    .map(([label, ohne, mit]) => ({ label, ohne: regelsatzEuro(ohne), mit: mit ? regelsatzEuro(mit) : null }))
    .filter((b) => b.ohne !== null)
}

export default async function legalRoutes(app: FastifyInstance) {
  // Öffentlich erreichbar (kein requireAuth), damit Impressum und
  // Datenschutzerklärung auch ohne Anmeldung aufrufbar sind.
  app.get('/impressum', async (request, reply) => {
    return reply.view('/legal/impressum.ejs', viewData(request, { title: 'Impressum' }))
  })

  app.get('/datenschutz', async (request, reply) => {
    return reply.view(
      '/legal/datenschutz.ejs',
      viewData(request, { title: 'Datenschutzerklärung' })
    )
  })

  // SEO-Landingpage „Falschparker melden in Frankfurt": sofort anrufen
  // (Hotlines) oder nachträglich online anzeigen. Öffentlich + in
  // Sitemap/robots.txt (routes/public.ts). Bußgelder kommen live aus dem
  // KBA-Katalog (resources/bussgelder.csv), damit kein Betrag veraltet.
  // Alte Adresse (bis 09.10.2026) dauerhaft umleiten – Links/Ranking bleiben.
  app.get('/falschparker-melden', (_request, reply) => reply.redirect(LANDING_FFM, 301))
  app.get(LANDING_FFM, async (request, reply) => {
    const base = appUrl()
    const bussgelder = bussgeldBeispiele()
    return reply.view(
      '/legal/falschparker-melden.ejs',
      viewData(request, {
        title: 'Falschparker melden in Frankfurt',
        pageTitle: 'Falschparker melden in Frankfurt: Nummern & Online-Anzeige',
        metaDescription:
          'Falschparker in Frankfurt melden: Verkehrspolizei 069 212-36360, nachts 069 212-44044 – oder kostenlos online anzeigen. Gehweg, Radweg, Feuerwehrzufahrt.',
        canonical: `${base}${LANDING_FFM}`,
        appUrl: base,
        bussgelder,
        ffm: await frankfurtKennzahlen(),
        stand: STAND,
        themen: RATGEBER_THEMEN,
      })
    )
  })

  app.get('/nutzungsbedingungen', async (request, reply) => {
    return reply.view(
      '/legal/nutzungsbedingungen.ejs',
      viewData(request, { title: 'Nutzungsbedingungen' })
    )
  })
}
