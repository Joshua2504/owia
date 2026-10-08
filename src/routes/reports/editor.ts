// Anzeigen-Editor und Detailseite: Entwurf anlegen/bearbeiten/speichern,
// Autosave und Inline-Felder, Tatzeit/Tatort aus Fotos, Listenzeile, Detail-
// ansicht mit Nachrichtenverlauf ans Ordnungsamt und Anhang-Download.
import { isVerjaehrt, verjaehrung } from '../../services/verjaehrung'
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import ejs from 'ejs'
import { pool } from '../../db/connection'
import { requireAuth, viewData, setFlash } from '../../middleware/auth'
import { getCity, unlockedCities } from '../../config/cities'
import { STICKER_LOESEN_MINUTEN, formatCode } from '../../services/stickers'
import { cityEmail, detectCityByLabel } from '../../services/districts'
import { reverseGeocode } from '../../services/geocode'
import { VERSTOSS_ARTEN } from '../../config/verstoss'
import { FAHRZEUG_TYPEN, FAHRZEUG_MARKEN, FAHRZEUG_FARBEN, DEFAULT_FAHRZEUG_TYP, KENNZEICHEN_LAENDER } from '../../config/fahrzeug'
import { imageVersion } from '../../services/images'
import { createDraft, trashDrafts } from '../../services/drafts'
import { replyAttachmentPath } from '../../services/mailInbox'
import { MailService } from '../../services/mail'
import { verstossGesperrt } from '../../services/portale'
import { loadReportByAktenzeichen, loadQueueContext, FORMULAR_HILFEN, VERSTOSS_SPERREN, strukturFelder, persistFields, normalizePlate, isComplete, mostUsedVerstoesse, isProfileComplete, enqueuePdf, istDatum, istUhrzeit } from './shared'

