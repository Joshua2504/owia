import { FastifyInstance, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import ejs from 'ejs'
import { pool } from '../db/connection'
import { requireAuth, viewData, setFlash } from '../middleware/auth'
import { PdfService } from '../services/pdf'
import { getCity, CITIES, unlockedCities, hasPdfForm } from '../config/cities'
import { resolveSendCity, cityEmail, detectCityByLabel } from '../services/districts'
import { reverseGeocode } from '../services/geocode'
import { VERSTOSS_ARTEN, VERSTOSS_HAEUFIG } from '../config/verstoss'
import { prepareImage, writeReplacementImage, removeImagePair, removeDerivedFiles, PreparedImage, imageVersion } from '../services/images'
import { cachedMailVariant } from '../services/pixelate'
import { processReportImage, processReportImageDerivatives, loadThumbnail } from '../services/intakeImageProcessing'
import { createDraft, deleteDraft, reportDir, UPLOAD_DIR, PDF_DIR } from '../services/drafts'
import { alprEnabled, ALPR_MIN_CONFIDENCE } from '../services/alpr'
import { queuePlateAnalysis, plateCropName } from '../services/plateAnalysis'
import { replyAttachmentPath } from '../services/mailInbox'
import { photoSha256, findExistingPhoto } from '../services/photoDedup'
import { MailService } from '../services/mail'
import { adminEmails } from '../config/admin'
import { previewBulkEdit, applyBulkEdit, BulkEditInputError } from '../services/bulkEdit'

// Re-Export für bestehende Importe (Views/Tests beziehen die Liste über reports.ts).
export { VERSTOSS_ARTEN }

const MAX_IMAGES = 10

/** Buffer, den der PDF-Service einbettet. capturedAt = bereits formatierte
 *  Aufnahmezeit (z.B. "10.07.2026, 14:30") aus den EXIF-Daten, oder null. */
export type ReportImage = { mimetype: string; buffer: Buffer; capturedAt?: string | null }

/** Abgeleitete Dateien (Vorschaubild, Versandfassung) im Worker-Thread
 *  berechnen. jpeg-js dekodiert synchron – im HTTP-Prozess blockierte das bei
 *  jedem Upload/Speichern sekundenlang ALLE anderen Requests. Bewusst nicht
 *  awaited: Fehlt ein Vorschaubild noch, rechnet sendThumbnail() es vorrangig nach. */
function queueDerivatives(dir: string, filename: string, mimetype: string): void {
  processReportImageDerivatives(filename, mimetype, dir).catch(() => {})
}

/** Versandfassung (".mail.jpg") sicherstellen, bevor PDF/Mail sie lesen.
 *  Kleine JPEGs (≤ 1 MB) gehen unverändert raus und brauchen keinen Cache. */
export async function ensureMailVariant(dir: string, filename: string, mimetype: string): Promise<void> {
  try {
    await fs.access(path.join(dir, `${filename}.mail.jpg`))
    return
  } catch {
    /* noch nicht berechnet */
  }
  try {
    const stat = await fs.stat(path.join(dir, filename))
    if (mimetype !== 'image/png' && stat.size <= 1024 * 1024) return
    await processReportImageDerivatives(filename, mimetype, dir)
  } catch {
    /* Datei fehlt – cachedMailVariant/Aufrufer behandeln das */
  }
}

/** Alte Bilddateien (nutzbare Fassung + Original) entfernen. */
async function removeImageFiles(
  userId: number,
  reportId: number | string,
  filename: string,
  originalFilename: string
): Promise<void> {
  return removeImagePair(reportDir(userId, reportId), filename, originalFilename)
}

/** Bild zum Entwurf auf Platte + in der DB speichern; gibt die neue Bild-ID zurück.
 *  HEIC-Konvertierung und EXIF-Lesen (aus dem Original – die Konvertierung
 *  entfernt die Metadaten) laufen im Worker-Thread. */
async function saveImageToReport(
  userId: number,
  reportId: number,
  upload: { buffer: Buffer; filename: string; mimetype: string },
  sha256: string
): Promise<{ id: number; filename: string; mimetype: string; capturedAt: string | null }> {
  const dir = reportDir(userId, reportId)
  const p = await processReportImage(upload.buffer, upload.filename, upload.mimetype, dir)
  const { filename, originalFilename, meta } = p
  queueDerivatives(dir, filename, p.mimetype)

  // Neues Bild ans Ende der Sortierreihenfolge hängen.
  const [maxRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM report_images WHERE report_id = ?',
    [reportId]
  )
  const sortOrder = Number(maxRows[0].next)
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images
       (report_id, filename, mimetype, original_filename, original_mimetype, sort_order,
        captured_at, gps_lat, gps_lon, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reportId, filename, p.mimetype, originalFilename, p.originalMimetype, sortOrder,
     meta.capturedAt, meta.lat, meta.lon, sha256]
  )
  return { id: result.insertId, filename, mimetype: p.mimetype, capturedAt: meta.capturedAt }
}

/** Bild-URLs mit ?v=<Fassung> (imageVersion) ändern sich bei jeder neuen
 *  Fassung und dürfen lange gecacht werden – Listen laden Fotos dann nur einmal.
 *  Ohne Version (Editor, Karten-Marker) nur kurz, sonst bliebe nach dem
 *  Schwärzen die alte Fassung im Browser-Cache sichtbar. */
