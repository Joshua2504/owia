import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { getCity, unlockedCities } from '../config/cities'
import { cityEmail } from '../services/districts'
import { imageVersion } from '../services/images'
import { isVerjaehrt, verjaehrung } from '../services/verjaehrung'
import { VERSTOSS_ARTEN } from '../config/verstoss'
import { verstossVarianten, langparkerVariante, tatDauerMinuten, photoRoleMap } from '../services/portalFfm'
import { dritteFunde, parseAnalyse } from '../services/dritte'
import { submitProblems, mostUsedVerstoesse, VERSTOSS_SPERREN } from './reports'
import { fillTatortFromPhotos } from '../services/tatortFill'

// Prüf-Modus: alle offenen Entwürfe nacheinander durchgehen – Fotos prüfen und
// schwärzen (photo-edit.js, mit Kennzeichen-Abgleich im Dialog), fehlende
// Angaben ergänzen, einreichen oder überspringen. Gedacht fürs Handy (Bahn)
// und zum Abarbeiten vieler Entwürfe am Stück. Die Seite lädt die Reihenfolge
// einmal, die Karten kommen einzeln als JSON (public/js/review.js) – so bleibt
// jeder Schritt ein kleiner Request, und der nächste Entwurf wird vorgeladen.
// Einreichen/Verwerfen/Feldänderungen laufen über die bestehenden Endpunkte
// (POST /anzeige/:az/submit, /discard, PATCH /anzeige/:az/felder).
export default async function reviewRoutes(app: FastifyInstance) {
  app.get('/pruefen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const nurBereit = (request.query as { nur?: string }).nur === 'bereit'
    // Älteste Tat zuerst: die sind der Verjährung am nächsten. Ohne Tattag ans
    // Ende (meist Fotos ohne EXIF – brauchen ohnehin mehr Handarbeit).
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT aktenzeichen, tattag, tattag_bis, bereit_at FROM reports
        WHERE user_id = ? AND status = 'entwurf' AND versand_status IS NULL
        ORDER BY tattag IS NULL, tattag, tatzeit_von, id`,
      [userId]
    )
    // Verjährte Entwürfe lassen sich nicht mehr einreichen – nur zählen, damit
    // sie nicht stillschweigend verschwinden (Aufräumen geht über die Liste).
    const offen = rows.filter((r) => !isVerjaehrt(r))
    const queue = offen.filter((r) => !nurBereit || r.bereit_at).map((r) => r.aktenzeichen as string)
    return reply.view('/reports/pruefen.ejs', viewData(request, {
      title: 'Prüf-Modus',
      queue,
      nurBereit,
      countAlle: offen.length,
      countBereit: offen.filter((r) => r.bereit_at).length,
      countVerjaehrt: rows.length - offen.length,
      verstoss: { haeufig: await mostUsedVerstoesse(), alle: VERSTOSS_ARTEN, ...VERSTOSS_SPERREN },
      // Ordnungsamt-Auswahl + Kartenmitte ohne Tatort (wie edit.ejs).
      cities: unlockedCities().map((c) => ({
        id: c.id, name: c.name, ordnungsamt: c.ordnungsamt, email: cityEmail(c) || '', lat: c.geo.mapLat, lon: c.geo.mapLon,
      })),
    }))
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
    if (report.status !== 'entwurf' || report.versand_status !== null) {
      return reply.send({ az, gone: true, status: report.status })
    }
    const problems = await submitProblems(report, userId)
    const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, filename, detected_plate, analyse_json, dritte_ok, geprueft_at, gps_lat,
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
    return reply.send({
      az,
      bereit: !!report.bereit_at,
      canSubmit: problems.length === 0,
      problems,
      fields: {
        kennzeichen: report.kennzeichen || '',
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
          groesse: (() => { const a = parseAnalyse(i.analyse_json); return a ? { w: a.w, h: a.h } : null })(),
          ok: i.geprueft_at !== null,
          detected: i.detected_plate || null,
          thumb: `/anzeige/${az}/image/${i.id}/thumb.jpg?v=${v}`,
          full: `/anzeige/${az}/image/${i.id}?v=${v}`,
          put: `/anzeige/${az}/images/${i.id}`,
        }
      }),
    })
  })
}
