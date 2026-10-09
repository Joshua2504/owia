import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth, setFlash, flashRedirect, viewData } from '../middleware/auth'
import { getCity } from '../config/cities'
import {
  STICKER_DEFAULT_VORLAGE, STICKER_LOESEN_MINUTEN, STICKER_MAX_SEITEN, STICKER_VORLAGEN,
  LINK_MELDUNG, StickerLayout, batchCodes, createBatch, formatCode, linkCode, loadBatch,
  normalizeCode, openCodeCount, openSheetCount, parseLayout, perPage, renderBatchPdf, renderCalibrationPdf,
  unlinkCode, voidOpenCodes, AUFDRUCK_MAX, formatEuro, geldArt,
  STICKER_PDF_TEIL, entwurfFavoriten, vorschauSvg,
} from '../services/stickers'
import { VERSTOESSE, VERSTOSS_HAEUFIG, regelsatzEuro, tbnrAusLabel, verstossText } from '../config/verstoss'
import { ENTWUERFE, brauchtBetrag, entwurf, entwurfNr } from '../services/stickerEntwuerfe'
import { appUrl } from '../config/app'

/** Auswahl für Fall-Sticker: alle Tatbestände mit Regelsatz, häufige oben. */
type StickerVerstoss = { tbnr: string; text: string; euro: number; betrag: string }
const STICKER_VERSTOESSE: StickerVerstoss[] = VERSTOESSE.flatMap((v) => {
  const euro = regelsatzEuro(v.tbnr)
  return euro === null ? [] : [{ tbnr: v.tbnr, text: v.text, euro, betrag: formatEuro(euro) }]
})
const STICKER_HAEUFIG: StickerVerstoss[] = VERSTOSS_HAEUFIG
  .map((l) => STICKER_VERSTOESSE.find((v) => v.tbnr === tbnrAusLabel(l)))
  .filter((v): v is StickerVerstoss => !!v)

// QR-Sticker (Konzept: services/stickers.ts).
//   /sticker            Bögen erzeugen, herunterladen, Reste entwerten (eingeloggt)
//   /S/<code>           Ziel des QR-Codes – öffentlich; für den Besitzer zugleich
//                       die Verknüpfungsseite, solange der Code offen ist
//   /anzeige/:az/sticker  Verknüpfen aus der Anzeige heraus (Scanner/Eingabe)
//
// Öffentlich gezeigt wird nur, was auch die Übersichtskarte (routes/public.ts)
// zeigt: Verstoßart, Tattag, Stadt, Status und ein stark verpixeltes Foto.
// Kein Kennzeichen, kein Aktenzeichen, keine Uhrzeit, kein Adresstext, nichts
// über die anzeigende Person – der Aufkleber verrät schon genug darüber, dass
// jemand vor Ort war.

/** Vorschlag fürs Formular: Format + Druckversatz des letzten Batches. */
async function lastLayout(userId: number): Promise<StickerLayout> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT layout FROM sticker_batches WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  )
  if (rows[0]) return JSON.parse(rows[0].layout) as StickerLayout
  return parseLayout({ vorlage: STICKER_DEFAULT_VORLAGE }) as StickerLayout
}

/** Nach dem Verknüpfen/Lösen dorthin zurück, wo der Nutzer herkam – aber nur
 *  auf eigene Pfade (kein Open Redirect). */
function backTo(request: FastifyRequest, fallback: string): string {
  const zurueck = String((request.body as { zurueck?: string } | undefined)?.zurueck || '')
  return /^\/(anzeige\/OWiA-\d{6}|S\/[0-9A-Z]{8}|sticker)$/.test(zurueck) ? zurueck : fallback
}