function cacheControlFor(request: FastifyRequest): string {
  return (request.query as { v?: string }).v ? 'private, max-age=604800' : 'private, max-age=60'
}

async function loadReport(
  reportId: string | number,
  userId: number
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM reports WHERE id = ? AND user_id = ?',
    [reportId, userId]
  )
  return rows[0]
}

/** Wie loadReport, aber per Aktenzeichen (wird in den URLs/Links verwendet). */
async function loadReportByAktenzeichen(
  aktenzeichen: string,
  userId: number
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM reports WHERE aktenzeichen = ? AND user_id = ?',
    [aktenzeichen, userId]
  )
  return rows[0]
}

/** Kontext der Review-Queue eines Foto-Imports: Position des aktuellen
 *  Entwurfs sowie vorheriger/nächster noch offener Entwurf des Batches. */
async function loadQueueContext(
  batchId: number,
  userId: number,
  currentAz: string
): Promise<{ batchId: number; position: number; total: number; prevAz: string | null; nextAz: string | null } | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT aktenzeichen, status FROM reports
      WHERE intake_batch_id = ? AND user_id = ?
      ORDER BY tattag, tatzeit_von, id`,
    [batchId, userId]
  )
  const idx = rows.findIndex((r) => r.aktenzeichen === currentAz)
  if (idx === -1) return null
  const prev = rows.slice(0, idx).reverse().find((r) => r.status === 'entwurf')
  const next = rows.slice(idx + 1).find((r) => r.status === 'entwurf')
  return {
    batchId,
    position: idx + 1,
    total: rows.length,
    prevAz: prev ? prev.aktenzeichen : null,
    nextAz: next ? next.aktenzeichen : null,
  }
}

/** Felder eines Entwurfs persistieren (leere Strings -> NULL). */
async function persistFields(
  reportId: string | number,
  userId: number,
  v: Record<string, string | undefined>
): Promise<void> {
  // Standard "Nein": nur explizites "ja" ergibt 1, alles andere 0.
  const behinderung = v.behinderung === 'ja' ? 1 : 0
  // Text immer aufbewahren (falls später doch wieder „Ja"); im PDF wird er nur
  // bei behinderung=1 angezeigt.
  const behinderungText = v.behinderung_text || null
  // Checkbox: nicht angehakt = Feld fehlt im Body bzw. ist leer.
  const fahrzeugVerlassen = v.fahrzeug_verlassen && v.fahrzeug_verlassen !== '0' ? 1 : 0
  // Länderkürzel: Der Editor fragt es nicht mehr ab (Kennzeichen sind
  // Freitext). Fehlt das Feld, bleibt der gespeicherte Wert (COALESCE) – ältere
  // Entwürfe mit z.B. „NL" verlieren ihn so nicht still.
  const landRaw = (v.kennzeichen_land || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3)
  const land = landRaw || null
  // Tatzeitraum über Mitternacht: tattag_bis nur speichern, wenn er sich vom
  // Tattag unterscheidet (gleicher Tag = normaler Fall, Feld bleibt leer).
  const tattagBis = v.tattag_bis && v.tattag_bis !== v.tattag ? v.tattag_bis : null
  // Tatort-Koordinaten (Karte/Marker) nur übernehmen, wenn beide gültig sind.
  // Achtung `Number('')` === 0: Die Hidden-Felder im Formular sind leer, solange
  // kein Tatort gewählt wurde – ohne die Leerprüfung landete jeder solche
  // Entwurf bei 0/0 (Golf von Guinea) und zog die Übersichtskarte auf die halbe
  // Weltkugel auf. Exakt 0 ist deshalb ungültig (die App deckt nur deutsche
  // Städte ab), ebenso Werte außerhalb des Wertebereichs. Gleiche Regel in
  // public/js/report-map.js und public/js/overview-map.js.
  const coord = (raw: string | undefined, max: number): number | null => {
    const s = (raw || '').trim()
    if (!s) return null
    const n = Number(s)
    return Number.isFinite(n) && n !== 0 && Math.abs(n) <= max ? n : null
  }
  const lat = coord(v.tatort_lat, 90)
  const lon = coord(v.tatort_lon, 180)
  // Nur als Paar sinnvoll – ein halber Punkt ist keine Position.
  const tatortLat = lat !== null && lon !== null ? lat : null
  const tatortLon = tatortLat !== null ? lon : null
  // Zuständige Stadt aus dem Dropdown (nur freigeschaltete IDs zulassen). Fehlt der
  // Wert oder ist er unbekannt, bleibt die gespeicherte Stadt erhalten (COALESCE).
  const city = v.city && CITIES[v.city] ? v.city : null
  await pool.execute(
    `UPDATE reports
       SET kennzeichen=?, kennzeichen_land=COALESCE(?, kennzeichen_land), fahrzeug_marke=?, tattag=?, tattag_bis=?, tatzeit_von=?, tatzeit_bis=?,
           tatort=?, tatort_lat=?, tatort_lon=?, verstoss_art=?, beschreibung=?,
           behinderung=?, behinderung_text=?, fahrzeug_verlassen=?, city=COALESCE(?, city)
     WHERE id=? AND user_id=? AND status='entwurf'`,
    [
      normalizePlate(v.kennzeichen),
      land,
      v.fahrzeug_marke || null,
      v.tattag || null,
      tattagBis,
      v.tatzeit_von || null,
      v.tatzeit_bis || null,
      v.tatort || null,
      tatortLat,
      tatortLon,
      v.verstoss_art || null,
      v.beschreibung || null,
      behinderung,
      behinderungText,
      fahrzeugVerlassen,
      city,
      reportId,
      userId,
    ]
  )
}

/** Kennzeichen vereinheitlichen, ohne ein Länderformat vorzuschreiben: Es gibt
 *  weltweit (und bei Rollern/Versicherungskennzeichen wie „123 ABC") keine
 *  gemeinsame Schreibweise. Großschreibung, Leerraum zusammenfassen, auf die
 *  Spaltenbreite (VARCHAR(20)) kürzen. */
export function normalizePlate(raw: string | undefined | null): string | null {
  const v = String(raw || '').toLocaleUpperCase('de-DE').replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, 20) : null
}

function isComplete(r: mysql.RowDataPacket): boolean {
  return !!(r.kennzeichen && r.tattag && r.tatzeit_von && r.tatort && r.verstoss_art)
}

/** Häufig verwendete Verstöße für die Auswahl-Liste: tatsächliche Nutzung aus der
 *  DB (nur Einträge, die noch im aktuellen Katalog stehen) zuerst, aufgefüllt mit
 *  den kuratierten Defaults (VERSTOSS_HAEUFIG) – so ist die „Häufig"-Gruppe auch
 *  ohne Nutzungshistorie sinnvoll gefüllt. */
async function mostUsedVerstoesse(limit = 12): Promise<string[]> {
  const catalog = new Set(VERSTOSS_ARTEN)
  let used: string[] = []
  try {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT verstoss_art, COUNT(*) AS c FROM reports
        WHERE verstoss_art IS NOT NULL AND verstoss_art <> ''
        GROUP BY verstoss_art ORDER BY c DESC LIMIT 30`
    )
    used = rows.map((r) => String(r.verstoss_art)).filter((a) => catalog.has(a))
  } catch {
    used = [] // ohne DB/History einfach die kuratierten Defaults verwenden
  }
  const out: string[] = []
  for (const t of [...used, ...VERSTOSS_HAEUFIG]) {
    if (!out.includes(t)) out.push(t)
    if (out.length >= limit) break
  }
  return out
}

