import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth } from '../middleware/auth'
import { getCity } from '../config/cities'
import { cityEmail } from '../services/districts'
import { imageVersion } from '../services/images'
import { isVerjaehrt, verjaehrung } from '../services/verjaehrung'
import { verstossVarianten, langparkerVariante, tatDauerMinuten, photoRoleMap, ffmFormHinweise } from '../services/portalFfm'
import { dritteFunde, parseAnalyse, parseKennzeichenBox, erkannteKennzeichenBox } from '../services/dritte'
import { submitProblems, kennzeichenBestaetigt } from './reports'
import { fillTatortFromPhotos } from '../services/tatortFill'
import { bestFahrzeugForReport } from '../services/plateAnalysis'

// JSON-Endpunkte des Foto-Prüfdialogs (public/js/photo-edit.js). Der frühere
// Prüf-Modus /pruefen (eine Karte pro Entwurf) ist entfernt – alte Links und
// der Kamera-Modus landen per Redirect im Foto-Dialog der Anzeigen-Liste.
export default async function reviewRoutes(app: FastifyInstance) {
  app.get('/pruefen', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as { az?: string; von?: string }
    const u = new URLSearchParams()
    if (typeof query.az === 'string' && query.az) {
      u.set('anzeige', query.az)
      u.set('foto', '1')
      if (query.von === 'kamera') u.set('von', 'kamera')
    }
    const qs = u.toString()
    return reply.redirect('/anzeigen' + (qs ? '?' + qs : ''))
  })

  // Ziele für „Foto verschieben" im Foto-Dialog (photo-edit.js): andere offene
  // Entwürfe, zeitlich nächste zuerst – meist gehört ein falsch zugeordnetes
  // Foto zu einem Vorfall kurz davor/danach.
  app.get('/pruefen/:az/ziele', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const [cur] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id, CONCAT(COALESCE(tattag, CURDATE()), ' ', COALESCE(tatzeit_von, '00:00:00')) AS ts FROM reports WHERE aktenzeichen = ? AND user_id = ?",
      [az, userId]
    )
    if (!cur[0]) return reply.status(404).send({ error: 'Anzeige nicht gefunden.' })
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.aktenzeichen, r.kennzeichen, r.tatort,
              DATE_FORMAT(r.tattag, '%d.%m.%Y') AS tag, DATE_FORMAT(r.tatzeit_von, '%H:%i') AS zeit,
              (SELECT ri.id FROM report_images ri WHERE ri.report_id = r.id ORDER BY ri.sort_order, ri.id LIMIT 1) AS image_id,
              (SELECT ri.filename FROM report_images ri WHERE ri.report_id = r.id ORDER BY ri.sort_order, ri.id LIMIT 1) AS image_file
         FROM reports r
        WHERE r.user_id = ? AND r.status = 'entwurf' AND r.versand_status IS NULL AND r.id <> ?
        ORDER BY r.tattag IS NULL,
                 ABS(TIMESTAMPDIFF(MINUTE, CONCAT(r.tattag, ' ', COALESCE(r.tatzeit_von, '00:00:00')), ?)), r.id DESC
        LIMIT 60`,
      [userId, cur[0].id, cur[0].ts]
    )
    return reply.send({
      drafts: rows.map((r) => ({
        az: r.aktenzeichen,
        kennzeichen: r.kennzeichen || '',
        tatort: r.tatort || '',
        wann: [r.tag, r.zeit].filter(Boolean).join(' '),
        thumb: r.image_id ? `/anzeige/${r.aktenzeichen}/image/${r.image_id}/thumb.jpg?v=${imageVersion(r.image_file)}` : null,
      })),
    })
  })

  // Eine Karte des Prüf-Modus. Wie die Einreichen-Vorschau, aber ohne das PDF
  // neu zu erzeugen (das kostet Zeit und ist auf dem Handy kaum lesbar; der
  // Submit erzeugt es ohnehin frisch) und mit Rohwerten für die Eingabefelder.
  app.get('/pruefen/:az/daten', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    // Fehlt der Tatort noch, jetzt aus den Fotos nachtragen (no-op sonst) –
    // so steht er im Prüf-Dialog schon da.
    const [idRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM reports WHERE aktenzeichen = ? AND user_id = ? AND status = 'entwurf' AND COALESCE(tatort, '') = ''",
      [az, userId]
    )
    if (idRows[0]) await fillTatortFromPhotos(Number(idRows[0].id)).catch(() => null)
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT *, DATE_FORMAT(tattag, '%Y-%m-%d') AS tattag_iso, DATE_FORMAT(tattag_bis, '%Y-%m-%d') AS tattag_bis_iso,
              DATE_FORMAT(tatzeit_von, '%H:%i') AS von_hhmm, DATE_FORMAT(tatzeit_bis, '%H:%i') AS bis_hhmm
         FROM reports WHERE aktenzeichen = ? AND user_id = ? AND status <> 'papierkorb'`,
      [az, userId]
    )
    const report = rows[0]
    if (!report) return reply.status(404).send({ error: 'Anzeige nicht gefunden.' })
    // Schon eingereicht (anderer Tab/Gerät) oder im Versand: Karte überspringen.
    // Verjährt: nicht mehr einreichbar, also auch nicht prüfbar.
    if (report.status !== 'entwurf' || report.versand_status !== null || isVerjaehrt(report)) {
      return reply.send({ az, gone: true, status: report.status })
    }
    const problems = await submitProblems(report, userId)
    const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, filename, original_filename, detected_plate, analyse_json, dritte_ok, geprueft_at, gps_lat, kennzeichen_box, kennzeichen_keins,
              DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i') AS captured
         FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
      [report.id]
    )
    const city = getCity(report.city)
    const rollen = photoRoleMap(imgs)
    const vj = verjaehrung(report)
    // Zeitspanne der Fotos (EXIF) für „Uhrzeit aus Fotos" – als Strings, nie
    // über ein JS-Date (Zeitzonen, s. CLAUDE.md).
    const times = imgs.map((i) => i.captured as string | null).filter((t): t is string => !!t).sort()
    const photoTimes = times.length
      ? { vonTag: times[0].slice(0, 10), von: times[0].slice(11), bisTag: times[times.length - 1].slice(0, 10), bis: times[times.length - 1].slice(11) }
      : null
    // Modell nur als Vorschlag (photo-edit.js), innerhalb der eingetragenen Marke.
    const fz = await bestFahrzeugForReport(report.id, report.fahrzeug_marke).catch(() => null)
    return reply.send({
      az,
      bereit: !!report.bereit_at,
      modellVorschlag: fz?.modell?.wert ?? null,
      canSubmit: problems.length === 0,
      problems,
      fields: {
        kennzeichen: report.kennzeichen || '',
        kennzeichen_land: report.kennzeichen_land || 'D',
        kennzeichen_bestaetigt: kennzeichenBestaetigt(report),
        fahrzeug_marke: report.fahrzeug_marke || '',
        tattag: report.tattag_iso || '',
        tattag_bis: report.tattag_bis_iso || '',
        tatzeit_von: report.von_hhmm || '',
        tatzeit_bis: report.bis_hhmm || '',
        tatort: report.tatort || '',
        verstoss_art: report.verstoss_art || '',
        beschreibung: report.beschreibung || '',
        behinderung: report.behinderung === 1,
        behinderung_text: report.behinderung_text || '',
        tatort_lat: report.tatort_lat !== null ? Number(report.tatort_lat) : null,
        tatort_lon: report.tatort_lon !== null ? Number(report.tatort_lon) : null,
        city: report.city || '',
        fahrzeug_verlassen: report.fahrzeug_verlassen === 1,
        fahrzeug_typ: report.fahrzeug_typ || '',
        fahrzeug_modell: report.fahrzeug_modell || '',
        fahrzeug_farbe: report.fahrzeug_farbe || '',
        verstoss_variante: report.verstoss_variante || '',
      },
      // Tatbestand-Konkretisierung (Kreuzung/Einmündung …) und Vorschlag
      // „länger als 1 Stunde", wenn die Tatzeit das hergibt (services/portalFfm.ts).
      varianten: verstossVarianten(report.verstoss_art).map((x) => x.value),
      langparker: (tatDauerMinuten(report) ?? 0) > 60 ? langparkerVariante(report.verstoss_art) : null,
      recipient: { ordnungsamt: city.ordnungsamt, email: cityEmail(city) || '' },
      // Frankfurt-Portal: Formular an dessen Fragen anpassen (photo-edit.js renderFfm).
      ffm: city.portal === 'ekom21-ffm' ? ffmFormHinweise(report, times[times.length - 1]) : null,
      verjaehrung: vj.bald ? { restTage: vj.restTage } : null,
      hasGps: imgs.some((i) => i.gps_lat !== null),
      // Kartenmitte ohne Tatort (Foto-Dialog, photo-edit.js): Stadtmitte.
      mapCenter: { lat: city.geo.mapLat, lon: city.geo.mapLon },
      photoTimes,
      // Portal-Städte (Frankfurt): Fotos gehen als Übersicht/Fahrzeug getrennt hoch.
      portal: !!city.portal,
      images: imgs.map((i) => {
        const v = imageVersion(i.filename)
        return {
          id: Number(i.id),
          rolle: rollen.get(i) ?? 'keine',
          // Datenschutz: fremde Kennzeichen/Gesichter (Boxen in Bildpixeln der
          // analysierten Fassung, Größe in groesse) – photo-edit.js schwärzt sie.
          dritte: i.dritte_ok ? [] : dritteFunde(i.analyse_json, report.kennzeichen),
          dritteOk: !!i.dritte_ok,
          // Eingebackene Bearbeitung (Schwärzung, Zuschnitt …) – „⟲ Original“ im Dialog.
          bearbeitet: !!i.original_filename && i.filename !== i.original_filename,
          groesse: (() => { const a = parseAnalyse(i.analyse_json); return a ? { w: a.w, h: a.h } : null })(),
          ok: i.geprueft_at !== null,
          // Kennzeichen-Markierung (Anteile 0..1): gespeichert, sonst Vorschlag
          // aus der Erkennung; keins = „kein Kennzeichen sichtbar" bestätigt.
          kennzeichen: {
            box: parseKennzeichenBox(i.kennzeichen_box),
            keins: !!i.kennzeichen_keins,
            vorschlag: erkannteKennzeichenBox(i.analyse_json, report.kennzeichen, i.detected_plate),
          },
          detected: i.detected_plate || null,
          zeit: i.captured ? String(i.captured).slice(11, 16) : null,
          thumb: `/anzeige/${az}/image/${i.id}/thumb.jpg?v=${v}`,
          full: `/anzeige/${az}/image/${i.id}?v=${v}`,
          put: `/anzeige/${az}/images/${i.id}`,
        }
      }),
    })
  })
}
