// Gemeinsame Helfer der Anzeigen-Routen (src/routes/reports/*): Laden von
// Entwürfen, Feld-Persistierung, Vollständigkeits-/Profilprüfung und die
// PDF-Erzeugung samt ihrer Hintergrund-Jobs. Die registerJob()-Aufrufe am
// Modulende laufen genau einmal, weil dieses Modul über routes/reports.ts
// (Re-Exports) bei jedem Import der Anzeigen-Routen geladen wird.
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../../db/connection'
import { PdfService } from '../../services/pdf'
import { getCity, CITIES, hasPdfForm } from '../../config/cities'
import { VERSTOSS_ARTEN, VERSTOSS_HAEUFIG } from '../../config/verstoss'
import { FAHRZEUG_TYPEN, markeNormalisieren } from '../../config/fahrzeug'
import { ALLE_VARIANTEN, formularHilfen } from '../../services/portalFfm'
import { verstossSperren } from '../../services/portale'
import { cachedMailVariant } from '../../services/pixelate'
import { processReportImageDerivatives } from '../../services/intakeImageProcessing'
import { evidenceImageRows, pdfPath, reportDir } from '../../services/drafts'
import { MailService } from '../../services/mail'
import { adminEmails } from '../../config/admin'
import { enqueueJob, registerJob } from '../../services/jobs'
import { logger } from '../../services/logger'
import { loadUser } from '../../services/users'
import { imageVersion } from '../../services/images'
import { cleanText } from '../../utils/format'

// Re-Export für bestehende Importe (Views/Tests beziehen die Liste über reports.ts).
export { VERSTOSS_ARTEN }

export const MAX_IMAGES = 10

/** Buffer, den der PDF-Service einbettet. capturedAt = bereits formatierte
 *  Aufnahmezeit (z.B. "10.07.2026, 14:30") aus den EXIF-Daten, oder null. */
export type ReportImage = { mimetype: string; buffer: Buffer; capturedAt?: string | null }

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

export async function loadReport(
  reportId: string | number,
  userId: number
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM reports WHERE id = ? AND user_id = ? AND status <> 'papierkorb'",
    [reportId, userId]
  )
  return rows[0]
}

/** Wie loadReport, aber per Aktenzeichen (wird in den URLs/Links verwendet).
 *  Entwürfe im Papierkorb gelten für beide als nicht vorhanden. */
export async function loadReportByAktenzeichen(
  aktenzeichen: string,
  userId: number
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM reports WHERE aktenzeichen = ? AND user_id = ? AND status <> 'papierkorb'",
    [aktenzeichen, userId]
  )
  return rows[0]
}

/** Foto einer eigenen Anzeige (per Aktenzeichen) samt `report_id`.
 *  draftOnly: nur solange die Anzeige ein Entwurf ist; unsent: zusätzlich ohne
 *  laufenden/unklaren Versand. Bewusst kein `ri.*`: analyse_json (MEDIUMTEXT)
 *  bräuchte hier niemand, und die Bild-/Vorschau-Routen laufen sehr oft.
 *  imageId wird unverändert gebunden (manche Aufrufer reichen den Pfad-String,
 *  andere Number() – das bleibt, wie es war). */