/** Profil vollständig? Das Ordnungsamt bearbeitet anonyme Anzeigen nicht –
 *  Name und Anschrift des Anzeigenerstatters müssen im PDF stehen. */
export async function isProfileComplete(userId: number): Promise<boolean> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT vorname, nachname, strasse, plz, ort FROM users WHERE id = ?',
    [userId]
  )
  const u = rows[0]
  return !!(u && u.vorname && u.nachname && u.strasse && u.plz && u.ort)
}

/** PDF aus dem aktuellen Stand (inkl. gespeicherter Bilder) neu erzeugen. */
export async function regeneratePdf(reportId: string | number, userId: number): Promise<void> {
  const report = await loadReport(reportId, userId)
  if (!report) return

  // Städte ohne amtliches Formular (z.B. Bad Soden-Salmünster) werden als rohe
  // E-Mail versendet – kein PDF. Ein evtl. früher (als andere Stadt) erzeugtes PDF
  // wird entfernt, damit nichts Verwaistes zurückbleibt.
  if (!hasPdfForm(getCity(report.city))) {
    if (report.pdf_filename) {
      try {
        await fs.rm(path.join(PDF_DIR, String(userId), report.pdf_filename), { force: true })
      } catch {
        /* egal */
      }
      await pool.execute('UPDATE reports SET pdf_filename=NULL WHERE id=?', [reportId])
    }
    return
  }

  const [uRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT * FROM users WHERE id = ?',
    [userId]
  )
  const user = uRows[0]
  const [imgRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT filename, mimetype,
            DATE_FORMAT(captured_at, '%d.%m.%Y, %H:%i') AS captured_at
       FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
    [reportId]
  )

  const dir = path.join(UPLOAD_DIR, String(userId), String(reportId))
  const images: ReportImage[] = []
  for (const row of imgRows) {
    try {
      // Versandfassung statt Original einbetten: Behörden-Postfächer haben
      // Größenlimits (Frankfurt ~15 MB); das Original auf Platte bleibt erhalten.
      // Fehlt der Cache (Altbestand), im Worker statt im Eventloop rechnen.
      await ensureMailVariant(dir, row.filename, row.mimetype)
      const { buffer, type } = await cachedMailVariant(dir, row.filename, row.mimetype)
      images.push({ mimetype: type, buffer, capturedAt: row.captured_at })
    } catch {
      // Datei fehlt – überspringen
    }
  }

  // Altes PDF entfernen, damit keine verwaisten Dateien liegen bleiben.
  if (report.pdf_filename) {
    try {
      await fs.rm(path.join(PDF_DIR, String(userId), report.pdf_filename), { force: true })
    } catch {
      /* egal */
    }
  }

  try {
    const filename = await PdfService.generate(report, user, images)
    await pool.execute('UPDATE reports SET pdf_filename=? WHERE id=?', [filename, reportId])
  } catch (err) {
    // PDF-Erzeugung darf den Workflow nicht blockieren; Vorschau bleibt dann leer.
    console.error('PDF-Generierung fehlgeschlagen', err)
  }
}