export default async function editorRoutes(app: FastifyInstance) {
  // Eigene, noch nicht versendete Anzeigen (Entwürfe) mit Koordinaten – für die
  // Karte im Dashboard. Versendete erscheinen bereits (anonym) über die
  // öffentliche Übersicht, daher hier ausgenommen.
  app.get('/api/my/reports', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT aktenzeichen, status, tattag, verstoss_art, tatort, tatort_lat, tatort_lon,
              (SELECT ri.id FROM report_images ri
                WHERE ri.report_id = reports.id ORDER BY ri.sort_order, ri.id LIMIT 1) AS image_id
         FROM reports
        WHERE user_id = ? AND status <> 'versendet'
          AND tatort_lat IS NOT NULL AND tatort_lon IS NOT NULL
          -- 0/0 = Altbestand ohne echten Tatort (s. coord() weiter unten),
          -- würde als Marker im Golf von Guinea landen.
          AND tatort_lat <> 0 AND tatort_lon <> 0
        ORDER BY created_at DESC`,
      [userId]
    )
    const reports = rows.map((r) => ({
      lat: Number(r.tatort_lat),
      lon: Number(r.tatort_lon),
      aktenzeichen: r.aktenzeichen,
      status: r.status,
      verstossArt: r.verstoss_art || null,
      tattag: r.tattag || null,
      tatort: r.tatort || null,
      url: `/anzeige/${r.aktenzeichen}/bearbeiten`,
      imageUrl: r.image_id ? `/anzeige/${r.aktenzeichen}/image/${r.image_id}/thumb.jpg` : null,
    }))
    return reply.send({ reports })
  })

  // ---------------------------------------------------------------------------
  // Entwurf anlegen + bearbeiten
  // ---------------------------------------------------------------------------

  app.post('/anzeige/neu', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const { aktenzeichen } = await createDraft(userId)
    return reply.redirect(`/anzeige/${aktenzeichen}/bearbeiten`)
  })

  app.get('/anzeige/:az/bearbeiten', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/anzeige/${az}`)

    const [imageRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, filename, original_filename, detected_plate, gps_lat, gps_lon,
              DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s') AS captured_at
         FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
      [report.id]
    )
    const images = imageRows.map((i) => ({ ...(i as Record<string, unknown>), id: Number(i.id), v: imageVersion(i.filename) }))
    const firstImageUrl = images.length ? `/anzeige/${az}/image/${images[0].id}/thumb.jpg?v=${images[0].v}` : null

    // Review-Queue des Foto-Imports: "Entwurf X von N" mit Vor/Zurück-Navigation
    // über alle noch offenen Entwürfe desselben Batches.
    const queueParam = Number((request.query as { queue?: string }).queue)
    const queue =
      Number.isInteger(queueParam) && queueParam > 0 && queueParam === report.intake_batch_id
        ? await loadQueueContext(queueParam, userId, az)
        : null

    // Andere offene Entwürfe als Ziel für "Foto verschieben".
    const [otherDrafts] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT aktenzeichen, kennzeichen, tatort,
              DATE_FORMAT(tattag, '%d.%m.%Y') AS tattag_fmt
         FROM reports
        WHERE user_id = ? AND status = 'entwurf' AND id != ?
        ORDER BY id DESC
        LIMIT 50`,
      [userId, report.id]
    )

    return reply.view('/reports/edit.ejs', viewData(request, {
      title: 'Entwurf bearbeiten',
      // Im Editor-Modal der Anzeigen-Liste (report-modal.js): ohne Navigation.
      embed: (request.query as { embed?: string }).embed === '1',
      verstossAlle: VERSTOSS_ARTEN,
      verstossHaeufig: await mostUsedVerstoesse(),
      verstossSperren: VERSTOSS_SPERREN,
      formularHilfen: FORMULAR_HILFEN,
      fahrzeugTypen: FAHRZEUG_TYPEN,
      fahrzeugMarken: FAHRZEUG_MARKEN,
      fahrzeugFarben: FAHRZEUG_FARBEN,
      defaultFahrzeugTyp: DEFAULT_FAHRZEUG_TYP,
      report,
      images,
      city: getCity(report.city),
      // Empfänger-Adressen (aus districts.csv) an die Optionen/den Hinweis hängen.
      cities: unlockedCities().map((c) => ({ ...c, email: cityEmail(c) || '' })),
      cityEmail: cityEmail(getCity(report.city)) || '',
      firstImageUrl,
      queue,
      otherDrafts,
    }))
  })

  // Hintergrund-Autosave der Textfelder (JSON).
  app.patch('/anzeige/:az', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })

    await persistFields(report.id, userId, (request.body || {}) as Record<string, string>)
    return reply.send({ ok: true })
  })

  // Einzelne Felder direkt aus der Anzeigen-Liste ändern (Inline-Bearbeitung in
  // report-row.ejs / public/js/report-inline.js). Anders als PATCH /anzeige/:az
  // (Autosave des Editors, schreibt immer ALLE Felder) nur die übergebenen
  // Felder – sonst würde eine Kennzeichen-Änderung in der Liste den Rest leeren.
  app.patch('/anzeige/:az/felder', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const body = (request.body || {}) as Record<string, unknown>
    const sets: string[] = []
    const values: (string | null)[] = []
    const out: Record<string, string | null> = {}
    if (typeof body.kennzeichen === 'string') {
      out.kennzeichen = normalizePlate(body.kennzeichen)
      sets.push('kennzeichen=?')
      values.push(out.kennzeichen)
    }
    // Länderkennzeichen (Foto-Dialog): nur Kürzel, die die Portale kennen.
    if (typeof body.kennzeichen_land === 'string') {
      const land = body.kennzeichen_land.toUpperCase().replace(/[^A-Z]/g, '') || 'D'
      if (!KENNZEICHEN_LAENDER[land]) return reply.status(400).send({ error: 'Unbekanntes Länderkennzeichen.' })
      out.kennzeichen_land = land
      sets.push('kennzeichen_land=?')
      values.push(land)
    }
    if (typeof body.fahrzeug_marke === 'string') {
      out.fahrzeug_marke = body.fahrzeug_marke.trim().slice(0, 100) || null
      sets.push('fahrzeug_marke=?')
      values.push(out.fahrzeug_marke)
    }
    if (typeof body.tatort === 'string') {
      out.tatort = body.tatort.replace(/\s+/g, ' ').trim().slice(0, 500) || null
      sets.push('tatort=?')
      values.push(out.tatort)
      // Koordinaten nur als gültiges Paar (Adressvorschlag gewählt); sonst
      // bleiben die bisherigen stehen – wie im Editor beim freien Tippen.
      // Gleiche Regel wie coord() in persistFields: 0 und Unsinn sind ungültig.
      const lat = Number(body.tatort_lat)
      const lon = Number(body.tatort_lon)
      if (body.tatort_lat != null && body.tatort_lon != null && Number.isFinite(lat) && Number.isFinite(lon) &&
          lat !== 0 && lon !== 0 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        sets.push('tatort_lat=?', 'tatort_lon=?')
        values.push(String(lat), String(lon))
      }
      // Zuständige Stadt aus der PLZ der Adresse (nur freigeschaltete Städte).
      const det = detectCityByLabel(out.tatort)
      if (det.status === 'unlocked') {
        sets.push('city=?')
        values.push(det.city.id)
      }
    }
    // Tatzeit: leere Werte leeren das Feld, ungültige Formate werden abgewiesen.
    for (const f of ['tattag', 'tattag_bis'] as const) {
      if (typeof body[f] !== 'string') continue
      const v = (body[f] as string).trim()
      if (v && !istDatum(v)) return reply.status(400).send({ error: 'Ungültiges Datum.' })
      out[f] = v || null
      sets.push(`${f}=?`)
      values.push(out[f])
    }
    // tattag_bis nur bei Tatzeitraum über Mitternacht (wie persistFields): gleicher
    // Tag wie tattag = leer. Einzel-UPDATEs werten Zuweisungen von links nach
    // rechts aus – hier stehen also schon die neuen Werte beider Spalten.
    if ('tattag' in out || 'tattag_bis' in out) sets.push('tattag_bis=IF(tattag_bis=tattag, NULL, tattag_bis)')
    for (const f of ['tatzeit_von', 'tatzeit_bis'] as const) {
      if (typeof body[f] !== 'string') continue
      const v = (body[f] as string).trim()
      if (v && !istUhrzeit(v)) return reply.status(400).send({ error: 'Ungültige Uhrzeit.' })
      out[f] = v ? v.slice(0, 5) : null
      sets.push(`${f}=?`)
      values.push(out[f])
    }
    // Häkchen: '1'/true = ja, sonst nein (wie persistFields).
    for (const f of ['behinderung', 'fahrzeug_verlassen'] as const) {
      if (body[f] === undefined) continue
      const on = body[f] === true || body[f] === '1' || body[f] === 1
      out[f] = on ? '1' : '0'
      sets.push(`${f}=?`)
      values.push(out[f])
    }
    if (typeof body.beschreibung === 'string') {
      out.beschreibung = body.beschreibung.trim().slice(0, 5000) || null
      sets.push('beschreibung=?')
      values.push(out.beschreibung)
    }
    // Zuständige Stadt manuell (Prüf-Modus): nur freigeschaltete IDs, wie im Editor.
    if (typeof body.city === 'string') {
      if (!unlockedCities().some((c) => c.id === body.city)) return reply.status(400).send({ error: 'Unbekannte Stadt.' })
      out.city = body.city
      sets.push('city=?')
      values.push(out.city)
    }
    if (typeof body.behinderung_text === 'string') {
      out.behinderung_text = body.behinderung_text.trim().slice(0, 2000) || null
      sets.push('behinderung_text=?')
      values.push(out.behinderung_text)
    }
    if (typeof body.verstoss_art === 'string') {
      const v = body.verstoss_art.trim()
      // Nur Einträge aus dem amtlichen Katalog (wie die Auswahl im Editor).
      if (v && !VERSTOSS_ARTEN.includes(v)) return reply.status(400).send({ error: 'Unbekannter Verstoß.' })
      out.verstoss_art = v || null
      sets.push('verstoss_art=?')
      values.push(out.verstoss_art)
      // Eine Variante gehört zum alten Verstoß (Kreuzung/Einmündung usw.).
      if (typeof body.verstoss_variante !== 'string') {
        out.verstoss_variante = null
        sets.push('verstoss_variante=NULL')
      }
    }
    for (const [k, val] of Object.entries(strukturFelder(body))) {
      out[k] = val
      sets.push(`${k}=?`)
      values.push(val)
    }
    if (out.verstoss_art) {
      // Verstöße, die das Online-Portal der Stadt nicht kennt (Frankfurt), sind
      // nicht wählbar – sonst bliebe die Anzeige unversendbar liegen.
      let city = out.city
      if (city === undefined) {
        const [[row]] = await pool.execute<mysql.RowDataPacket[]>('SELECT city FROM reports WHERE aktenzeichen=? AND user_id=?', [az, userId])
        city = row?.city ?? null
      }
      if (verstossGesperrt(city, out.verstoss_art)) {
        return reply.status(400).send({ error: `Diesen Tatbestand bietet das Online-Portal der Stadt ${getCity(city).name} nicht an – bitte einen anderen Verstoß wählen.` })
      }
    }
    // Kennzeichen bestätigt (Foto-Dialog): Stand von Land + Kennzeichen merken –
    // als letzte Zuweisung, damit sie die neuen Werte desselben PATCH sieht.
    if (typeof body.kennzeichen_bestaetigt === 'boolean') {
      sets.push(body.kennzeichen_bestaetigt
        ? "kennzeichen_bestaetigt=IF(kennzeichen IS NULL OR kennzeichen='', NULL, CONCAT(COALESCE(kennzeichen_land,'D'),'|',kennzeichen))"
        : 'kennzeichen_bestaetigt=NULL')
    }
    if (!sets.length) return reply.status(400).send({ error: 'Keine Änderung übermittelt.' })
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE reports SET ${sets.join(', ')}
        WHERE aktenzeichen=? AND user_id=? AND status='entwurf' AND versand_status IS NULL`,
      [...values, az, userId]
    )
    if (!result.affectedRows) {
      return reply.status(409).send({ error: 'Nur Entwürfe können bearbeitet werden.' })
    }
    return reply.send({ ok: true, values: out })
  })

  // Tatort aus den GPS-Daten der Fotos übernehmen (Button „Tatort fehlt" in
  // der Anzeigen-Liste): erstes Foto mit Koordinaten → Adresse per Photon,
  // zuständige Stadt aus der PLZ. Wie im Editor nur für Entwürfe.
  // Tatzeit aus den Aufnahmezeiten der Fotos übernehmen (Link in der Liste):
  // von = frühestes, bis = spätestes Foto (wie „Uhrzeit aus Fotos" im Editor,
  // report-form.js applyPhotoTimes). Zeitstempel bleiben Strings – kein JS-Date.
  app.post('/anzeige/:az/zeit-aus-fotos', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'Anzeige nicht gefunden.' })
    if (report.status !== 'entwurf' || report.versand_status !== null) {
      return reply.status(409).send({ error: 'Nur Entwürfe können bearbeitet werden.' })
    }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT DATE_FORMAT(MIN(captured_at), '%Y-%m-%d %H:%i:%s') AS von,
              DATE_FORMAT(MAX(captured_at), '%Y-%m-%d %H:%i:%s') AS bis
         FROM report_images WHERE report_id = ? AND captured_at IS NOT NULL`,
      [report.id]
    )
    const von = rows[0]?.von as string | null
    const bis = rows[0]?.bis as string | null
    if (!von || !bis) return reply.status(422).send({ error: 'Die Fotos enthalten keine Aufnahmezeit.' })
    const sameDay = von.slice(0, 10) === bis.slice(0, 10)
    const sameMinute = von.slice(0, 16) === bis.slice(0, 16)
    await pool.execute(
      `UPDATE reports SET tattag=?, tatzeit_von=?, tattag_bis=?, tatzeit_bis=?
        WHERE id=? AND user_id=? AND status='entwurf' AND versand_status IS NULL`,
      [von.slice(0, 10), von.slice(11, 19), sameDay ? null : bis.slice(0, 10), sameMinute ? null : bis.slice(11, 19), report.id, userId]
    )
    return reply.send({ ok: true })
  })

  app.post('/anzeige/:az/tatort-aus-fotos', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'Anzeige nicht gefunden.' })
    if (report.status !== 'entwurf' || report.versand_status !== null) {
      return reply.status(409).send({ error: 'Nur Entwürfe können bearbeitet werden.' })
    }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT gps_lat, gps_lon FROM report_images
        WHERE report_id = ? AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
        ORDER BY sort_order, id LIMIT 1`,
      [report.id]
    )
    if (!rows[0]) return reply.status(422).send({ error: 'Die Fotos enthalten keine Standortdaten.' })
    const lat = Number(rows[0].gps_lat)
    const lon = Number(rows[0].gps_lon)
    const place = await reverseGeocode(lat, lon)
    if (!place?.label) {
      return reply.status(502).send({ error: 'Zu den Foto-Koordinaten wurde keine Adresse gefunden – bitte im Editor eintragen.' })
    }
    const det = detectCityByLabel(place.label)
    await pool.execute(
      `UPDATE reports SET tatort=?, tatort_lat=?, tatort_lon=?, city=COALESCE(?, city)
        WHERE id=? AND user_id=? AND status='entwurf' AND versand_status IS NULL`,
      [place.label, lat, lon, det.status === 'unlocked' ? det.city.id : null, report.id, userId]
    )
    return reply.send({ ok: true, tatort: place.label })
  })

  // „Entwurf speichern": finale Werte sichern, PDF erzeugen, zur Detailseite.
  app.post('/anzeige/:az/save', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/anzeige/${az}`)

    const body = (request.body || {}) as Record<string, string>
    await persistFields(report.id, userId, body)
    // PDF im Hintergrund – gebraucht wird es erst bei Vorschau/Freigabe, und die
    // erzeugen es ohnehin neu.
    await enqueuePdf(report.id, userId)

    // Editor im Modal (Anzeigen-Liste) speichert per fetch und schließt dann.
    if (String(request.headers.accept || '').includes('application/json')) {
      return reply.send({ ok: true })
    }

    // In der Review-Queue des Foto-Imports: direkt zum nächsten offenen Entwurf,
    // nach dem letzten zurück zur Batch-Übersicht.
    const queueId = Number(body.queue)
    if (Number.isInteger(queueId) && queueId > 0 && queueId === report.intake_batch_id) {
      const queue = await loadQueueContext(queueId, userId, az)
      setFlash(reply, 'success', `Entwurf ${az} gespeichert.`)
      // Im Modal weiter im Modal (ohne embed käme die Navigation ins iframe).
      const embed = body.embed === '1' ? '&embed=1' : ''
      if (queue?.nextAz) return reply.redirect(`/anzeige/${queue.nextAz}/bearbeiten?queue=${queueId}${embed}`)
      return reply.redirect(`/import/${queueId}`)
    }

    setFlash(reply, 'success', 'Entwurf gespeichert.')
    return reply.redirect(`/anzeige/${az}`)
  })

  app.post('/anzeige/:az/discard', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.redirect(`/anzeige/${az}`)
    const reportId = report.id

    // Kein Bestätigungsschritt mehr: der Entwurf landet im Papierkorb und
    // lässt sich dort 30 Tage lang wiederherstellen.
    await trashDrafts(userId, [reportId])

    // Prüf-Modus (review.js) verwirft per fetch und lädt selbst den nächsten.
    if (String(request.headers.accept || '').includes('application/json')) return reply.send({ ok: true })
    setFlash(reply, 'success', 'Entwurf in den Papierkorb verschoben.')
    // Import-Entwürfe zurück zur Batch-Übersicht, sonst zur Anzeigenliste.
    return reply.redirect(report.intake_batch_id ? `/import/${report.intake_batch_id}` : '/anzeigen')
  })

  // „Bereit"-Markierung umschalten (Knopf in report-row.ejs, report-table.js):
  // nur eine Notiz für den Nutzer selbst, ändert am Status nichts.
  app.post('/anzeige/:az/bereit', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') return reply.status(409).send({ ok: false })
    const bereit = !report.bereit_at
    await pool.execute('UPDATE reports SET bereit_at = ? WHERE id = ?', [bereit ? new Date() : null, report.id])
    if ((request.headers.accept || '').includes('application/json')) return { ok: true, bereit }
    return reply.redirect('/anzeigen')
  })

  // Einzelne Zeile der Anzeigen-Tabelle als HTML-Fragment (ohne Layout, daher
  // ejs.renderFile statt reply.view). report-table.js fügt damit nach
  // Drag & Drop "Foto -> neue Anzeige" die neue Zeile ohne Seiten-Reload ein.
  app.get('/anzeige/:az/listenzeile', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')

    const [images] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, filename, gps_lat, gps_lon, detected_plate, geprueft_at,
              DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i') AS captured
         FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
      [report.id]
    )
    const [counts] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS reply_count,
              COALESCE(SUM(read_at IS NULL), 0) AS unread_reply_count
         FROM report_replies WHERE report_id = ? AND direction = 'in'`,
      [report.id]
    )
    const queueParam = Number((request.query as { queue?: string }).queue)
    const html = await ejs.renderFile(
      path.join(__dirname, '../../views/partials/report-row.ejs'),
      {
        r: {
          ...report,
          reply_count: Number(counts[0]?.reply_count) || 0,
          photo_gps_count: images.filter((i) => i.gps_lat !== null && i.gps_lon !== null).length,
          detected_plates: [...new Set(images.map((i) => i.detected_plate).filter(Boolean))].join('|'),
          // Früheste Aufnahmezeit (Strings sortieren chronologisch, s. Konvention Foto-Zeitstempel).
          photo_time_min: images.map((i) => i.captured).filter(Boolean).sort()[0] || null,
          unread_reply_count: Number(counts[0]?.unread_reply_count) || 0,
        },
        imgs: images.map((i) => ({ id: i.id, v: imageVersion(i.filename), ok: i.geprueft_at !== null, plate: i.detected_plate || null })),
        // ejs.renderFile kennt den defaultContext von @fastify/view (server.ts)
        // nicht – Helfer, die report-row.ejs nutzt, hier explizit mitgeben.
        verjaehrung,
        verstossGesperrt,
        fahrzeugTypen: FAHRZEUG_TYPEN,
        queueId: Number.isInteger(queueParam) && queueParam > 0 ? queueParam : null,
      }
    )
    return reply.type('text/html; charset=utf-8').send(html)
  })

  // ---------------------------------------------------------------------------
  // Detail / Versand
  // ---------------------------------------------------------------------------

  app.get('/anzeige/:az', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')

    const [imageRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename, original_filename FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
      [report.id]
    )
    const images = imageRows.map((i) => ({ ...(i as Record<string, unknown>), id: Number(i.id), v: imageVersion(i.filename) }))

    // Nachrichtenverlauf (Anzeige-Mail, Antworten des Amts, eigene Nachrichten)
    // + Anhänge; Ansehen der Seite = gelesen.
    const [replies] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, direction, from_address, subject, body_text, received_at, read_at
         FROM report_replies WHERE report_id = ? ORDER BY received_at, id`,
      [report.id]
    )
    const attachmentsByReply: Record<number, mysql.RowDataPacket[]> = {}
    if (replies.length) {
      const ids = replies.map((r) => r.id)
      const [atts] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, reply_id, original_filename, size_bytes
           FROM report_reply_attachments WHERE reply_id IN (${ids.map(() => '?').join(',')})
          ORDER BY id`,
        ids
      )
      for (const a of atts) (attachmentsByReply[a.reply_id] ??= []).push(a)
      await pool.execute(
        'UPDATE report_replies SET read_at = NOW() WHERE report_id = ? AND read_at IS NULL',
        [report.id]
      )
    }

    const [ccRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT cc_self FROM users WHERE id = ?',
      [userId]
    )

    // Verknüpfte QR-Sticker (routes/sticker.ts) für die Sticker-Karte.
    const [stickerRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT code, scan_count, DATE_FORMAT(last_scan_at, '%d.%m.%Y %H:%i') AS letzter_scan,
              linked_at > DATE_SUB(NOW(), INTERVAL ? MINUTE) AS loesbar
         FROM sticker_codes WHERE report_id = ? AND user_id = ? ORDER BY linked_at`,
      [STICKER_LOESEN_MINUTEN, report.id, userId]
    )
    const stickers = stickerRows.map((s) => ({
      code: String(s.code),
      codeFmt: formatCode(String(s.code)),
      scans: Number(s.scan_count || 0),
      letzterScan: s.letzter_scan || null,
      loesbar: Number(s.loesbar) === 1,
    }))

    return reply.view('/reports/show.ejs', viewData(request, {
      stickers,
      stickerLoesenMinuten: STICKER_LOESEN_MINUTEN,
      title: `Anzeige ${report.aktenzeichen || ''}`,
      report,
      images,
      replies,
      attachmentsByReply,
      complete: isComplete(report),
      verjaehrt: isVerjaehrt(report),
      profileComplete: await isProfileComplete(userId),
      mailFrom: process.env.MAIL_FROM || null,
      city: getCity(report.city),
      ccSelf: ccRows[0]?.cc_self !== 0,
    }))
  })

  // Nachricht des Nutzers ans Ordnungsamt (Antwort auf Rückfragen). Nur bei
  // versendeten Anzeigen – vorher gibt es keinen Mail-Verlauf mit dem Amt.
  app.post('/anzeige/:az/message', {
    preHandler: requireAuth,
    // Geht als echte Mail ans Ordnungsamt – streng limitieren (Spam-Schutz).
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const text = String((request.body as { text?: string })?.text || '').trim().slice(0, 10_000)

    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'versendet') {
      setFlash(reply, 'error', 'Nachrichten sind erst nach dem Versand der Anzeige möglich.')
      return reply.redirect(`/anzeige/${az}`)
    }
    if (!text) {
      setFlash(reply, 'error', 'Bitte einen Nachrichtentext eingeben.')
      return reply.redirect(`/anzeige/${az}`)
    }

    // Threading: auf die letzte Nachricht des Amts antworten (sonst auf die
    // Anzeige-Mail); References = bisherige Message-IDs des Verlaufs.
    const [thread] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT direction, message_id FROM report_replies
        WHERE report_id = ? ORDER BY received_at, id`,
      [report.id]
    )
    const lastIn = [...thread].reverse().find((m) => m.direction === 'in')
    const inReplyTo = lastIn?.message_id || report.sent_message_id || null
    const references = [
      report.sent_message_id,
      ...thread.map((m) => m.message_id),
    ].filter((x): x is string => !!x && !x.startsWith('out:') && !x.startsWith('sha256:'))

    const [users] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM users WHERE id = ?', [userId])
    try {
      const sent = await MailService.sendUserReply(report, users[0], text, {
        inReplyTo,
        references: [...new Set(references)].slice(-10),
      })
      await pool.execute(
        `INSERT INTO report_replies (report_id, direction, message_id, from_address, subject, body_text, received_at, read_at)
         VALUES (?, 'out', ?, ?, ?, ?, NOW(), NOW())`,
        [
          report.id,
          sent.messageId.slice(0, 255) || `out:${report.id}:${thread.length + 1}`,
          (process.env.MAIL_FROM || '').slice(0, 255) || null,
          sent.subject.slice(0, 500),
          text,
        ]
      )
      setFlash(
        reply,
        'success',
        users[0].cc_self === 0
          ? 'Nachricht ans Ordnungsamt gesendet.'
          : 'Nachricht ans Ordnungsamt gesendet (du bist in Kopie).'
      )
    } catch (err) {
      app.log.error({ err }, 'Nutzer-Nachricht ans Ordnungsamt fehlgeschlagen')
      setFlash(reply, 'error', 'Senden fehlgeschlagen – bitte später erneut versuchen.')
    }
    return reply.redirect(`/anzeige/${az}`)
  })

  // Anhang einer Ordnungsamt-Antwort herunterladen (nur eigene Anzeigen).
  app.get('/anzeige/:az/reply/:replyId/attachment/:attId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, replyId, attId } = request.params as { az: string; replyId: string; attId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT a.filename, a.original_filename, a.mimetype
         FROM report_reply_attachments a
         JOIN report_replies rr ON rr.id = a.reply_id
         JOIN reports r ON r.id = rr.report_id
        WHERE a.id = ? AND rr.id = ? AND r.aktenzeichen = ? AND r.user_id = ?`,
      [attId, replyId, az, userId]
    )
    const att = rows[0]
    if (!att) return reply.status(404).send('Anhang nicht gefunden.')

    try {
      const buffer = await fs.readFile(replyAttachmentPath(Number(replyId), att.filename))
      return reply
        .header('Content-Type', att.mimetype || 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${att.original_filename || att.filename}"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('Anhang-Datei nicht gefunden.')
    }
  })
}
