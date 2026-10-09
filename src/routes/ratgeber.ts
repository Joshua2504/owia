import { FastifyInstance } from 'fastify'
import { viewData } from '../middleware/auth'
import { appUrl } from '../config/app'
import { VERSTOESSE, regelsatzEuro, verstossText } from '../config/verstoss'
import { RATGEBER_THEMEN, RATGEBER_STAND, KATALOG_KATEGORIEN } from '../config/ratgeber'
import { STADT_SEITEN, STADT_SEITEN_GENERISCH } from '../config/stadtSeiten'
import { bussgeldBeispiele } from './legal'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { logger } from '../services/logger'

// SEO-Ratgeber: Übersicht, Themenseiten und Bußgeldkatalog (Inhalte in
// config/ratgeber.ts). Alle öffentlich; robots.txt/sitemap.xml (routes/public.ts)
// nehmen die Pfade aus RATGEBER_PFADE.

export const KATALOG_PFAD = '/bussgeldkatalog-parken'
/** Stand des KBA-Katalogs (resources/bussgelder.csv, config/verstoss.ts). */
const KATALOG_STAND = '22.08.2024'

/** Alle Ratgeber-Pfade (für robots.txt und Sitemap). */
export const RATGEBER_PFADE = [
  '/ratgeber', ...RATGEBER_THEMEN.map((t) => '/' + t.slug), KATALOG_PFAD,
  ...STADT_SEITEN_GENERISCH.map((s) => '/' + s.slug),
]

