// Sammelaktionen der Anzeigen-Liste: Sammelbearbeitung (Katalog, Vorschau,
// Speichern), Sammel-Löschen, Papierkorb und Zusammenführen von Doppel-Anzeigen.
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../../db/connection'
import { requireAuth, viewData, setFlash } from '../../middleware/auth'
import { VERSTOSS_ARTEN } from '../../config/verstoss'
import { FAHRZEUG_TYPEN, FAHRZEUG_MARKEN, FAHRZEUG_FARBEN } from '../../config/fahrzeug'
import { deleteDraft, trashDrafts, restoreDrafts, purgeTrash, PAPIERKORB_TAGE } from '../../services/drafts'
import { previewBulkEdit, applyBulkEdit, BulkEditInputError } from '../../services/bulkEdit'
import { loadReportByAktenzeichen, FORMULAR_HILFEN, mostUsedVerstoesse, enqueuePdf } from './shared'
import { moveImages } from './images'

export default async function bulkRoutes(app: FastifyInstance) {
  // Verstoß-Katalog für Sammelbearbeitung und Inline-Bearbeitung der Liste
  // (lazy geladen, statt den ~55 KB-Katalog in jede Listenseite einzubetten).
  app.get('/anzeigen/bearbeitungsoptionen', { preHandler: requireAuth }, async () => ({
    offenses: VERSTOSS_ARTEN,
    frequent: await mostUsedVerstoesse(),
    ...FORMULAR_HILFEN,
    fahrzeugTypen: FAHRZEUG_TYPEN,
    marken: FAHRZEUG_MARKEN,
    farben: FAHRZEUG_FARBEN,
  }))
  app.post('/anzeigen/sammelbearbeitung/vorschau', { preHandler: requireAuth }, async (request, reply) => {
    try {
      return await previewBulkEdit(request.session.userId as number, (request.body || {}) as Record<string, unknown>)
    } catch (error) {
      if (error instanceof BulkEditInputError) return reply.status(400).send({ error: error.message })
      request.log.error(error, 'Sammelbearbeitung: Vorschau fehlgeschlagen')
      return reply.status(500).send({ error: 'Vorschau fehlgeschlagen. Bitte erneut versuchen.' })
    }
  })
  app.post('/anzeigen/sammelbearbeitung/speichern', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const results = await applyBulkEdit(request.session.userId as number, (request.body as { token?: unknown })?.token)
      return { results }
    } catch (error) {
      if (error instanceof BulkEditInputError) return reply.status(400).send({ error: error.message })
      request.log.error(error, 'Sammelbearbeitung fehlgeschlagen')
      return reply.status(500).send({ error: 'Speichern fehlgeschlagen. Bitte erneut prüfen.' })
    }
  })

  // Sammel-Löschen angehakter Entwürfe (Mehrfachauswahl in der Anzeigen-Tabelle):
  // verschiebt in den Papierkorb. Nur eigene Entwürfe – eingereichte/versendete
  // Anzeigen fallen durch den status-Filter still heraus.
  app.post('/anzeigen/loeschen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const body = (request.body || {}) as { az?: string | string[] }
    const azList = (Array.isArray(body.az) ? body.az : body.az ? [body.az] : [])
      .map((a) => String(a))
      .filter(Boolean)
      .slice(0, 200)

    if (azList.length === 0) {
      setFlash(reply, 'error', 'Keine Entwürfe ausgewählt.')
      return reply.redirect('/anzeigen')
    }

    const placeholders = azList.map(() => '?').join(',')
    const [drafts] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, aktenzeichen, kennzeichen, kennzeichen_land, tatort, pdf_filename,
              DATE_FORMAT(tattag, '%d.%m.%Y') AS tattag_fmt,
              (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = reports.id) AS image_count
         FROM reports
        WHERE aktenzeichen IN (${placeholders}) AND user_id = ? AND status = 'entwurf'
        ORDER BY tattag, tatzeit_von, id`,
      [...azList, userId]
    )
    if (drafts.length === 0) {
      setFlash(reply, 'error', 'Keine löschbaren Entwürfe in der Auswahl.')
      return reply.redirect('/anzeigen')
    }

    await trashDrafts(userId, drafts.map((d) => d.id))
    setFlash(reply, 'success', `${drafts.length} ${drafts.length === 1 ? 'Entwurf' : 'Entwürfe'} in den Papierkorb verschoben.`)
    return reply.redirect('/anzeigen')
  })

  // Papierkorb: gelöschte Entwürfe, wiederherstellbar bis zum automatischen
  // Leeren nach PAPIERKORB_TAGE Tagen (server.ts).
  app.get('/papierkorb', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [items] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, aktenzeichen, kennzeichen, tatort, verstoss_art,
              DATE_FORMAT(tattag, '%d.%m.%Y') AS tattag_fmt,
              DATE_FORMAT(papierkorb_at, '%d.%m.%Y %H:%i') AS geloescht_fmt,
              DATE_FORMAT(DATE_ADD(papierkorb_at, INTERVAL ? DAY), '%d.%m.%Y') AS endgueltig_fmt,
              (SELECT MIN(ri.id) FROM report_images ri WHERE ri.report_id = reports.id) AS thumb_id,
              (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = reports.id) AS image_count
         FROM reports
        WHERE user_id = ? AND status = 'papierkorb'
        ORDER BY papierkorb_at DESC, id DESC`,
      [PAPIERKORB_TAGE, userId]
    )
    return reply.view('/reports/papierkorb.ejs', viewData(request, {
      title: 'Papierkorb',
      items,
      tage: PAPIERKORB_TAGE,
    }))
  })

  // Wiederherstellen bzw. endgültig löschen (einzelne az oder alle).
  app.post('/papierkorb/:aktion', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const { aktion } = request.params as { aktion: string }
    const body = (request.body || {}) as { az?: string | string[]; alle?: string }
    const azList = (Array.isArray(body.az) ? body.az : body.az ? [body.az] : []).map(String).slice(0, 500)
    let ids: number[] = []
    if (azList.length) {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM reports WHERE aktenzeichen IN (${azList.map(() => '?').join(',')})
            AND user_id = ? AND status = 'papierkorb'`,
        [...azList, userId]
      )
      ids = rows.map((r) => Number(r.id))
    }
    const n = (k: number) => (k === 1 ? '1 Entwurf' : `${k} Entwürfe`)
    if (aktion === 'wiederherstellen') {
      const k = await restoreDrafts(userId, ids)
      setFlash(reply, 'success', `${n(k)} wiederhergestellt.`)
    } else if (aktion === 'loeschen') {
      const k = await purgeTrash(body.alle === '1' ? { userId } : { userId, reportIds: ids })
      setFlash(reply, 'success', `${n(k)} endgültig gelöscht.`)
    } else {
      return reply.status(404).send('Unbekannte Aktion.')
    }
    return reply.redirect('/papierkorb')
  })

  // Mögliche Doppel-Anzeigen zusammenführen (Hinweis in der Anzeigen-Liste,
  // s. services/duplicates.ts): alle Fotos der übrigen Entwürfe wandern in den
  // gewählten Ziel-Entwurf, leere Felder des Ziels werden aus ihnen ergänzt,
  // der Tatzeitraum ggf. erweitert; danach werden die Quell-Entwürfe gelöscht.
  app.post('/anzeigen/zusammenfuehren', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const body = (request.body || {}) as { az?: string | string[]; target?: string; back?: string }
    const back = typeof body.back === 'string' && /^\/(anzeigen|import\/\d+)$/.test(body.back) ? body.back : '/anzeigen'
    const azList = [...new Set((Array.isArray(body.az) ? body.az : body.az ? [body.az] : []).map(String))].slice(0, 20)
    const targetAz = String(body.target || '')
    if (!azList.includes(targetAz) || azList.length < 2) {
      setFlash(reply, 'error', 'Bitte mindestens zwei Entwürfe und ein Ziel wählen.')
      return reply.redirect(back)
    }
    const target = await loadReportByAktenzeichen(targetAz, userId)
    if (!target || target.status !== 'entwurf' || target.versand_status !== null) {
      setFlash(reply, 'error', 'Ziel-Anzeige ist kein Entwurf.')
      return reply.redirect(back)
    }

    let merged = 0
    for (const az of azList) {
      if (az === targetAz) continue
      const source = await loadReportByAktenzeichen(az, userId)
      if (!source || source.status !== 'entwurf' || source.versand_status !== null) continue
      const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT id FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
        [source.id]
      )
      if (imgs.length) {
        const res = await moveImages(userId, az, imgs.map((i) => Number(i.id)), { targetAz })
        if (res.status !== 200) {
          setFlash(reply, 'error', `${az}: ${String(res.body.error || 'Zusammenführen fehlgeschlagen.')}`)
          return reply.redirect(back)
        }
      }
      // Leere Felder des Ziels ergänzen; am selben Tag den Zeitraum erweitern.
      await pool.execute(
        `UPDATE reports t JOIN reports s ON s.id = ? AND s.user_id = t.user_id
            SET t.kennzeichen = COALESCE(NULLIF(t.kennzeichen, ''), s.kennzeichen),
                t.fahrzeug_marke = COALESCE(NULLIF(t.fahrzeug_marke, ''), s.fahrzeug_marke),
                t.fahrzeug_typ = COALESCE(t.fahrzeug_typ, s.fahrzeug_typ),
                t.fahrzeug_modell = COALESCE(NULLIF(t.fahrzeug_modell, ''), s.fahrzeug_modell),
                t.fahrzeug_farbe = COALESCE(NULLIF(t.fahrzeug_farbe, ''), s.fahrzeug_farbe),
                t.tatort = COALESCE(NULLIF(t.tatort, ''), s.tatort),
                t.tatort_lat = COALESCE(t.tatort_lat, s.tatort_lat),
                t.tatort_lon = COALESCE(t.tatort_lon, s.tatort_lon),
                t.verstoss_art = COALESCE(NULLIF(t.verstoss_art, ''), s.verstoss_art),
                t.beschreibung = COALESCE(NULLIF(t.beschreibung, ''), s.beschreibung),
                t.behinderung_text = COALESCE(NULLIF(t.behinderung_text, ''), s.behinderung_text),
                t.tatzeit_bis = IF(t.tattag <=> s.tattag AND t.tatzeit_von IS NOT NULL AND s.tatzeit_von IS NOT NULL,
                                   GREATEST(COALESCE(t.tatzeit_bis, t.tatzeit_von), COALESCE(s.tatzeit_bis, s.tatzeit_von)),
                                   t.tatzeit_bis),
                t.tatzeit_von = IF(t.tattag <=> s.tattag AND t.tatzeit_von IS NOT NULL AND s.tatzeit_von IS NOT NULL,
                                   LEAST(t.tatzeit_von, s.tatzeit_von), COALESCE(t.tatzeit_von, s.tatzeit_von)),
                t.tattag = COALESCE(t.tattag, s.tattag)
          WHERE t.id = ? AND t.user_id = ?`,
        [source.id, target.id, userId]
      )
      await deleteDraft(userId, { id: source.id, pdf_filename: source.pdf_filename })
      merged++
    }
    await enqueuePdf(target.id, userId)
    setFlash(reply, 'success', merged
      ? `${merged + 1} Entwürfe in ${targetAz} zusammengeführt.`
      : 'Nichts zusammengeführt.')
    return reply.redirect(back)
  })
}