export async function loadOwnedImage(
  az: string,
  imageId: string | number,
  userId: number,
  opts: { draftOnly?: boolean; unsent?: boolean } = {}
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ri.filename, ri.mimetype, ri.original_filename, ri.original_mimetype, ri.detected_plate,
            ri.kennzeichen_box, ri.kennzeichen_keins, r.id AS report_id
       FROM report_images ri JOIN reports r ON r.id = ri.report_id
      WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ?` +
      (opts.draftOnly ? " AND r.status = 'entwurf'" : '') +
      (opts.unsent ? ' AND r.versand_status IS NULL' : ''),
    [imageId, az, userId]
  )
  return rows[0]
}

/** Kontext der Review-Queue eines Foto-Imports: Position des aktuellen
 *  Entwurfs sowie vorheriger/nächster noch offener Entwurf des Batches. */
export async function loadQueueContext(
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

/** Varianten („Kreuzung/Einmündung") und „länger als 1 Stunde"-Gegenstücke je
 *  Verstoß – für Editor und Foto-Dialog (services/portalFfm.ts). */
export const FORMULAR_HILFEN = formularHilfen(VERSTOSS_ARTEN)

/** Je Stadt die im Online-Portal nicht wählbaren Verstöße (Indizes in
 *  VERSTOSS_ARTEN) – für jede Verstoß-Auswahl (verstoss-select.js). */
export const VERSTOSS_SPERREN = verstossSperren(VERSTOSS_ARTEN)

/** Fahrzeugtyp/-farbe/-modell und Tatbestand-Variante (Migration 0039) aus
 *  einem Request-Body – nur die übergebenen Felder, damit ältere Clients ohne
 *  diese Felder nichts leeren. Ungültige Werte ⇒ NULL. */
export function strukturFelder(body: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (typeof body.fahrzeug_typ === 'string') {
    out.fahrzeug_typ = (FAHRZEUG_TYPEN as readonly string[]).includes(body.fahrzeug_typ) ? body.fahrzeug_typ : null
  }
  if (typeof body.fahrzeug_farbe === 'string') out.fahrzeug_farbe = cleanText(body.fahrzeug_farbe, 40)
  if (typeof body.fahrzeug_modell === 'string') out.fahrzeug_modell = cleanText(body.fahrzeug_modell, 60)
  if (typeof body.verstoss_variante === 'string') {
    out.verstoss_variante = ALLE_VARIANTEN.has(body.verstoss_variante) ? body.verstoss_variante : null
  }
  return out
}

/** Kalendertag YYYY-MM-DD, der wirklich existiert (2026-02-30 nicht): Die
 *  DATE-Spalte lehnt Unsinn im strikten SQL-Modus mit einem Fehler ab, der
 *  sonst als 500 beim Nutzer landet. */
export function istDatum(raw: unknown): boolean {
  const v = String(raw ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** Uhrzeit HH:MM[:SS] mit gültigen Werten (25:99 scheiterte erst in der TIME-Spalte). */
export function istUhrzeit(raw: unknown): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(raw ?? '').trim())
}

/** Felder eines Entwurfs persistieren (leere Strings -> NULL). */
export async function persistFields(
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
  // public/js/map-common.js (OWIA.map.coord).
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
  // Formate und Längen wie in PATCH /anzeige/:az/felder: Der Autosave des
  // Editors schickt den ganzen Body ungeprüft – ein manipuliertes Datum
  // („foo") endete sonst als DB-Fehler (500), ein erfundener Verstoß außerhalb
  // des Katalogs erst beim Portal-Versand. Ungültiges wird hier zu NULL.
  const datum = (raw: string | undefined) => (istDatum(raw) ? (raw as string).trim() : null)
  const uhrzeit = (raw: string | undefined) => (istUhrzeit(raw) ? (raw as string).trim().slice(0, 5) : null)
  const text = (raw: string | undefined, max: number) => String(raw ?? '').trim().slice(0, max) || null
  const verstossArt = v.verstoss_art && VERSTOSS_ARTEN.includes(v.verstoss_art.trim()) ? v.verstoss_art.trim() : null
  await pool.execute(
    `UPDATE reports
       SET kennzeichen=?, kennzeichen_land=COALESCE(?, kennzeichen_land), fahrzeug_marke=?, tattag=?, tattag_bis=?, tatzeit_von=?, tatzeit_bis=?,
           tatort=?, tatort_lat=?, tatort_lon=?, verstoss_art=?, beschreibung=?,
           behinderung=?, behinderung_text=?, fahrzeug_verlassen=?, city=COALESCE(?, city)
     WHERE id=? AND user_id=? AND status='entwurf'`,
    [
      normalizePlate(v.kennzeichen),
      land,
      markeNormalisieren(text(v.fahrzeug_marke, 100)),
      datum(v.tattag),
      datum(tattagBis ?? undefined),
      uhrzeit(v.tatzeit_von),
      uhrzeit(v.tatzeit_bis),
      text(v.tatort?.replace(/\s+/g, ' '), 500),
      tatortLat,
      tatortLon,
      verstossArt,
      text(v.beschreibung, 5000),
      behinderung,
      text(behinderungText ?? undefined, 2000),
      fahrzeugVerlassen,
      city,
      reportId,
      userId,
    ]
  )
  const extra = strukturFelder(v)
  if (Object.keys(extra).length) {
    await pool.execute(
      `UPDATE reports SET ${Object.keys(extra).map((k) => `${k}=?`).join(', ')} WHERE id=? AND user_id=? AND status='entwurf'`,
      [...Object.values(extra), reportId, userId]
    )
  }
}

/** Kennzeichen vereinheitlichen, ohne ein Länderformat vorzuschreiben: Es gibt
 *  weltweit (und bei Rollern/Versicherungskennzeichen wie „123 ABC") keine
 *  gemeinsame Schreibweise. Großschreibung, Leerraum zusammenfassen, auf die
 *  Spaltenbreite (VARCHAR(20)) kürzen. */
export function normalizePlate(raw: string | undefined | null): string | null {
  const v = String(raw || '').toLocaleUpperCase('de-DE').replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, 20) : null
}

export function isComplete(r: mysql.RowDataPacket): boolean {
  return !!(r.kennzeichen && r.tattag && r.tatzeit_von && r.tatort && r.verstoss_art)
}

/** Häufig verwendete Verstöße für die Auswahl-Liste: tatsächliche Nutzung aus der
 *  DB (nur Einträge, die noch im aktuellen Katalog stehen) zuerst, aufgefüllt mit
 *  den kuratierten Defaults (VERSTOSS_HAEUFIG) – so ist die „Häufig"-Gruppe auch
 *  ohne Nutzungshistorie sinnvoll gefüllt. */
export async function mostUsedVerstoesse(limit = 12): Promise<string[]> {
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

/** Foto-Kennzahlen je Anzeige für die Tabellen-Listen (Duplikat-Hinweise,
 *  Tatzeit aus Foto, GPS-Hinweis in report-row.ejs). `alias` = Tabelle bzw.
 *  Alias der reports-Zeile in der äußeren Abfrage. Die Einzelzeile
 *  (editor.ts, /listenzeile) rechnet dieselben Werte in JS nach. */
export function photoStatColumns(alias: string): string {
  return `(SELECT DATE_FORMAT(MIN(pt.captured_at), '%Y-%m-%d %H:%i') FROM report_images pt WHERE pt.report_id = ${alias}.id) AS photo_time_min,
              (SELECT GROUP_CONCAT(DISTINCT dp.detected_plate ORDER BY dp.detected_plate SEPARATOR '|') FROM report_images dp WHERE dp.report_id = ${alias}.id AND dp.detected_plate IS NOT NULL AND dp.detected_plate <> '') AS detected_plates,
              (SELECT COUNT(*) FROM report_images gi WHERE gi.report_id = ${alias}.id AND gi.gps_lat IS NOT NULL AND gi.gps_lon IS NOT NULL) AS photo_gps_count`
}

/** Ein Foto der Thumbnail-Leiste in report-row.ejs. */
export type StripImage = { id: number; v: string; ok: boolean; plate: string | null; zeit?: string | null }

export function stripImage(img: mysql.RowDataPacket): StripImage {
  return { id: img.id, v: imageVersion(img.filename), ok: img.geprueft_at !== null, plate: img.detected_plate || null }
}

/** Thumbnail-Leisten aller Anzeigen, die `where` (über Alias r = reports)
 *  trifft, gruppiert nach report_id. zeit: Aufnahmeuhrzeit mitliefern
 *  (data-zeit, nur die Anzeigenliste nutzt sie). */
export async function thumbStrips(
  where: string,
  params: (string | number)[],
  opts: { zeit?: boolean } = {}
): Promise<Record<number, StripImage[]>> {
  const [images] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT ri.id, ri.report_id, ri.filename, ri.geprueft_at, ri.detected_plate${
      opts.zeit ? ", DATE_FORMAT(ri.captured_at, '%H:%i') AS zeit" : ''
    }
       FROM report_images ri
       JOIN reports r ON r.id = ri.report_id
      WHERE ${where}
      ORDER BY ri.report_id, ri.sort_order, ri.id`,
    params
  )
  const byReport: Record<number, StripImage[]> = {}
  for (const img of images) {
    ;(byReport[img.report_id] ??= []).push(opts.zeit ? { ...stripImage(img), zeit: img.zeit || null } : stripImage(img))
  }
  return byReport
}

