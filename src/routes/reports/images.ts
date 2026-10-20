// Beweisfotos einer Anzeige: Upload, Ersetzen (Schwärzen), Löschen, Rollen/
// Dritte-Bestätigung, Sortierung, Verschieben zwischen Entwürfen sowie die
// Auslieferung von Bild, Vorschaubild und Kennzeichen-Ausschnitt.
import { FastifyInstance, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs/promises'
import { pool } from '../../db/connection'
import { requireAuth } from '../../middleware/auth'
import { queueTatortFill } from '../../services/tatortFill'
import { removeImagePair, removeDerivedFiles } from '../../services/images'
import { processReportImage, processReportImageDerivatives, processReplacementImage, loadThumbnail, withIntakeUploadLock, ReplacementResult } from '../../services/intakeImageProcessing'
import { createDraft, deleteDraft, isEditableDraft, reportDir, insertImageRow, imageCount, nextSortOrder } from '../../services/drafts'
import { alprEnabled, recognizePlate } from '../../services/alpr'
import { queuePlateAnalysis, queueAnalyseOnly, plateCropName, bestPlateForReport, prefillReportPlate, bestFahrzeugForReport, prefillReportFahrzeug } from '../../services/plateAnalysis'
import { photoSha256, findExistingPhoto } from '../../services/photoDedup'
import { parseKennzeichenBox } from '../../services/dritte'
import { queueAutoSchwaerzen } from '../../services/dritteSchwaerzen'
import { MAX_IMAGES, loadReportByAktenzeichen, loadOwnedImage, enqueuePdf } from './shared'

/** Abgeleitete Dateien (Vorschaubild, Versandfassung) im Worker-Thread
 *  berechnen. jpeg-js dekodiert synchron – im HTTP-Prozess blockierte das bei
 *  jedem Upload/Speichern sekundenlang ALLE anderen Requests. Bewusst nicht
 *  awaited: Fehlt ein Vorschaubild noch, rechnet sendThumbnail() es vorrangig nach. */
function queueDerivatives(dir: string, filename: string, mimetype: string): void {
  processReportImageDerivatives(filename, mimetype, dir).catch(() => {})
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

/** Ergebnis von saveImageToReport: gespeichert oder abgelehnt (Limit/Duplikat). */
export type SaveImageResult =
  | { ok: true; id: number; filename: string; mimetype: string; capturedAt: string | null }
  | { ok: false; grund: 'voll' }
  | { ok: false; grund: 'doppelt'; existing: string }

/** Bild zum Entwurf auf Platte + in der DB speichern.
 *  HEIC-Konvertierung und EXIF-Lesen (aus dem Original – die Konvertierung
 *  entfernt die Metadaten) laufen im Worker-Thread, bewusst AUSSERHALB der
 *  Nutzer-Sperre (dauert bei HEIC Sekunden). Bildlimit und Duplikatprüfung
 *  werden danach unter withIntakeUploadLock zusammen mit dem INSERT
 *  entschieden: Zwei parallele Uploads sahen vorher denselben Zählerstand bzw.
 *  denselben „noch nicht vorhanden“-Befund und kamen beide durch. Abgelehnte
 *  Uploads räumen ihre schon geschriebenen Dateien wieder weg. Aufrufer sollten
 *  vorab ohne Sperre grob prüfen (imageCount/findExistingPhoto), damit
 *  offensichtliche Ablehnungen nicht erst durch den Worker laufen.
 *  Wirft, wenn das Bild nicht verarbeitet werden kann (kein JPG/PNG/HEIC). */
export async function saveImageToReport(
  userId: number,
  reportId: number,
  upload: { buffer: Buffer; filename: string; mimetype: string },
  sha256: string
): Promise<SaveImageResult> {
  const dir = reportDir(userId, reportId)
  const p = await processReportImage(upload.buffer, upload.filename, upload.mimetype, dir)
  const { filename, originalFilename, meta } = p

  const result = await withIntakeUploadLock(userId, async (): Promise<SaveImageResult> => {
    if ((await imageCount(reportId)) >= MAX_IMAGES) return { ok: false, grund: 'voll' }
    const existing = await findExistingPhoto(userId, sha256)
    if (existing) return { ok: false, grund: 'doppelt', existing }
    // Neues Bild ans Ende der Sortierreihenfolge hängen.
    const id = await insertImageRow(reportId, {
      filename,
      mimetype: p.mimetype,
      originalFilename,
      originalMimetype: p.originalMimetype,
      sortOrder: await nextSortOrder(reportId),
      capturedAt: meta.capturedAt,
      gpsLat: meta.lat,
      gpsLon: meta.lon,
      sha256,
    })
    return { ok: true, id, filename, mimetype: p.mimetype, capturedAt: meta.capturedAt }
  }).catch(async (err) => {
    await removeImagePair(dir, filename, originalFilename)
    throw err
  })
  if (!result.ok) {
    await removeImagePair(dir, filename, originalFilename)
    return result
  }
  queueDerivatives(dir, filename, p.mimetype)
  return result
}

/** Bild-URLs mit ?v=<Fassung> (imageVersion) ändern sich bei jeder neuen
 *  Fassung und dürfen lange gecacht werden – Listen laden Fotos dann nur einmal.
 *  Ohne Version (Editor, Karten-Marker) nur kurz, sonst bliebe nach dem
 *  Schwärzen die alte Fassung im Browser-Cache sichtbar. */
function cacheControlFor(request: FastifyRequest): string {
  return (request.query as { v?: string }).v ? 'private, max-age=604800' : 'private, max-age=60'
}

export default async function imageRoutes(app: FastifyInstance) {
  // Einzelnes (ggf. bereits geschwärztes) Bild sofort zum Entwurf hochladen.
  app.post('/anzeige/:az/images', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })
    const reportId = report.id

    const saved: { id: number; url: string; capturedAt: string | null }[] = []
    const errors: string[] = []
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        if (part.fieldname !== 'bilder' || !part.filename) continue
        const buffer = await part.toBuffer()
        if (buffer.length === 0) continue
        // Grobe Vorprüfung ohne Sperre (spart bei vollem Entwurf/Duplikat die
        // Bildverarbeitung); verbindlich entscheidet saveImageToReport unter
        // der Nutzer-Sperre zusammen mit dem INSERT.
        if ((await imageCount(reportId)) >= MAX_IMAGES) {
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
          if (!row.ok) {
            errors.push(row.grund === 'voll'
              ? `Maximal ${MAX_IMAGES} Bilder pro Anzeige.`
              : `${part.filename}: Bereits vorhanden (${row.existing}) – übersprungen.`)
            continue
          }
          // Kennzeichen im Hintergrund erkennen; Ergebnis holt das Formular per Poll.
          queuePlateAnalysis(userId, reportId, row.id, row.filename, row.mimetype)
          // Tatort leer? Aus den GPS-Daten des neuen Fotos nachtragen.
          queueTatortFill(reportId)
          saved.push({ id: row.id, url: `/anzeige/${az}/image/${row.id}`, capturedAt: row.capturedAt })
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

    const img = await loadOwnedImage(az, imageId, userId, { draftOnly: true })
    if (!img) return reply.status(404).send({ error: 'not found' })

    await pool.execute('DELETE FROM report_images WHERE id = ?', [imageId])
    await removeImageFiles(userId, img.report_id, img.filename, img.original_filename)
    return reply.send({ ok: true })
  })

  // Bestehendes Bild durch eine neue (z.B. geschwärzte) Fassung ersetzen.
  // Die Bild-ID bleibt erhalten, das Bilder-Limit wird nicht berührt.
  // Warnung „Daten Dritter" für ein Foto als unbedenklich bestätigen (oder
  // zurücknehmen). Nach dem Ersetzen des Fotos gilt sie wieder (PUT setzt zurück).
  app.patch('/anzeige/:az/images/:imageId/dritte', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const ok = (request.body as { ok?: unknown } | undefined)?.ok === true ? 1 : 0
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE report_images ri JOIN reports r ON r.id = ri.report_id
          SET ri.dritte_ok = ?
        WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ? AND r.status = 'entwurf' AND r.versand_status IS NULL`,
      [ok, Number(imageId), az, userId]
    )
    if (!res.affectedRows) return reply.status(409).send({ error: 'Nur Fotos von Entwürfen lassen sich bestätigen.' })
    return reply.send({ ok: true })
  })

  app.put('/anzeige/:az/images/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number

    const old = await loadOwnedImage(az, imageId, userId, { draftOnly: true })
    if (!old) return reply.status(404).send({ error: 'not found' })

    let upload: Buffer | null = null
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'bilder' || !part.filename) continue
        const buffer = await part.toBuffer()
        if (buffer.length === 0) continue
        upload = buffer
        break // nur das erste Bild ersetzt die bestehende Fassung
      }
    } catch {
      return reply.status(413).send({ error: 'Bild zu groß (max. 20 MB).' })
    }
    if (!upload) {
      return reply.status(400).send({ error: 'Kein gültiges Bild übermittelt.' })
    }

    // Nur die neue nutzbare Fassung schreiben – original_filename bleibt auf dem
    // Erst-Upload stehen, damit eine (auch versehentliche) Schwärzung das
    // unbearbeitete Original nie vernichtet (es bleibt als Beleg auf der Platte
    // und geht in den Datenexport ein). Typprüfung/HEIC-Konvertierung samt
    // Pixel-Limit laufen im Bild-Worker, nie hier im Request.
    const dir = reportDir(userId, old.report_id)
    let replaced: ReplacementResult
    try {
      replaced = await processReplacementImage({ buffer: upload }, dir)
    } catch {
      return reply.status(400).send({ error: 'Nur JPG-, PNG- und HEIC/HEIF-Bilder (bis 80 Megapixel) werden unterstützt.' })
    }
    const { filename, mimetype } = replaced

    // Neue Fassung = neues Foto für alle Prüfungen: Datenschutz-Analyse,
    // Dritte-Freigabe, Kennzeichen-Markierung und „geprüft“ gelten nur für die
    // alte Fassung (wie bei „⟲ Original“). Ohne geprueft_at=NULL ließ sich ein
    // bestätigtes Foto nachträglich durch ein beliebiges ungeprüftes ersetzen.
    // photo-edit.js setzt Box und „geprüft“ nach dem PUT neu. Die eigene Fassung
    // gehört dem Nutzer: kein automatisches Schwärzen mehr (auto_schwaerzen_aus).
    // Guard auf die bisherige Fassung (filename) und den Entwurfsstatus: Bei
    // zwei parallelen PUTs (oder Verschieben/Auto-Schwärzen dazwischen) gewinnt
    // genau einer; der Verlierer räumt seine Datei weg, statt eine Fassung zu
    // überschreiben, deren Datei der andere schon gelöscht hat.
    const [upd] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE report_images ri JOIN reports r ON r.id = ri.report_id
          SET ri.filename=?, ri.mimetype=?, ri.analyse_json=NULL, ri.dritte_ok=0,
              ri.kennzeichen_box=NULL, ri.kennzeichen_keins=0, ri.geprueft_at=NULL,
              ri.auto_schwaerzen_aus=1
        WHERE ri.id=? AND ri.report_id=? AND ri.filename=? AND r.status='entwurf'`,
      [filename, mimetype, Number(imageId), old.report_id, old.filename]
    )
    if (!upd.affectedRows) {
      await fs.rm(path.join(dir, filename), { force: true }).catch(() => {})
      return reply.status(409).send({ error: 'Das Foto wurde gerade geändert – bitte erneut versuchen.' })
    }
    queueDerivatives(dir, filename, mimetype)

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
    // Die Datenschutz-Analyse (fremde Kennzeichen, Gesichter) gilt dagegen immer
    // nur für die alte Fassung: oben verworfen, hier für die neue neu erstellt.
    if (old.detected_plate === null) {
      await pool.execute(
        `UPDATE report_images
           SET detected_plate=NULL, plate_confidence=NULL, analysis_status=NULL, analyzed_at=NULL
         WHERE id=?`,
        [imageId]
      )
      queuePlateAnalysis(userId, old.report_id, Number(imageId), filename, mimetype)
    } else {
      queueAnalyseOnly(userId, old.report_id, Number(imageId), filename, mimetype)
    }

    return reply.send({ image: { id: Number(imageId), url: `/anzeige/${az}/image/${imageId}` } })
  })

  // Original wiederherstellen (Foto-Dialog „⟲ Original"): verwirft alle
  // eingebackenen Bearbeitungen – Schwärzungen (auch die automatischen aus
  // services/dritteSchwaerzen.ts), Zuschnitt, Drehen –, damit sich eine falsche
  // Schwärzung korrigieren lässt („Schwärzung aufheben"). Danach ist das Foto
  // wieder ungeprüft und die Datenschutz-Analyse frisch: Fremde Funde sperren
  // das Einreichen wie beim Erst-Upload, bis sie im Dialog geschwärzt oder
  // freigegeben sind – automatisch geschwärzt wird dieses Foto nicht mehr
  // (auto_schwaerzen_aus, ebenso nach jeder eigenen Fassung per PUT).
  app.post('/anzeige/:az/images/:imageId/original', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const old = await loadOwnedImage(az, Number(imageId), userId, { draftOnly: true, unsent: true })
    if (!old) return reply.status(409).send({ error: 'Nur Fotos von Entwürfen lassen sich zurücksetzen.' })
    if (!old.original_filename || old.filename === old.original_filename) {
      return reply.send({ image: { id: Number(imageId), url: `/anzeige/${az}/image/${imageId}` }, unveraendert: true })
    }

    const dir = reportDir(userId, old.report_id)
    const originalPath = path.join(dir, old.original_filename)
    try {
      await fs.access(originalPath)
    } catch {
      return reply.status(410).send({ error: 'Das Original dieses Fotos ist nicht mehr vorhanden.' })
    }
    // JPG/PNG: das Original ist selbst die nutzbare Fassung (wie nach dem
    // Upload). HEIC: neu konvertieren – das Original bleibt unangetastet. Beides
    // im Bild-Worker (Typ aus den Bytes, HEIC mit Pixel-Limit), nie im Request.
    let filename: string = old.original_filename
    let mimetype: string
    try {
      const r = await processReplacementImage({ rawPath: originalPath }, dir, { nurKonvertiert: true })
      mimetype = r.mimetype
      if (r.converted) filename = r.filename
    } catch {
      return reply.status(422).send({ error: 'Das Original lässt sich nicht lesen.' })
    }

    const [res] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE report_images SET filename=?, mimetype=?, analyse_json=NULL, dritte_ok=0,
              kennzeichen_box=NULL, kennzeichen_keins=0, geprueft_at=NULL,
              auto_geschwaerzt=0, auto_schwaerzen_aus=1
        WHERE id=? AND filename=?`,
      [filename, mimetype, Number(imageId), old.filename]
    )
    if (!res.affectedRows) {
      if (filename !== old.original_filename) await fs.rm(path.join(dir, filename), { force: true }).catch(() => {})
      return reply.status(409).send({ error: 'Das Foto wurde gerade geändert – bitte erneut versuchen.' })
    }
    // Kennzeichen-Ausschnitt (aus der Erkennung des Originals) mitnehmen, dann
    // die bearbeitete Fassung samt Ableitungen wegräumen.
    if (old.detected_plate !== null) {
      await fs.rename(path.join(dir, plateCropName(old.filename)), path.join(dir, plateCropName(filename))).catch(() => {})
    }
    await fs.rm(path.join(dir, old.filename), { force: true }).catch(() => {})
    await removeDerivedFiles(dir, old.filename)
    queueDerivatives(dir, filename, mimetype)

    // Analyse direkt hier statt in der Queue: Der Dialog zeigt die fremden
    // Funde gleich nach dem Zurücksetzen als Schwärzungs-Vorschlag an.
    const result = alprEnabled() ? await recognizePlate(path.join(dir, filename), mimetype).catch(() => null) : null
    if (result?.analyse) {
      await pool.execute('UPDATE report_images SET analyse_json=? WHERE id=? AND filename=?', [JSON.stringify(result.analyse), Number(imageId), filename])
    } else {
      queueAnalyseOnly(userId, old.report_id, Number(imageId), filename, mimetype)
    }
    return reply.send({ image: { id: Number(imageId), url: `/anzeige/${az}/image/${imageId}` } })
  })

  // Kennzeichen des angezeigten Fahrzeugs auf dem Foto markieren (Prüf-Dialog):
  // { box: [x1,y1,x2,y2] } als Anteile 0..1 der gespeicherten Fassung oder
  // { keins: true }. Die Übersichtskarte schwärzt die Box (services/pixelate.ts).
  app.patch('/anzeige/:az/images/:imageId/kennzeichen', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const body = (request.body ?? {}) as { box?: unknown; keins?: unknown }
    const keins = body.keins === true
    const box = keins ? null : parseKennzeichenBox(Array.isArray(body.box) ? body.box.map((v) => Math.round(Number(v) * 1e4) / 1e4) : null)
    if (!keins && !box) return reply.status(400).send({ error: 'Bitte das Kennzeichen auf dem Foto markieren.' })
    const img = await loadOwnedImage(az, Number(imageId), userId, { draftOnly: true })
    if (!img) return reply.status(404).send({ error: 'not found' })
    await pool.execute('UPDATE report_images SET kennzeichen_box=?, kennzeichen_keins=? WHERE id=?', [
      box ? JSON.stringify(box) : null, keins ? 1 : 0, Number(imageId),
    ])
    // Kartenfassung neu rechnen lassen.
    await fs.rm(path.join(reportDir(userId, img.report_id), `${img.filename}.pixel.jpg`), { force: true }).catch(() => {})
    return reply.send({ ok: true })
  })

  // Foto als geprüft bestätigen (Prüf-Dialog in photo-edit.js): Der Nutzer hat
  // es angesehen, bei Bedarf geschwärzt und das Kennzeichen markiert (oder
  // „keins sichtbar" bestätigt). Einreichen geht erst, wenn alle Fotos einer
  // Anzeige bestätigt sind (countUncheckedImages).
  app.post('/anzeige/:az/images/:imageId/geprueft', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const mark = await loadOwnedImage(az, Number(imageId), userId)
    if (mark && !mark.kennzeichen_keins && !parseKennzeichenBox(mark.kennzeichen_box)) {
      return reply.status(400).send({ error: 'Bitte zuerst das Kennzeichen auf dem Foto markieren.' })
    }
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      `UPDATE report_images ri
         JOIN reports r ON r.id = ri.report_id
          SET ri.geprueft_at = COALESCE(ri.geprueft_at, NOW())
        WHERE ri.id = ? AND r.aktenzeichen = ? AND r.user_id = ? AND r.status = 'entwurf'`,
      [imageId, az, userId]
    )
    if (!res.affectedRows) return reply.status(404).send({ error: 'not found' })
    return reply.send({ ok: true })
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
    // Vorschlag = Mehrheit der sicheren Lesungen über alle Bilder (dieselbe
    // Regel wie die serverseitige Vorbefüllung); unsichere Lesungen werden dem
    // Nutzer gar nicht erst vorgeschlagen.
    const best = await bestPlateForReport(report.id)
    const fz = await bestFahrzeugForReport(report.id, report.fahrzeug_marke)
    return reply.send({
      status: pending ? 'pending' : 'done',
      suggestions: {
        kennzeichen: best?.plate ?? null,
        confidence: best?.confidence ?? null,
        fahrzeug_marke: fz.marke?.wert ?? null,
        fahrzeug_farbe: fz.farbe?.wert ?? null,
        // Nur als anklickbarer Vorschlag (report-form.js), nie vorbefüllt.
        fahrzeug_modell: fz.modell?.wert ?? null,
      },
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
  // Foto duplizieren (Foto-Dialog, z. B. einziges Foto: Kopie als
  // Nahaufnahme zuschneiden). Kopiert Datei, Original und Vorschaubild; die
  // Kopie steht ungeprüft am Ende, alle übrigen Spalten (Analyse, Erkennung,
  // EXIF, Kennzeichen-Box …) wie beim Vorbild.
  app.post('/anzeige/:az/images/:imageId/duplizieren', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (!isEditableDraft(report)) return reply.status(409).send({ error: 'Nur Entwürfe können bearbeitet werden.' })
    // Vorprüfung ohne Sperre (spart das Kopieren); verbindlich unten unter der Sperre.
    if ((await imageCount(report.id)) >= MAX_IMAGES) return reply.status(409).send({ error: `Höchstens ${MAX_IMAGES} Fotos je Anzeige.` })
    const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM report_images WHERE id = ? AND report_id = ?', [Number(imageId), report.id])
    const img = rows[0]
    if (!img) return reply.status(404).send({ error: 'not found' })

    const dir = reportDir(userId, report.id)
    const neuName = (f: string) => `bild-${crypto.randomBytes(6).toString('hex')}${path.extname(f)}`
    const filename = neuName(img.filename)
    await fs.copyFile(path.join(dir, img.filename), path.join(dir, filename))
    let original = filename
    if (img.original_filename && img.original_filename !== img.filename) {
      original = neuName(img.original_filename)
      await fs.copyFile(path.join(dir, img.original_filename), path.join(dir, original)).catch(() => { original = filename })
    }
    for (const ext of ['.thumb.jpg', '.mail.jpg']) {
      await fs.copyFile(path.join(dir, img.filename + ext), path.join(dir, filename + ext)).catch(() => {})
    }
    await fs.copyFile(path.join(dir, plateCropName(img.filename)), path.join(dir, plateCropName(filename))).catch(() => {})

    // Zählen + INSERT unter der Nutzer-Sperre (wie Upload/Verschieben), sonst
    // kamen parallele Duplikate gemeinsam über MAX_IMAGES.
    const insertId = await withIntakeUploadLock(userId, async () => {
      const [cnt] = await pool.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c, COALESCE(MAX(sort_order), 0) AS m FROM report_images WHERE report_id = ?', [report.id])
      if (Number(cnt[0].c) >= MAX_IMAGES) return null
      const werte: Record<string, unknown> = { ...img, filename, original_filename: original, sort_order: Number(cnt[0].m) + 1, geprueft_at: null }
      delete werte.id
      const spalten = Object.keys(werte)
      const [res] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO report_images (${spalten.map((c) => `\`${c}\``).join(', ')}) VALUES (${spalten.map(() => '?').join(', ')})`,
        spalten.map((c) => (werte[c] === undefined ? null : werte[c])) as any[]
      )
      return res.insertId
    })
    if (insertId === null) {
      await removeImagePair(dir, filename, original)
      return reply.status(409).send({ error: `Höchstens ${MAX_IMAGES} Fotos je Anzeige.` })
    }
    return reply.send({ image: { id: insertId, put: `/anzeige/${az}/images/${insertId}` } })
  })

  app.post('/anzeige/:az/images/reorder', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'not found' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'not a draft' })

    const body = (request.body || {}) as { order?: unknown }
    // Nur echte Bild-IDs dieses Reports, jede einmal: Ohne Filter lief pro
    // übergebenem Element ein UPDATE – eine Liste mit 100 000 Einträgen hielt
    // die DB entsprechend lange beschäftigt. So bleibt es bei höchstens so
    // vielen UPDATEs, wie die Anzeige Fotos hat (≤ MAX_IMAGES).
    const [own] = await pool.execute<mysql.RowDataPacket[]>('SELECT id FROM report_images WHERE report_id = ?', [report.id])
    const ownIds = new Set(own.map((r) => Number(r.id)))
    const order = Array.isArray(body.order)
      ? [...new Set(body.order.map((v) => Number(v)).filter((n) => ownIds.has(n)))]
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

  app.get('/anzeige/:az/image/:imageId', { preHandler: requireAuth }, async (request, reply) => {
    const { az, imageId } = request.params as { az: string; imageId: string }
    const userId = request.session.userId as number
    const wantOriginal = (request.query as { original?: string }).original === '1'

    const image = await loadOwnedImage(az, imageId, userId)
    if (!image) return reply.status(404).send('Bild nicht gefunden.')

    const filename = wantOriginal ? image.original_filename : image.filename
    const mimetype = wantOriginal ? image.original_mimetype : image.mimetype

    const imagePath = path.join(reportDir(userId, image.report_id), filename)
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

    const image = await loadOwnedImage(az, imageId, userId)
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

    const image = await loadOwnedImage(az, imageId, userId)
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
}

// Fotos in einen anderen eigenen Entwurf oder eine neue Anzeige verschieben
// (Mehrfachauswahl im Editor, Drag & Drop in den Listen). Dateien wandern
// physisch mit, die Bilder landen am Ende der Ziel-Sortierung.
export async function moveImages(
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
  if (!isEditableDraft(source)) return { status: 409, body: { error: 'not a draft' } }

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
    if (!isEditableDraft(target)) {
      return { status: 409, body: { error: 'Ziel-Anzeige ist kein Entwurf mehr.' } }
    }
    // Vorprüfung ohne Sperre (spart das Kopieren); verbindlich unten in der Transaktion.
    if ((await imageCount(target.id)) + imgs.length > MAX_IMAGES) {
      return { status: 400, body: { error: `Maximal ${MAX_IMAGES} Bilder pro Anzeige.` } }
    }
    targetId = target.id
    resolvedTargetAz = target.aktenzeichen
  }

  const from = reportDir(userId, source.id)
  const to = reportDir(userId, targetId)
  await fs.mkdir(to, { recursive: true })
  // Reihenfolge: erst kopieren, dann DB umhängen, zuletzt Quellen löschen.
  // Ein Abbruch nach dem Kopieren lässt die DB auf den alten (noch
  // vorhandenen) Ort zeigen; ein Abbruch nach dem DB-Schreiben hinterlässt
  // nur überzählige Kopien im Quellordner. Mit rename() vor dem UPDATE war
  // das Bild nach einem Neustart dazwischen dauerhaft verwaist (404 im PDF).
  const dateien = (img: mysql.RowDataPacket) => [
    img.filename,
    img.original_filename && img.original_filename !== img.filename ? img.original_filename : '',
    // Gecachte Ableitungen (Vorschau, Pixelbild, Versandfassung, Kennzeichen-Ausschnitt).
    ...['.thumb.jpg', '.pixel.jpg', '.mail.jpg', '.plate.jpg'].map((s) => img.filename + s),
  ].filter(Boolean) as string[]
  // Kopien im Ziel wieder entfernen – außer für Fotos, die (durch einen
  // parallelen Request) inzwischen tatsächlich im Ziel stehen: deren Dateien
  // sind dieselben Namen und gehören dann jener Zeile.
  const kopienEntfernen = async () => {
    const [imZiel] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM report_images WHERE report_id = ? AND id IN (${imgs.map(() => '?').join(',')})`,
      [targetId, ...imgs.map((i) => i.id)]
    )
    const behalten = new Set(imZiel.map((r) => Number(r.id)))
    for (const img of imgs) {
      if (behalten.has(Number(img.id))) continue
      for (const f of dateien(img)) await fs.rm(path.join(to, f), { force: true }).catch(() => {})
    }
  }
  const neuerEntwurfWeg = async () => {
    if (dest.newDraft) await deleteDraft(userId, { id: targetId }).catch(() => {})
  }
  try {
    for (const img of imgs) {
      for (const f of dateien(img)) {
        await fs.copyFile(path.join(from, f), path.join(to, f)).catch((err) => {
          // Pflichtdateien müssen kopierbar sein; fehlende Caches sind egal.
          if (f === img.filename || f === img.original_filename) throw err
        })
      }
    }
  } catch (err) {
    await kopienEntfernen()
    await neuerEntwurfWeg()
    throw err
  }

  // Umhängen unter der Nutzer-Sperre und in einer Transaktion: Bildlimit des
  // Ziels, Entwurfsstatus beider Anzeigen und „Foto liegt noch in der Quelle“
  // werden hier verbindlich geprüft. Vorher zählte nur die Vorprüfung oben –
  // parallele Verschiebe-/Upload-Requests kamen gemeinsam über MAX_IMAGES, und
  // ein zwischendurch eingereichter Entwurf verlor oder bekam noch Fotos.
  const ergebnis = await withIntakeUploadLock(userId, async (): Promise<'ok' | 'voll' | 'kein-entwurf' | 'weg'> => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      // FOR UPDATE: ein paralleles Einreichen wartet bis zum Commit.
      const [entwuerfe] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM reports WHERE id IN (?, ?) AND user_id = ? AND status = 'entwurf' AND versand_status IS NULL FOR UPDATE`,
        [source.id, targetId, userId]
      )
      if (entwuerfe.length !== 2) { await conn.rollback(); return 'kein-entwurf' }
      if ((await imageCount(targetId, conn)) + imgs.length > MAX_IMAGES) { await conn.rollback(); return 'voll' }
      let sortOrder = await nextSortOrder(targetId, conn)
      for (const img of imgs) {
        const [upd] = await conn.execute<mysql.ResultSetHeader>(
          'UPDATE report_images SET report_id = ?, sort_order = ? WHERE id = ? AND report_id = ?',
          [targetId, sortOrder++, img.id, source.id]
        )
        if (!upd.affectedRows) { await conn.rollback(); return 'weg' }
      }
      await conn.commit()
      return 'ok'
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      conn.release()
    }
  }).catch(async (err) => {
    await kopienEntfernen()
    await neuerEntwurfWeg()
    throw err
  })
  if (ergebnis !== 'ok') {
    await kopienEntfernen()
    await neuerEntwurfWeg()
    if (ergebnis === 'voll') return { status: 400, body: { error: `Maximal ${MAX_IMAGES} Bilder pro Anzeige.` } }
    if (ergebnis === 'kein-entwurf') return { status: 409, body: { error: 'Quelle oder Ziel ist kein Entwurf mehr.' } }
    return { status: 409, body: { error: 'Die Fotos wurden gerade geändert – bitte neu laden.' } }
  }
  for (const img of imgs) for (const f of dateien(img)) await fs.rm(path.join(from, f), { force: true }).catch(() => {})

  // Kennzeichen, Marke und Farbe des Ziels aus den mitgewanderten Lesungen vorbefüllen (z.B.
  // neue Anzeige per Drag & Drop) – vor der Antwort, damit die neu geholte
  // Listenzeile es schon zeigt. Noch laufende Analysen schlagen selbst unter
  // der neuen Anzeige nach (runAnalysis) und befüllen danach.
  await prefillReportPlate(userId, targetId).catch(() => {})
  await prefillReportFahrzeug(userId, targetId).catch(() => {})
  // Ziel hat evtl. ein anderes Kennzeichen – „fremd" neu bewerten.
  queueAutoSchwaerzen(targetId)

  // PDFs im Hintergrund nachziehen: Beide sind Entwürfe, „Speichern" und
  // „Einreichen" erzeugen das PDF ohnehin neu – der Nutzer soll nach dem
  // Verschieben nicht auf zwei PDF-Läufe warten.
  await enqueuePdf(source.id, userId)
  await enqueuePdf(targetId, userId)
  // Ziel ohne Tatort (z. B. neue Anzeige aus Fotos): aus deren GPS nachtragen.
  queueTatortFill(targetId)
  return { status: 200, body: { ok: true, targetAz: resolvedTargetAz, moved: imgs.length } }
}