// Versendete Anzeigen je Stadt (nur Aggregate, 10 min gecacht; null bei DB-Fehler).
const zahlenCache = new Map<string, { bis: number; werte: { total: number; last30: number } | null }>()
async function stadtZahlen(cityId: string): Promise<{ total: number; last30: number } | null> {
  const c = zahlenCache.get(cityId)
  if (c && Date.now() < c.bis) return c.werte
  let werte: { total: number; last30: number } | null = null
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS total, SUM(tattag >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS last30
         FROM reports WHERE status = 'versendet' AND city = ?`, [cityId]
    )
    werte = { total: Number(rows[0]?.total || 0), last30: Number(rows[0]?.last30 || 0) }
  } catch (err) {
    logger.error({ err, cityId }, 'Stadt-Kennzahlen nicht ladbar')
  }
  zahlenCache.set(cityId, { bis: Date.now() + (werte ? 10 * 60_000 : 60_000), werte })
  return werte
}

/** Tabellenzeilen zu TBNR-Liste; Nummern ohne Text oder Betrag fallen weg. */
function bussgeldZeilen(tbnr: string[]): { tbnr: string; text: string; euro: number }[] {
  return tbnr.flatMap((nr) => {
    const text = verstossText(nr), euro = regelsatzEuro(nr)
    return text && euro !== null ? [{ tbnr: nr, text, euro }] : []
  })
}

// Katalog-Gruppen einmal beim Start bilden (CSV ist statisch).
const KATALOG_GRUPPEN = (() => {
  const gruppen = [...KATALOG_KATEGORIEN, { id: 'sonstiges', titel: 'Sonstige Park- und Halteverstöße', re: /./ }]
    .map((k) => ({
      id: k.id,
      titel: k.titel,
      thema: 'thema' in k && k.thema ? RATGEBER_THEMEN.find((t) => t.slug === k.thema) || null : null,
      re: k.re,
      zeilen: [] as { tbnr: string; text: string; euro: number | null }[],
    }))
  for (const v of VERSTOESSE) {
    if (v.tbnr === '000000') continue
    const g = gruppen.find((x) => x.re.test(v.text))!
    g.zeilen.push({ tbnr: v.tbnr, text: v.text, euro: regelsatzEuro(v.tbnr) })
  }
  return gruppen.filter((g) => g.zeilen.length).map(({ re: _re, ...g }) => g)
})()

/** Regelsatz als Text für FAQ-Antworten („55 €"), leer wenn unbekannt. */
function euroText(tbnr: string): string {
  const e = regelsatzEuro(tbnr)
  return e === null ? '' : `${e.toLocaleString('de-DE')} €`
}

export default async function ratgeberRoutes(app: FastifyInstance) {
  const basis = (request: Parameters<typeof viewData>[0], extra: Record<string, unknown>) =>
    viewData(request, { appUrl: appUrl(), stand: RATGEBER_STAND, staedte: STADT_SEITEN, themen: RATGEBER_THEMEN, ...extra })

  app.get('/ratgeber', async (request, reply) => {
    return reply.view('/ratgeber/index.ejs', basis(request, {
      title: 'Ratgeber Falschparker',
      pageTitle: 'Ratgeber Falschparker: melden, anzeigen, Bußgeld | OWiA-Anzeiger',
      metaDescription:
        'Gehweg, Radweg, Einfahrt oder Feuerwehrzufahrt zugeparkt? Was erlaubt ist, wen du anrufst, welches Bußgeld droht und wie du Falschparker kostenlos anzeigst.',
      canonical: `${appUrl()}/ratgeber`,
    }))
  })

  for (const thema of RATGEBER_THEMEN) {
    app.get('/' + thema.slug, async (request, reply) => {
      return reply.view('/ratgeber/thema.ejs', basis(request, {
        title: thema.kurz,
        pageTitle: thema.pageTitle,
        metaDescription: thema.metaDescription,
        canonical: `${appUrl()}/${thema.slug}`,
        thema,
        zeilen: bussgeldZeilen(thema.tbnr),
      }))
    })
  }

  for (const stadt of STADT_SEITEN_GENERISCH) {
    app.get('/' + stadt.slug, async (request, reply) => {
      return reply.view('/ratgeber/stadt.ejs', basis(request, {
        title: `Falschparker melden in ${stadt.name}`,
        pageTitle: `Falschparker melden in ${stadt.name}: Nummern & Online-Anzeige`,
        metaDescription:
          `Falschparker in ${stadt.name} melden: ${stadt.anruf[2].split(' · ')[0]} ${stadt.anruf[0]} – oder kostenlos online anzeigen. Gehweg, Radweg, Einfahrt, Feuerwehrzufahrt.`,
        canonical: `${appUrl()}/${stadt.slug}`,
        stadt,
        bussgelder: bussgeldBeispiele(),
        zahlen: await stadtZahlen(stadt.id),
      }))
    })
  }

  app.get(KATALOG_PFAD, async (request, reply) => {
    const jahr = new Date().getFullYear()
    const anzahl = KATALOG_GRUPPEN.reduce((n, g) => n + g.zeilen.length, 0)
    const faq: [string, string][] = [
      ['Was kostet Falschparken auf dem Gehweg?',
       `Der Regelsatz für verbotswidriges Parken auf dem Gehweg beträgt ${euroText('112454')}, mit Behinderung anderer ${euroText('112655')}. Steht das Fahrzeug länger als eine Stunde, wird es teurer.`],
      ['Was kostet Parken im absoluten Halteverbot?',
       `Parken im absoluten Halteverbot (Zeichen 283) kostet laut Katalog ${euroText('141312')}, mit Behinderung ${euroText('141313')}.`],
      ['Was kostet Parken auf dem Radweg?',
       `Parken auf einem Radweg oder Radfahrstreifen (Zeichen 237) kostet ${euroText('141174')}, mit Behinderung ${euroText('141775')}.`],
      ['Was kostet Parken in der Feuerwehrzufahrt?',
       `Parken in einer amtlich gekennzeichneten Feuerwehrzufahrt kostet ${euroText('112216')}; wird ein Rettungsfahrzeug im Einsatz behindert, ${euroText('112612')}.`],
      ['Gibt es für Falschparken Punkte in Flensburg?',
       'In der Regel nicht. Punkte gibt es nur bei schwereren Parkverstößen, etwa wenn Rettungsfahrzeuge im Einsatz behindert werden oder andere gefährdet werden; ab 60 € wird ein Verstoß ins Fahreignungsregister eingetragen, sofern der Katalog Punkte vorsieht.'],
      ['Was ist der Unterschied zwischen Verwarnungsgeld und Bußgeld?',
       'Bis 55 € spricht man von einem Verwarnungsgeld, darüber von einem Bußgeld mit Bußgeldbescheid; dann kommen Gebühren und Auslagen hinzu.'],
      ['Wo kann ich Falschparker melden?',
       'Beim Ordnungsamt der Stadt, in der der Verstoß passiert ist – akut per Telefon, sonst als Anzeige mit Fotos. Mit dem OWiA-Anzeiger geht das kostenlos online.'],
    ]
    return reply.view('/ratgeber/katalog.ejs', basis(request, {
      title: 'Bußgeldkatalog Parken',
      pageTitle: `Bußgeldkatalog Parken & Halten ${jahr}: alle Bußgelder mit TBNR`,
      metaDescription:
        `Bußgeldkatalog fürs Falschparken ${jahr}: alle ${anzahl} Tatbestände zum Parken und Halten mit Regelsatz – Gehweg, Radweg, Halteverbot, Feuerwehrzufahrt, Parkschein. Durchsuchbar.`,
      canonical: `${appUrl()}${KATALOG_PFAD}`,
      gruppen: KATALOG_GRUPPEN,
      anzahl,
      jahr,
      katalogStand: KATALOG_STAND,
      faq,
    }))
  })
}