/** Profil vollständig? Das Ordnungsamt bearbeitet anonyme Anzeigen nicht –
 *  Name und Anschrift des Anzeigenerstatters müssen im PDF stehen. */
export async function isProfileComplete(userId: number): Promise<boolean> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT vorname, nachname, strasse, hausnummer, plz, ort FROM users WHERE id = ?',
    [userId]
  )
  const u = rows[0]
  // Hausnummer getrennt (Migration 0039): das Frankfurter Portal verlangt sie
  // als eigenes Pflichtfeld.
  return !!(u && u.vorname && u.nachname && u.strasse && u.hausnummer && u.plz && u.ort)
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
        await fs.rm(pdfPath(userId, report.pdf_filename), { force: true })
      } catch {
        /* egal */
      }
      await pool.execute('UPDATE reports SET pdf_filename=NULL WHERE id=?', [reportId])
    }
    return
  }

  const user = (await loadUser(userId))!
  const imgRows = await evidenceImageRows(reportId)

  const dir = reportDir(userId, reportId)
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
      await fs.rm(pdfPath(userId, report.pdf_filename), { force: true })
    } catch {
      /* egal */
    }
  }

  try {
    const filename = await PdfService.generate(report, user, images)
    await pool.execute('UPDATE reports SET pdf_filename=? WHERE id=?', [filename, reportId])
  } catch (err) {
    // PDF-Erzeugung darf den Workflow nicht blockieren; Vorschau bleibt dann leer.
    logger.error({ err, reportId, userId }, 'PDF-Generierung fehlgeschlagen')
  }
}