export default async function reportsRoutes(app: FastifyInstance) {
  // Verstoß-Katalog für Sammelbearbeitung und Inline-Bearbeitung der Liste
  // (lazy geladen, statt den ~55 KB-Katalog in jede Listenseite einzubetten).
  app.get('/anzeigen/bearbeitungsoptionen', { preHandler: requireAuth }, async () => ({
    offenses: VERSTOSS_ARTEN,
    frequent: await mostUsedVerstoesse(),
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
    if (typeof body.verstoss_art === 'string') {
      const v = body.verstoss_art.trim()
      // Nur Einträge aus dem amtlichen Katalog (wie die Auswahl im Editor).
      if (v && !VERSTOSS_ARTEN.includes(v)) return reply.status(400).send({ error: 'Unbekannter Verstoß.' })
      out.verstoss_art = v || null
      sets.push('verstoss_art=?')
      values.push(out.verstoss_art)
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

  // Einzelnes (ggf. bereits geschwärztes) Bild sofort zum Entwurf hochladen.
  app.post('/anzeige/:az/images', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })
    const reportId = report.id

    const [cntRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ?',
      [reportId]
    )
    let count = Number(cntRows[0].c)

    const saved: { id: number; url: string; capturedAt: string | null }[] = []
    const errors: string[] = []
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        if (part.fieldname !== 'bilder' || !part.filename) continue
        const buffer = await part.toBuffer()
        if (buffer.length === 0) continue
        if (count >= MAX_IMAGES) {
          errors.push(`Maximal ${MAX_IMAGES} Bilder pro Anzeige.`)
          continue
        }
        try {
          // Duplikat? Hash über den unveränderten Upload, Prüfung gegen alle
          // Anzeigen + offenen Foto-Importe des Nutzers (services/photoDedup.ts).
          const sha256 = photoSha256(buffer)
          const existing = await findExistingPhoto(userId, sha256)
          if (existing) {
            errors.push(`${part.filename}: Bereits vorhanden (${existing}) – übersprungen.`)
            continue
          }
          const row = await saveImageToReport(userId, reportId, { buffer, filename: part.filename, mimetype: part.mimetype || '' }, sha256)
          // Kennzeichen im Hintergrund erkennen; Ergebnis holt das Formular per Poll.
          queuePlateAnalysis(userId, reportId, row.id, row.filename, row.mimetype)
          saved.push({ id: row.id, url: `/anzeige/${az}/image/${row.id}`, capturedAt: row.capturedAt })
          count++
        } catch {
          errors.push('Nur JPG-, PNG- und HEIC/HEIF-Bilder werden unterstützt.')
        }
      }
    } catch {
      return reply.status(413).send({ error: 'Bild zu groß (max. 20 MB).', images: saved })
    }

    return reply.send({ images: saved, errors })
  })

  app.delete('/anzeige/:az/images/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.original_filename, r.id AS report_id
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ? AND r.status = 'entwurf'`,
      [imageId, az, userId]
    )
    const img = rows[0]
    if (!img) return reply.status(404).send({ error: 'not found' })

    await pool.execute('DELETE FROM report_images WHERE id = ?', [imageId])
    await removeImageFiles(userId, img.report_id, img.filename, img.original_filename)
    return reply.send({ ok: true })
  })

  // Bestehendes Bild durch eine neue (z.B. geschwärzte) Fassung ersetzen.
  // Die Bild-ID bleibt erhalten, das Bilder-Limit wird nicht berührt.
  app.put('/anzeige/:az/images/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.original_filename, ri.detected_plate, r.id AS report_id
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ? AND r.status = 'entwurf'`,
      [imageId, az, userId]
    )
    const old = rows[0]
    if (!old) return reply.status(404).send({ error: 'not found' })

    let prepared: PreparedImage | null = null
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'bilder' || !part.filename) continue
        const buffer = await part.toBuffer()
        if (buffer.length === 0) continue
        prepared = await prepareImage(buffer, part.filename, part.mimetype || '')
        break // nur das erste Bild ersetzt die bestehende Fassung
      }
    } catch {
      return reply.status(413).send({ error: 'Bild zu groß (max. 20 MB).' })
    }
    if (!prepared) {
      return reply.status(400).send({ error: 'Kein gültiges Bild übermittelt.' })
    }

    // Nur die neue nutzbare Fassung schreiben – original_filename bleibt auf dem
    // Erst-Upload stehen, damit eine (auch versehentliche) Schwärzung das
    // unbearbeitete Original nie vernichtet (es bleibt als Beleg auf der Platte
    // und geht in den Datenexport ein).
    const dir = reportDir(userId, old.report_id)
    const filename = await writeReplacementImage(dir, prepared)
    queueDerivatives(dir, filename, prepared.mimetype)
    await pool.execute(
      'UPDATE report_images SET filename=?, mimetype=? WHERE id=?',
      [filename, prepared.mimetype, imageId]
    )

    // Gespeicherten Kennzeichen-Ausschnitt zur neuen Fassung mitnehmen, BEVOR
    // unten die alten Dateien samt Ableitungen weggeräumt werden (die Erkennung
    // lief gegen das alte, ungeschwärzte Bild – der Beleg bleibt gültig).
    if (old.detected_plate !== null) {
      await fs.rename(
        path.join(dir, plateCropName(old.filename)),
        path.join(dir, plateCropName(filename))
      ).catch(() => {})
    }

    // Vorherige Fassung aufräumen – das Original niemals: Ist die alte Fassung
    // selbst der Erst-Upload (erste Bearbeitung eines JPG/PNG), bleibt die Datei
    // liegen und nur ihre gecachten Ableitungen verschwinden.
    if (old.filename === old.original_filename) {
      await removeDerivedFiles(dir, old.filename)
    } else {
      await fs.rm(path.join(dir, old.filename), { force: true }).catch(() => {})
      await removeDerivedFiles(dir, old.filename)
    }

    // Neu analysieren nur, wenn dieses Bild noch keine erfolgreiche Erkennung
    // hatte: PUT feuert bei jedem Schwärzungs-Save, und in der ersetzten Fassung
    // ist das Kennzeichen typischerweise gerade unkenntlich gemacht.
    if (old.detected_plate === null) {
      await pool.execute(
        `UPDATE report_images
           SET detected_plate=NULL, plate_confidence=NULL, analysis_status=NULL, analyzed_at=NULL
         WHERE id=?`,
        [imageId]
      )
      queuePlateAnalysis(userId, old.report_id, Number(imageId), filename, prepared.mimetype)
    }

    return reply.send({ image: { id: Number(imageId), url: `/anzeige/${az}/image/${imageId}` } })
  })

  // Ergebnis der Kennzeichen-Erkennung für das Bearbeiten-Formular (Poll).
  // status 'pending', solange mindestens ein Bild noch nicht analysiert ist.
  app.get('/anzeige/:az/analysis', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })

    // Analyse deaktiviert (z.B. Entwicklung): sofort fertig melden, damit das
    // Formular gar nicht erst weiterpollt.
    if (!alprEnabled()) {
      return reply.send({
        status: 'done',
        suggestions: { kennzeichen: null, confidence: null },
        images: [],
      })
    }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, analysis_status, detected_plate, plate_confidence FROM report_images WHERE report_id = ?',
      [report.id]
    )
    // Nur 'pending' zählt als "läuft noch" – NULL sind Altbilder von vor dem
    // Feature (bzw. per 0026 'skipped'), die nie analysiert werden.
    const pending = rows.some((r) => r.analysis_status === 'pending')
    // Vorschlag = sicherste Lesung über alle Bilder; unsichere Lesungen (unter
    // der Prefill-Schwelle) werden dem Nutzer gar nicht erst vorgeschlagen.
    let best: { plate: string; confidence: number } | null = null
    for (const r of rows) {
      if (!r.detected_plate || r.plate_confidence === null) continue
      const confidence = Number(r.plate_confidence)
      if (confidence < ALPR_MIN_CONFIDENCE) continue
      if (!best || confidence > best.confidence) best = { plate: r.detected_plate, confidence }
    }
    return reply.send({
      status: pending ? 'pending' : 'done',
      suggestions: { kennzeichen: best?.plate ?? null, confidence: best?.confidence ?? null },
      // Einzelergebnisse pro Foto: speisen die "Kennzeichen übernehmen"-Buttons
      // auf den Bild-Karten (auch Lesungen unter der Prefill-Schwelle).
      images: rows
        .filter((r) => r.detected_plate)
        .map((r) => ({
          id: r.id,
          kennzeichen: r.detected_plate,
          confidence: r.plate_confidence !== null ? Number(r.plate_confidence) : null,
        })),
    })
  })

  // Bildreihenfolge speichern (Nutzer sortiert per ◀ ▶). Das erste Bild dient u.a. als
  // Karten-Marker. order = Bild-IDs in der neuen Reihenfolge.
  app.post('/anzeige/:az/images/reorder', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })

    const body = (request.body || {}) as { order?: unknown }
    const order = Array.isArray(body.order)
      ? body.order.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : []
    if (!order.length) return reply.send({ ok: true })

    // Position = Index in der übergebenen Liste; nur Bilder dieses Reports betroffen.
    let pos = 0
    for (const imageId of order) {
      await pool.execute('UPDATE report_images SET sort_order = ? WHERE id = ? AND report_id = ?', [
        pos,
        imageId,
        report.id,
      ])
      pos++
    }
    return reply.send({ ok: true })
  })

  // Fotos in einen anderen eigenen Entwurf oder eine neue Anzeige verschieben
  // (Mehrfachauswahl im Editor, Drag & Drop in den Listen). Dateien wandern
  // physisch mit, die Bilder landen am Ende der Ziel-Sortierung.
  async function moveImages(
    userId: number,
    az: string,
    imageIds: number[],
    dest: { targetAz?: string; newDraft?: boolean }
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!dest.newDraft && (!dest.targetAz || dest.targetAz === az)) {
      return { status: 400, body: { error: 'Ziel-Anzeige fehlt.' } }
    }
    if (!imageIds.length) return { status: 400, body: { error: 'Keine Fotos ausgewählt.' } }

    const source = await loadReportByAktenzeichen(az, userId)
    if (!source) return { status: 404, body: { error: 'not found' } }
    if (source.status !== 'entwurf' || source.versand_status !== null) return { status: 409, body: { error: 'not a draft' } }

    const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, filename, original_filename,
              DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s') AS captured_at, gps_lat, gps_lon
         FROM report_images WHERE report_id = ? AND id IN (${imageIds.map(() => '?').join(',')})
        ORDER BY sort_order, id`,
      [source.id, ...imageIds]
    )
    if (imgs.length !== imageIds.length) return { status: 404, body: { error: 'Bild nicht gefunden.' } }

    // Ziel: bestehender Entwurf oder neue Anzeige (mit EXIF des ersten Fotos
    // vorbelegt; ein Import-Entwurf bleibt Teil seines Batches, damit die
    // Übersicht ihn zeigt).
    let targetId: number
    let resolvedTargetAz: string
    if (dest.newDraft) {
      const first = imgs.find((i) => i.captured_at) || imgs[0]
      const gps = imgs.find((i) => i.gps_lat !== null && i.gps_lon !== null)
      const draft = await createDraft(userId, {
        tattag: first.captured_at ? first.captured_at.slice(0, 10) : null,
        tatzeitVon: first.captured_at ? first.captured_at.slice(11, 19) : null,
        tatortLat: gps ? Number(gps.gps_lat) : null,
        tatortLon: gps ? Number(gps.gps_lon) : null,
        intakeBatchId: source.intake_batch_id ?? null,
      })
      targetId = draft.id
      resolvedTargetAz = draft.aktenzeichen
    } else {
      const target = await loadReportByAktenzeichen(dest.targetAz as string, userId)
      if (!target) return { status: 404, body: { error: 'Ziel-Entwurf nicht gefunden.' } }
      if (target.status !== 'entwurf' || target.versand_status !== null) {
        return { status: 409, body: { error: 'Ziel-Anzeige ist kein Entwurf mehr.' } }
      }
      const [cntRows] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ?',
        [target.id]
      )
      if (Number(cntRows[0].c) + imgs.length > MAX_IMAGES) {
        return { status: 400, body: { error: `Maximal ${MAX_IMAGES} Bilder pro Anzeige.` } }
      }
      targetId = target.id
      resolvedTargetAz = target.aktenzeichen
    }

    const from = reportDir(userId, source.id)
    const to = reportDir(userId, targetId)
    await fs.mkdir(to, { recursive: true })
    const [maxRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM report_images WHERE report_id = ?',
      [targetId]
    )
    let sortOrder = Number(maxRows[0].next)
    for (const img of imgs) {
      await fs.rename(path.join(from, img.filename), path.join(to, img.filename))
      if (img.original_filename && img.original_filename !== img.filename) {
        await fs.rename(path.join(from, img.original_filename), path.join(to, img.original_filename))
      }
      // Gecachte Ableitungen (Vorschau, Pixelbild, Versandfassung, Kennzeichen-
      // Ausschnitt) mitnehmen, falls vorhanden.
      for (const suffix of ['.thumb.jpg', '.pixel.jpg', '.mail.jpg', '.plate.jpg']) {
        await fs
          .rename(path.join(from, img.filename + suffix), path.join(to, img.filename + suffix))
          .catch(() => {})
      }
      await pool.execute('UPDATE report_images SET report_id = ?, sort_order = ? WHERE id = ?', [
        targetId,
        sortOrder++,
        img.id,
      ])
    }

    // PDFs im Hintergrund nachziehen: Beide sind Entwürfe, „Speichern" und
    // „Einreichen" erzeugen das PDF ohnehin neu – der Nutzer soll nach dem
    // Verschieben nicht auf zwei PDF-Läufe warten.
    void regeneratePdf(source.id, userId).then(() => regeneratePdf(targetId, userId)).catch(() => {})
    return { status: 200, body: { ok: true, targetAz: resolvedTargetAz, moved: imgs.length } }
  }

  app.post('/anzeige/:az/images/:imageId/move', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const dest = (request.body || {}) as { targetAz?: string; newDraft?: boolean }
    const id = Number(imageId)
    const res = await moveImages(request.session.userId as number, az, Number.isInteger(id) ? [id] : [], dest)
    return reply.status(res.status).send(res.body)
  })

  app.post('/anzeige/:az/images/move', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const body = (request.body || {}) as { imageIds?: unknown; targetAz?: string; newDraft?: boolean }
    const ids = Array.isArray(body.imageIds)
      ? [...new Set(body.imageIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_IMAGES)
      : []
    const res = await moveImages(request.session.userId as number, az, ids, { targetAz: body.targetAz, newDraft: body.newDraft })
    return reply.status(res.status).send(res.body)
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
    await regeneratePdf(report.id, userId)

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

    // Löschen verlangt eine explizite Bestätigung: erster POST (ohne confirmed)
    // zeigt eine Bestätigungsseite mit den Eckdaten – serverseitig erzwungen,
    // ein reiner JS-confirm-Dialog wäre umgehbar/übersehbar.
    if (String((request.body as { confirmed?: string })?.confirmed || '') !== '1') {
      const [images] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT id FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
        [reportId]
      )
      return reply.view('/reports/discard-confirm.ejs', viewData(request, {
        title: 'Entwurf löschen',
        report,
        imageIds: images.map((i) => i.id),
      }))
    }

    await deleteDraft(userId, { id: reportId, pdf_filename: report.pdf_filename })

    setFlash(reply, 'success', 'Entwurf verworfen.')
    // Import-Entwürfe zurück zur Batch-Übersicht, sonst zur Anzeigenliste.
    return reply.redirect(report.intake_batch_id ? `/import/${report.intake_batch_id}` : '/anzeigen')
  })

  // Sammel-Löschen angehakter Entwürfe (Mehrfachauswahl in der Anzeigen-Tabelle).
  // Zweistufig wie /discard: erster POST zeigt die Bestätigungsseite, erst
  // confirmed=1 löscht. Nur eigene Entwürfe – eingereichte/versendete Anzeigen
  // fallen durch den status-Filter still heraus.
  app.post('/anzeigen/loeschen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const body = (request.body || {}) as { az?: string | string[]; confirmed?: string }
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

    if (String(body.confirmed || '') !== '1') {
      return reply.view('/reports/bulk-discard-confirm.ejs', viewData(request, {
        title: 'Entwürfe löschen',
        drafts,
      }))
    }

    for (const d of drafts) {
      await deleteDraft(userId, { id: d.id, pdf_filename: d.pdf_filename })
    }
    setFlash(reply, 'success', `${drafts.length} ${drafts.length === 1 ? 'Entwurf' : 'Entwürfe'} verworfen.`)
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
      'SELECT id, filename, gps_lat, gps_lon FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
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
      path.join(__dirname, '../views/partials/report-row.ejs'),
      {
        r: {
          ...report,
          reply_count: Number(counts[0]?.reply_count) || 0,
          photo_gps_count: images.filter((i) => i.gps_lat !== null && i.gps_lon !== null).length,
          unread_reply_count: Number(counts[0]?.unread_reply_count) || 0,
        },
        imgs: images.map((i) => ({ id: i.id, v: imageVersion(i.filename) })),
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

    return reply.view('/reports/show.ejs', viewData(request, {
      title: `Anzeige ${report.aktenzeichen || ''}`,
      report,
      images,
      replies,
      attachmentsByReply,
      complete: isComplete(report),
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

  app.get('/anzeige/:az/image/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const wantOriginal = (request.query as { original?: string }).original === '1'

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.mimetype, ri.original_filename, ri.original_mimetype, r.id AS report_id
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ?`,
      [imageId, az, userId]
    )
    const image = rows[0]
    if (!image) return reply.status(404).send('Bild nicht gefunden.')

    const filename = wantOriginal ? image.original_filename : image.filename
    const mimetype = wantOriginal ? image.original_mimetype : image.mimetype

    const imagePath = path.join(UPLOAD_DIR, String(userId), String(image.report_id), filename)
    try {
      const buffer = await fs.readFile(imagePath)
      const reply2 = reply
        .header('Content-Type', mimetype || 'application/octet-stream')
        .header('Cache-Control', cacheControlFor(request))
      if (wantOriginal) {
        reply2.header('Content-Disposition', `attachment; filename="${filename}"`)
      }
      return reply2.send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })

  // Kleines Vorschaubild (fürs Karten-Marker): serverseitig auf wenige KB heruntergerechnet,
  // damit die Karte nicht die Vollbilder laden muss.
  app.get('/anzeige/:az/image/:imageId/thumb.jpg', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, ri.mimetype, r.id AS report_id
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ?`,
      [imageId, az, userId]
    )
    const image = rows[0]
    if (!image) return reply.status(404).send('Bild nicht gefunden.')

    try {
      const { buffer, type } = await loadThumbnail(
        reportDir(userId, image.report_id),
        image.filename,
        image.mimetype
      )
      return reply
        .header('Content-Type', type)
        .header('Cache-Control', cacheControlFor(request))
        .send(buffer)
    } catch {
      return reply.status(404).send('Bilddatei nicht gefunden.')
    }
  })

  // Gespeicherter Kennzeichen-Ausschnitt eines Fotos (von der Hintergrund-Analyse
  // neben dem Foto abgelegt); 404, wenn für das Bild nichts erkannt wurde.
  app.get('/anzeige/:az/image/:imageId/plate.jpg', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT ri.filename, r.id AS report_id
         FROM report_images ri
         JOIN reports r ON r.id = ri.report_id
        WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ?`,
      [imageId, az, userId]
    )
    const image = rows[0]
    if (!image) return reply.status(404).send('Bild nicht gefunden.')

    try {
      const buffer = await fs.readFile(
        path.join(reportDir(userId, image.report_id), plateCropName(image.filename))
      )
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'private, max-age=3600')
        .send(buffer)
    } catch {
      return reply.status(404).send('Kein Kennzeichen-Ausschnitt vorhanden.')
    }
  })

  app.get('/anzeige/:az/pdf', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const inline = (request.query as { inline?: string }).inline === '1'
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT pdf_filename FROM reports WHERE aktenzeichen = ? AND user_id = ?',
      [az, userId]
    )
    const report = rows[0]
    if (!report?.pdf_filename) return reply.status(404).send('PDF nicht verfügbar.')

    const pdfPath = path.join(PDF_DIR, String(userId), report.pdf_filename)
    try {
      const buffer = await fs.readFile(pdfPath)
      const disposition = inline ? 'inline' : 'attachment'
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="${report.pdf_filename}"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('PDF-Datei nicht gefunden.')
    }
  })

  // Anzeige zur Prüfung einreichen: ein Admin gibt sie frei und verschickt sie
  // ans Ordnungsamt. Nutzer versenden nicht mehr selbst.
  app.post('/anzeige/:az/submit', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    // „Speichern & Einreichen" im Editor schickt per fetch (Accept: JSON) und
    // zeigt Fehler direkt an, statt umzuleiten.
    const json = String(request.headers.accept || '').includes('application/json')
    const fail = (message: string, to: string) => {
      if (json) return reply.status(422).send({ error: message, redirect: to })
      setFlash(reply, 'error', message)
      return reply.redirect(to)
    }
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') {
      return json ? reply.status(409).send({ error: 'Die Anzeige ist bereits eingereicht.' }) : reply.redirect(`/anzeige/${az}`)
    }

    if (!isComplete(report)) {
      const missing = [
        !report.kennzeichen && 'Kennzeichen',
        !report.tattag && 'Tattag',
        !report.tatzeit_von && 'Uhrzeit',
        !report.tatort && 'Tatort',
        !report.verstoss_art && 'Verstoß',
      ].filter(Boolean).join(', ')
      return fail(`Bitte zuerst alle Pflichtfelder ausfüllen (es fehlt: ${missing}).`, `/anzeige/${az}/bearbeiten`)
    }

    // Ohne vollständiges Profil (Name + Anschrift) keine Einreichung – das
    // Ordnungsamt bearbeitet anonyme Anzeigen nicht.
    if (!(await isProfileComplete(userId))) {
      return fail('Bitte zuerst dein Profil vervollständigen (Name und Anschrift) – anonyme Anzeigen werden vom Ordnungsamt nicht bearbeitet.', '/einstellungen')
    }

    // Nur freigeschaltete Orte: aus dem Tatort das zuständige Amt ableiten. Liegt
    // der Tatort in einem (noch) nicht freigeschalteten Ort, wird abgewiesen.
    const gate = resolveSendCity(report.tatort, report.city)
    if (!gate.ok) return fail(gate.message, `/anzeige/${az}/bearbeiten`)
    // Zuständige Stadt festschreiben (Tatort ist maßgeblich) – vor der PDF-/E-Mail-
    // Erzeugung, damit Formularwahl und Empfänger konsistent sind.
    if (gate.cityId !== report.city) {
      await pool.execute('UPDATE reports SET city=? WHERE id=?', [gate.cityId, report.id])
      report.city = gate.cityId
    }

    // PDF auf den letzten Stand bringen; eine frühere Ablehnung ist damit erledigt.
    // Den Grund vorher sichern – die Admin-Mail weist auf die Wiedervorlage hin.
    const vorherigeAblehnung = report.ablehnung_grund as string | null
    await regeneratePdf(report.id, userId)
    const [submitted] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE reports SET status='eingereicht', eingereicht_at=NOW(), ablehnung_grund=NULL WHERE id=? AND status='entwurf' AND versand_status IS NULL",
      [report.id]
    )
    if (!submitted.affectedRows) {
      return json ? reply.status(409).send({ error: 'Die Anzeige wird bereits bearbeitet.' }) : reply.redirect(`/anzeige/${az}`)
    }
    // Admins informieren – sonst kann eine Einreichung unbemerkt liegenbleiben.
    try {
      await MailService.sendSubmitNotification(
        adminEmails(),
        report,
        request.session.userEmail || '',
        vorherigeAblehnung
      )
    } catch (err) {
      app.log.error({ err }, 'Admin-Benachrichtigung zur Einreichung fehlgeschlagen')
    }
    if (json) return reply.send({ ok: true })
    setFlash(reply, 'success', 'Anzeige eingereicht – sie wird geprüft und dann ans Ordnungsamt verschickt.')
    return reply.redirect(`/anzeige/${az}`)
  })

  // Eingereichte Anzeige zurückziehen (wird wieder bearbeitbarer Entwurf).
  app.post('/anzeige/:az/withdraw', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'eingereicht') return reply.redirect(`/anzeige/${az}`)

    const [withdrawn] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE reports SET status='entwurf', eingereicht_at=NULL WHERE id=? AND status='eingereicht' AND versand_status IS NULL",
      [report.id]
    )
    if (!withdrawn.affectedRows) {
      setFlash(reply, 'error', 'Die Anzeige wird bereits versendet und kann nicht zurückgezogen werden.')
      return reply.redirect(`/anzeige/${az}`)
    }
    setFlash(reply, 'success', 'Anzeige zurückgezogen – sie ist wieder ein Entwurf.')
    return reply.redirect(`/anzeige/${az}/bearbeiten`)
  })
}