export default async function stickerRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Verwaltung
  // -------------------------------------------------------------------------
  app.get('/sticker', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [batches] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT b.id, b.seiten, b.layout, DATE_FORMAT(b.created_at, '%d.%m.%Y %H:%i') AS erstellt,
              COUNT(c.code) AS gesamt,
              SUM(c.linked_at IS NOT NULL) AS verknuepft,
              SUM(c.linked_at IS NULL AND c.voided_at IS NULL) AS offen,
              SUM(c.linked_at IS NULL AND c.voided_at IS NOT NULL) AS entwertet,
              COALESCE(SUM(c.scan_count), 0) AS scans
         FROM sticker_batches b
         LEFT JOIN sticker_codes c ON c.batch_id = b.id
        WHERE b.user_id = ?
        GROUP BY b.id
        ORDER BY b.id DESC`,
      [userId]
    )
    const [linked] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT c.code, c.scan_count, r.aktenzeichen, r.kennzeichen,
              DATE_FORMAT(c.linked_at, '%d.%m.%Y %H:%i') AS verknuepft_fmt,
              DATE_FORMAT(c.last_scan_at, '%d.%m.%Y %H:%i') AS letzter_scan,
              c.linked_at > DATE_SUB(NOW(), INTERVAL ? MINUTE) AS loesbar
         FROM sticker_codes c
         LEFT JOIN reports r ON r.id = c.report_id AND r.status <> 'papierkorb'
        WHERE c.user_id = ? AND c.linked_at IS NOT NULL
        ORDER BY c.linked_at DESC
        LIMIT 50`,
      [STICKER_LOESEN_MINUTEN, userId]
    )
    const vorlagenName = (l: StickerLayout) =>
      STICKER_VORLAGEN.find((v) => v.id === l.vorlage)?.name ||
      `Eigenes Format · ${l.cols * l.rows} pro Bogen · ${l.labelW} × ${l.labelH} mm`
    const fallText = (l: StickerLayout) => {
      if (!l.tbnr) return null
      const euro = regelsatzEuro(l.tbnr)
      const text = l.entwurf ? verstossText(l.tbnr) : l.aufdruck
      return `${text}${euro === null ? '' : ` · ${geldArt(euro)} ${formatEuro(euro)}`}`
    }
    const textName = (l: StickerLayout) => {
      const e = entwurf(l.entwurf)
      return e ? `Vorlage ${String(entwurfNr(e.slug)).padStart(2, '0')} · ${e.name}` : 'Klassischer Text'
    }
    const offeneBoegen = await openSheetCount(userId)
    const favoriten = await entwurfFavoriten(userId)
    const layout = await lastLayout(userId)
    // Vorauswahl: Link aus /sticker-test (?entwurf=…), sonst die zuletzt
    // benutzte Vorlage, sonst der erste Favorit, sonst klassischer Text.
    const gewuenscht = entwurf(String((request.query as { entwurf?: string }).entwurf || ''))
    const ersterFavorit = ENTWUERFE.find((e) => favoriten.has(e.slug))
    layout.entwurf = gewuenscht?.slug || (entwurf(layout.entwurf) ? layout.entwurf : ersterFavorit?.slug || null)
    const entwuerfe = ENTWUERFE.map((e, i) => ({
      nr: i + 1, slug: e.slug, name: e.name, fest: e.tbnr || null, betrag: brauchtBetrag(e), favorit: favoriten.has(e.slug),
    }))
    return reply.view('/sticker/index.ejs', viewData(request, {
      title: 'Sticker',
      batches: batches.map((b) => {
        const layout = JSON.parse(b.layout) as StickerLayout
        return {
          ...b, layout, vorlageName: vorlagenName(layout), textName: textName(layout), fall: fallText(layout),
          offen: Number(b.offen || 0), teile: Math.ceil(Number(b.seiten) / STICKER_PDF_TEIL),
        }
      }),
      linked: linked.map((l) => ({ ...l, codeFmt: formatCode(l.code), loesbar: Number(l.loesbar) === 1 })),
      offen: await openCodeCount(userId),
      layout,
      entwuerfe,
      pdfTeil: STICKER_PDF_TEIL,
      vorlagen: STICKER_VORLAGEN,
      maxSeiten: STICKER_MAX_SEITEN,
      freieSeiten: Math.max(0, STICKER_MAX_SEITEN - offeneBoegen),
      offeneBoegen,
      verstoesse: STICKER_VERSTOESSE,
      haeufig: STICKER_HAEUFIG,
      aufdruckMax: AUFDRUCK_MAX,
      loesenMinuten: STICKER_LOESEN_MINUTEN,
    }))
  })

  app.post('/sticker/erzeugen', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const userId = request.session.userId as number
    const body = (request.body || {}) as Record<string, unknown>
    const layout = parseLayout(body)
    if (typeof layout === 'string') {
      return flashRedirect(reply, 'error', layout, '/sticker')
    }
    const seiten = Number(body.seiten)
    const result = await createBatch(userId, layout, seiten)
    if ('error' in result) {
      return flashRedirect(reply, 'error', result.error, '/sticker')
    }
    return flashRedirect(reply, 'success',
      `${seiten * perPage(layout)} Sticker auf ${seiten} ${seiten === 1 ? 'Bogen' : 'Bögen'} erzeugt – jetzt das PDF herunterladen und drucken` +
      (seiten > STICKER_PDF_TEIL ? ` (in Teilen zu je ${STICKER_PDF_TEIL} Bögen).` : '.'), `/sticker#batch-${result.batchId}`)
  })

  // PDF eines Batches – immer dieselben Codes, beliebig oft. Druckversatz und
  // Rahmen lassen sich beim Download ändern und werden am Batch gemerkt (und
  // damit für den nächsten Batch vorgeschlagen).
  // Layout-Änderung (Versatz/Rahmen) nur per POST – ein GET darf nichts
  // speichern (Link-Vorschauen, Browser-Prefetch). Der GET liefert das PDF mit
  // dem gemerkten Layout.
  const stickerPdf = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.session.userId as number
    const batch = await loadBatch(userId, Number((request.params as { id: string }).id))
    if (!batch) return reply.status(404).send('Nicht gefunden.')
    const q = (request.method === 'POST' ? request.body || {} : {}) as Record<string, unknown>
    let layout = batch.layout
    if ('dx' in q || 'dy' in q) {
      // Ohne Haken fehlt „rahmen" im Query ganz – dann gilt er als abgewählt.
      const next = parseLayout({ ...layout, dx: q.dx, dy: q.dy, rahmen: q.rahmen ?? '' })
      if (typeof next !== 'string') {
        layout = { ...layout, dx: next.dx, dy: next.dy, rahmen: next.rahmen }
        await pool.execute('UPDATE sticker_batches SET layout = ? WHERE id = ?', [JSON.stringify(layout), batch.id])
      }
    }
    // Große Batches in Teilen zu STICKER_PDF_TEIL Bögen (Teil 1 = Standard),
    // damit ein Download nur wenige Sekunden rechnet.
    const teile = Math.ceil(batch.seiten / STICKER_PDF_TEIL)
    const teil = Math.min(teile, Math.max(1, Math.floor(Number((request.query as { teil?: string }).teil ?? q.teil ?? 1)) || 1))
    const proTeil = STICKER_PDF_TEIL * perPage(layout)
    const codes = (await batchCodes(batch.id)).slice((teil - 1) * proTeil, teil * proTeil)
    const pdf = await renderBatchPdf(codes, layout, appUrl(request))
    const name = teile > 1 ? `owia-sticker-${batch.id}-teil-${teil}-von-${teile}.pdf` : `owia-sticker-${batch.id}.pdf`
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${name}"`)
      .send(Buffer.from(pdf))
  }
  app.get('/sticker/:id/sticker.pdf', { preHandler: requireAuth }, stickerPdf)
  app.post('/sticker/:id/sticker.pdf', { preHandler: requireAuth }, stickerPdf)

  // Vorschau der gewählten Textvorlage im gewählten Format (Formular /sticker).
  app.get('/sticker/vorschau.svg', { preHandler: requireAuth }, async (request, reply) => {
    const layout = parseLayout(request.query as Record<string, unknown>)
    const svg = typeof layout === 'string' ? null : await vorschauSvg(layout, appUrl(request))
    if (!svg) return reply.status(404).send('Keine Vorschau.')
    return reply.header('Content-Type', 'image/svg+xml; charset=utf-8').header('Cache-Control', 'private, max-age=300').send(svg)
  })

  app.get('/sticker/kalibrierung.pdf', { preHandler: requireAuth }, async (request, reply) => {
    const layout = parseLayout(request.query as Record<string, unknown>)
    if (typeof layout === 'string') return reply.status(400).send(layout)
    const pdf = await renderCalibrationPdf(layout, appUrl(request))
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="owia-sticker-testseite.pdf"')
      .send(Buffer.from(pdf))
  })

  app.post('/sticker/:id/entwerten', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const n = await voidOpenCodes(userId, Number((request.params as { id: string }).id))
    return flashRedirect(reply, 'success', n ? `${n} offene Sticker entwertet.` : 'Keine offenen Sticker in diesem Batch.', '/sticker')
  })

  // -------------------------------------------------------------------------
  // Verknüpfen
  // -------------------------------------------------------------------------

  // Aus der Anzeige: Code per Scanner (public/js/sticker-scan.js) oder abgetippt.
  app.post('/anzeige/:az/sticker', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const { az } = request.params as { az: string }
    const back = `/anzeige/${az}`
    const code = normalizeCode((request.body as { code?: string } | undefined)?.code)
    if (!code) {
      return flashRedirect(reply, 'error', 'Das ist kein gültiger Sticker-Code (8 Zeichen, z. B. 7KQ2-XM9P).', back)
    }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM reports WHERE aktenzeichen = ? AND user_id = ?',
      [az, userId]
    )
    const result = rows[0] ? await linkCode(userId, code, Number(rows[0].id)) : 'anzeige'
    if (result === 'ok') setFlash(reply, 'success', `Sticker ${formatCode(code)} ist jetzt mit dieser Anzeige verknüpft.`)
    else setFlash(reply, 'error', LINK_MELDUNG[result])
    return reply.redirect(back)
  })

  // Von der Sticker-Seite aus (Kamera-Scan → /S/<code> → Anzeige wählen).
  app.post('/S/:code/verknuepfen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const code = normalizeCode((request.params as { code: string }).code)
    if (!code) return reply.status(404).send('Nicht gefunden.')
    const reportId = Number((request.body as { report?: string } | undefined)?.report)
    const result = await linkCode(userId, code, reportId)
    if (result === 'ok') setFlash(reply, 'success', 'Sticker verknüpft – du kannst ihn jetzt aufkleben.')
    else setFlash(reply, 'error', LINK_MELDUNG[result])
    return reply.redirect(`/S/${code}`)
  })

  app.post('/S/:code/loesen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const code = normalizeCode((request.params as { code: string }).code)
    if (!code) return reply.status(404).send('Nicht gefunden.')
    const ok = await unlinkCode(userId, code)
    return flashRedirect(reply, ok ? 'success' : 'error', ok
      ? `Verknüpfung von Sticker ${formatCode(code)} gelöst – er ist wieder frei.`
      : `Die Verknüpfung lässt sich nur in den ersten ${STICKER_LOESEN_MINUTEN} Minuten lösen.`, backTo(request, `/S/${code}`))
  })

  // -------------------------------------------------------------------------
  // Öffentliche Sticker-Seite
  // -------------------------------------------------------------------------
  const showSticker = async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = (request.params as { code: string }).code
    const code = normalizeCode(raw)
    // Nicht indexieren (robots.txt sperrt /S/ ohnehin, Header als Absicherung).
    reply.header('X-Robots-Tag', 'noindex, nofollow')
    // Kanonische Schreibweise, damit Abtipper mit Kleinbuchstaben/Bindestrich
    // dieselbe Seite (und dieselben Verknüpfungs-Formulare) bekommen.
    if (code && raw !== code) return reply.redirect(`/S/${code}`, 301)

    const userId = request.session.userId
    const [rows] = code
      ? await pool.execute<mysql.RowDataPacket[]>(
        `SELECT c.code, c.user_id, c.report_id, c.linked_at, c.voided_at, c.scan_count,
                c.linked_at > DATE_SUB(NOW(), INTERVAL ? MINUTE) AS loesbar,
                r.status, r.verstoss_art, r.city, r.aktenzeichen,
                DATE_FORMAT(r.tattag, '%d.%m.%Y') AS tattag_fmt,
                DATE_FORMAT(r.eingereicht_at, '%d.%m.%Y') AS eingereicht_fmt,
                (SELECT DATE_FORMAT(MIN(rr.received_at), '%d.%m.%Y') FROM report_replies rr
                  WHERE rr.report_id = r.id AND rr.direction = 'out') AS versendet_fmt,
                (SELECT ri.id FROM report_images ri WHERE ri.report_id = r.id
                  ORDER BY ri.sort_order, ri.id LIMIT 1) AS image_id
           FROM sticker_codes c
           LEFT JOIN reports r ON r.id = c.report_id
          WHERE c.code = ?`,
        [STICKER_LOESEN_MINUTEN, code]
      )
      : [[] as mysql.RowDataPacket[]]
    const row = rows[0]
    const isOwner = !!row && !!userId && Number(row.user_id) === userId

    // Öffentlich ist eine Anzeige erst ab Einreichung (Entwürfe können noch
    // verworfen werden, der Papierkorb sowieso).
    const oeffentlich = !!row && (row.status === 'eingereicht' || row.status === 'versendet')

    // Zählen nur echte Aufrufe von Menschen: Link-Vorschauen (Messenger,
    // Mail-Clients) und Crawler melden sich meist per User-Agent oder kommen
    // ohne Navigations-Fetch-Metadaten – sie machten die Scan-Zahl wertlos.
    const ua = String(request.headers['user-agent'] || '')
    const mode = String(request.headers['sec-fetch-mode'] || 'navigate')
    const bot = /bot|crawl|spider|preview|fetch|curl|wget|python|slurp|facebookexternalhit|whatsapp|telegram|discord|slack|skype|linkpreview|headless/i.test(ua)
    if (row && row.linked_at && !isOwner && mode === 'navigate' && !bot) {
      await pool.execute(
        'UPDATE sticker_codes SET scan_count = scan_count + 1, last_scan_at = NOW() WHERE code = ?',
        [row.code]
      )
    }

    let eigeneAnzeigen: mysql.RowDataPacket[] = []
    if (isOwner && !row.linked_at && !row.voided_at) {
      ;[eigeneAnzeigen] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, aktenzeichen, kennzeichen, verstoss_art, status,
                DATE_FORMAT(tattag, '%d.%m.%Y') AS tattag_fmt,
                DATE_FORMAT(created_at, '%d.%m. %H:%i') AS erstellt_fmt
           FROM reports
          WHERE user_id = ? AND status <> 'papierkorb'
          ORDER BY created_at DESC, id DESC
          LIMIT 15`,
        [userId]
      )
    }

    // Sticker kleben meist schon, bevor die Anzeige abgeschickt ist: verknüpfte
    // Entwürfe zeigen daher „wird vorbereitet" (ohne Details), statt so zu tun,
    // als gäbe es nichts. Papierkorb/gelöscht → „leer".
    const zustand = !row ? 'unbekannt'
      : !row.linked_at ? (row.voided_at ? 'entwertet' : 'offen')
      : oeffentlich ? 'oeffentlich'
      : row.status === 'entwurf' ? 'vorbereitung' : 'leer'

    return reply.view('/sticker/show.ejs', viewData(request, {
      title: 'Anzeige wegen Falschparkens',
      code,
      codeFmt: code ? formatCode(code) : null,
      zustand,
      isOwner,
      loggedIn: !!userId,
      eigeneAnzeigen,
      loesbar: isOwner && Number(row?.loesbar) === 1,
      loesenMinuten: STICKER_LOESEN_MINUTEN,
      scans: Number(row?.scan_count || 0),
      // Besitzer-Infos (nur für ihn gerendert)
      aktenzeichen: isOwner ? row?.aktenzeichen || null : null,
      reportStatus: isOwner ? row?.status || null : null,
      // Öffentliche Angaben
      anzeige: oeffentlich ? {
        verstossArt: row.verstoss_art || null,
        tattag: row.tattag_fmt || null,
        stadt: getCity(row.city).name,
        behoerde: getCity(row.city).ordnungsamt,
        status: row.status,
        eingereicht: row.eingereicht_fmt || null,
        versendet: row.versendet_fmt || null,
        // Das verpixelte Bild liefert /api/public/bild/... nur für versendete Anzeigen.
        bildUrl: row.status === 'versendet' && row.image_id ? `/api/public/bild/${row.image_id}/pixel.jpg` : null,
      } : null,
    }))
  }

  // Der QR-Code enthält „/S/" in Großbuchstaben (alphanumerischer QR-Modus,
  // siehe services/stickers.ts); Abtipper landen eher auf „/s/".
  const limit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }
  app.get('/S/:code', limit, showSticker)
  app.get('/s/:code', limit, async (request, reply) =>
    reply.redirect(`/S/${encodeURIComponent((request.params as { code: string }).code)}`, 301)
  )
}