/** PDF-Neuerzeugung als Hintergrund-Job; mehrfaches Einreihen derselben Anzeige
 *  wird zusammengefasst (pending_key). */
export function enqueuePdf(reportId: string | number, userId: number): Promise<void> {
  return enqueueJob('report.pdf', { reportId: Number(reportId), userId }, { key: `report.pdf:${reportId}` })
}

registerJob('report.pdf', async ({ reportId, userId }) => {
  await regeneratePdf(reportId, userId)
})

registerJob('mail.submit-notification', async ({ reportId, userId, userEmail, vorherigeAblehnung }) => {
  const report = await loadReport(reportId, userId)
  if (!report) return
  await MailService.sendSubmitNotification(adminEmails(), report, userEmail, vorherigeAblehnung)
})

/** Anzahl noch nicht bestätigter Fotos einer Anzeige (Foto-Prüfung). */
export async function countUncheckedImages(reportId: number): Promise<number> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM report_images WHERE report_id = ? AND geprueft_at IS NULL',
    [reportId]
  )
  return Number(rows[0].c)
}

export function uncheckedMessage(n: number): string {
  return n === 1
    ? 'Ein Foto ist noch nicht geprüft – in der Liste anklicken, bei Bedarf schwärzen und bestätigen.'
    : `${n} Fotos sind noch nicht geprüft – in der Liste jedes Foto anklicken, bei Bedarf schwärzen und bestätigen.`
}
