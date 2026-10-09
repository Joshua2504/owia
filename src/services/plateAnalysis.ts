// Hintergrund-Erkennung des Kennzeichens auf hochgeladenen Beweisfotos.
// Wird von den Upload-Handlern per fire-and-forget angestoßen; das Ergebnis
// landet pro Bild in report_images und wird vom Bearbeiten-Formular über
// GET /anzeige/:az/analysis abgeholt. Ist das Kennzeichen-Feld der Anzeige
// noch leer, wird es serverseitig direkt vorbefüllt (nur Entwürfe); ebenso
// Fahrzeugmarke und -farbe (derselbe Dienstaufruf liefert sie mit).
//
// Die Verarbeitung läuft SERIELL über eine einfache Promise-Kette: die
// CPU-Inferenz teilt sich die Maschine mit App, DB und Photon – mehrere Bilder
// gleichzeitig würden die CPU sättigen (der Dienst serialisiert zusätzlich).
import { logger } from './logger'
import fs from 'fs/promises'
import path from 'path'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { alprEnabled, recognizePlate, ALPR_MIN_CONFIDENCE } from './alpr'
import { reportDir } from './drafts'

/** Dateiname des gespeicherten Kennzeichen-Ausschnitts eines Fotos
 *  (Ablage neben dem Foto, Konvention wie `.thumb.jpg`/`.pixel.jpg`). */
export function plateCropName(filename: string): string {
  return `${filename}.plate.jpg`
}

let queue: Promise<void> = Promise.resolve()

/** Reiht die Analyse eines Bildes ein (kehrt sofort zurück, läuft im Hintergrund). */
export function queuePlateAnalysis(
  userId: number,
  reportId: number,
  imageId: number,
  filename: string,
  mimetype: string
): void {
  if (!alprEnabled()) {
    void setStatus(imageId, 'skipped')
    return
  }
  // Sofort als 'pending' markieren (nicht erst beim Abarbeiten): Der Poll-Endpoint
  // wertet nur 'pending' als "läuft noch" – wartende Bilder hinter einem langen
  // Job dürfen dem Formular nicht fälschlich als fertig gemeldet werden.
  void setStatus(imageId, 'pending')
  queue = queue
    .then(() => runAnalysis(userId, reportId, imageId, filename, mimetype))
    .catch(() => {
      /* Einzelfehler dürfen die Kette nicht abreißen lassen. */
    })
}

/** Nur die Datenschutz-Analyse (analyse_json) eines ersetzten Fotos erneuern –
 *  das erkannte Kennzeichen bleibt (nach dem Schwärzen ist es oft unleserlich,
 *  siehe PUT /anzeige/:az/images/:imageId). */
export function queueAnalyseOnly(userId: number, reportId: number, imageId: number, filename: string, mimetype: string): void {
  if (!alprEnabled()) return
  queue = queue
    .then(async () => {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT report_id, filename FROM report_images WHERE id=?', [imageId])
      if (!rows.length) return
      const file = path.join(reportDir(userId, Number(rows[0].report_id)), String(rows[0].filename))
      const result = await recognizePlate(file, mimetype)
      if (result?.analyse) {
        await pool.execute('UPDATE report_images SET analyse_json=? WHERE id=? AND filename=?', [JSON.stringify(result.analyse), imageId, rows[0].filename])
      }
    })
    .catch(() => {
      /* Einzelfehler dürfen die Kette nicht abreißen lassen. */
    })
}

/** Beim App-Start liegengebliebene 'pending'-Jobs als 'failed' markieren
 *  (Neustart mitten in der Analyse) – sonst zeigt das Formular dort dauerhaft
 *  die Ladeanimation. Neue Uploads reihen sich ohnehin frisch ein. */
export async function failStalePlateAnalyses(): Promise<void> {
  try {
    await pool.execute(
      "UPDATE report_images SET analysis_status='failed' WHERE analysis_status='pending'"
    )
  } catch {
    /* unkritisch – schlimmstenfalls pollt das Formular bis zum 2-Minuten-Cap */
  }
}

async function setStatus(imageId: number, status: 'pending' | 'failed' | 'skipped'): Promise<void> {
  try {
    await pool.execute('UPDATE report_images SET analysis_status=? WHERE id=?', [status, imageId])
  } catch {
    /* DB evtl. kurz nicht erreichbar – unkritisch für den Hintergrundlauf. */
  }
}

async function runAnalysis(
  userId: number,
  reportId: number,
  imageId: number,
  filename: string,
  mimetype: string
): Promise<void> {
  // Aktuellen Ort des Bildes nachschlagen: Während es in der Warteschlange
  // stand, kann es in eine andere Anzeige verschoben worden sein (Drag & Drop
  // in der Liste) – dann liegt die Datei im Ordner der neuen Anzeige, und auch
  // das Kennzeichen gehört dorthin.
  try {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT report_id, filename FROM report_images WHERE id = ?',
      [imageId]
    )
    if (!rows.length) return // inzwischen gelöscht
    reportId = Number(rows[0].report_id)
    filename = String(rows[0].filename)
  } catch {
    /* DB kurz weg – mit den eingereihten Werten weitermachen */
  }
  const filePath = path.join(reportDir(userId, reportId), filename)

  try {
    const result = await recognizePlate(filePath, mimetype)
    if (!result) {
      // Dienst nicht erreichbar / Timeout – das Feld bleibt einfach leer.
      await setStatus(imageId, 'failed')
      return
    }

    const best = result.best
    await pool.execute(
      `UPDATE report_images
         SET detected_plate=?, plate_confidence=?, analyse_json=?, analysis_status='done', analyzed_at=NOW()
       WHERE id=?`,
      [best?.plate ?? null, best?.confidence ?? null, result.analyse ? JSON.stringify(result.analyse) : null, imageId]
    )

    // Kennzeichen-Ausschnitt als eigene Datei neben dem Foto ablegen (Beleg,
    // welcher Bildbereich gelesen wurde; abrufbar über .../image/:id/plate.jpg).
    if (best?.cropJpeg) {
      try {
        await fs.writeFile(path.join(reportDir(userId, reportId), plateCropName(filename)), best.cropJpeg)
      } catch {
        /* Crop ist verzichtbar – Kennzeichen-Text ist gespeichert */
      }
    }

    await prefillReportPlate(userId, reportId)
    await prefillReportFahrzeug(userId, reportId)
  } catch (err) {
    logger.error({ err, imageId, reportId }, 'Kennzeichen-Analyse fehlgeschlagen')
    await setStatus(imageId, 'failed')
  }
}

/** Kennzeichen-Vorschlag einer Anzeige aus den Lesungen aller ihrer Fotos.
 *  Berücksichtigt nur sichere Lesungen (ab ALPR_MIN_CONFIDENCE; nicht aufs
 *  deutsche Format normalisierbare drückt der Dienst darunter) – der Dienst
 *  liefert pro Foto das Schild des Autos im Vordergrund. Es
 *  gewinnt das Kennzeichen, das auf den meisten Fotos erkannt wurde, dann die
 *  höhere Summen-Konfidenz, dann das frühere Foto – so setzt sich bei Fotos
 *  mehrerer Autos (Import-Gruppen, Übersichtsbilder) das gemeinte Auto durch
 *  statt zufällig das zuerst analysierte. */
export async function bestPlateForReport(
  reportId: number
): Promise<{ plate: string; confidence: number; pending: boolean } | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT analysis_status, detected_plate, plate_confidence
       FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
    [reportId]
  )
  const pending = rows.some((r) => r.analysis_status === 'pending')
  const votes = new Map<string, { count: number; sum: number; max: number; first: number }>()
  rows.forEach((r, i) => {
    if (!r.detected_plate || r.plate_confidence === null) return
    const confidence = Number(r.plate_confidence)
    if (confidence < ALPR_MIN_CONFIDENCE) return
    const v = votes.get(r.detected_plate)
    if (v) {
      v.count++
      v.sum += confidence
      v.max = Math.max(v.max, confidence)
    } else {
      votes.set(r.detected_plate, { count: 1, sum: confidence, max: confidence, first: i })
    }
  })
  let best: [string, { count: number; sum: number; max: number; first: number }] | null = null
  for (const entry of votes) {
    const [, v] = entry
    if (
      !best ||
      v.count > best[1].count ||
      (v.count === best[1].count && v.sum > best[1].sum) ||
      (v.count === best[1].count && v.sum === best[1].sum && v.first < best[1].first)
    ) {
      best = entry
    }
  }
  return best ? { plate: best[0], confidence: best[1].max, pending } : null
}

/** Leeres Kennzeichen-Feld eines Entwurfs aus den Foto-Lesungen vorbefüllen –
 *  erst wenn alle Fotos analysiert sind (sonst entschiede das zuerst
 *  analysierte Foto statt der Mehrheit). Manuell eingetragene Werte werden nie
 *  überschrieben. Auch nach dem Verschieben von Fotos aufgerufen. */
export async function prefillReportPlate(userId: number, reportId: number): Promise<void> {
  const best = await bestPlateForReport(reportId)
  if (!best || best.pending) return
  await pool.execute(
    `UPDATE reports SET kennzeichen=?
      WHERE id=? AND user_id=? AND status='entwurf'
        AND (kennzeichen IS NULL OR kennzeichen='')`,
    [best.plate, reportId, userId]
  )
}

/** Ab dieser gemittelten Wahrscheinlichkeit befüllt die erkannte Marke bzw.
 *  Farbe ein leeres Feld vor. Gemessen an 160 Prod-Anzeigen mit von Hand
 *  eingetragenen Werten (10/2026, docker/alpr/fahrzeug.py): bei 0,8 werden
 *  ~75 % der Marken (98 % richtig) und ~50 % der Farben (96 % richtig)
 *  befüllt. Hängt an der festen Softmax-Temperatur des Dienstes. */
export const FAHRZEUG_MIN_P = 0.8

export type FahrzeugVorschlag = { wert: string; p: number }

/** Ab dieser gemittelten Wahrscheinlichkeit (innerhalb der Marke) wird ein
 *  Modell als anklickbarer Vorschlag angeboten – nie vorbefüllt. Erste Messung
 *  10/2026 an nur 24 Prod-Anzeigen mit eingetragenem Modell: 68 % Treffer,
 *  ab 0,5 bei 19 Anzeigen ein Vorschlag, davon 15 richtig (häufigster Fehler
 *  Golf ↔ Touran). Mit wachsendem Bestand gegen reports.fahrzeug_modell
 *  nachmessen, bevor daraus eine Vorbefüllung wird. */
export const MODELL_VORSCHLAG_P = 0.5

/** Marken-Schlüssel zum Vergleich von Freitext („VW", „Mercedes") mit den
 *  Labels des Dienstes („Volkswagen", „Mercedes-Benz"). */
function markeKey(m: string): string {
  const k = m.toLowerCase().replace(/ë/g, 'e').replace(/[^a-z0-9]/g, '')
  if (k === 'vw') return 'volkswagen'
  if (k.startsWith('mercedes') || k === 'benz') return 'mercedesbenz'
  return k
}

/** Marke/Farbe einer Anzeige: Wahrscheinlichkeiten aller analysierten Fotos
 *  gemittelt (wie die Messung), Vorschlag nur ab FAHRZEUG_MIN_P. Dazu ein
 *  Modell-Vorschlag innerhalb der eingetragenen Marke (`marke`; leer ⇒ die
 *  wahrscheinlichste erkannte), gemittelt über die Fotos, die diese Marke
 *  unter ihren Top-Marken haben. */
export async function bestFahrzeugForReport(reportId: number, marke?: string | null): Promise<{
  marke: FahrzeugVorschlag | null
  farbe: FahrzeugVorschlag | null
  modell: FahrzeugVorschlag | null
  pending: boolean
}> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT analysis_status, analyse_json FROM report_images WHERE report_id = ?',
    [reportId]
  )
  const pending = rows.some((r) => r.analysis_status === 'pending')
  type Fz = { marke?: Record<string, number>; farbe?: Record<string, number>; modell?: Record<string, Record<string, number>> }
  const fzs: Fz[] = []
  for (const r of rows) {
    try {
      const fz = r.analyse_json ? (JSON.parse(String(r.analyse_json)).fahrzeug as Fz | undefined) : undefined
      if (fz) fzs.push(fz)
    } catch {
      /* defekte Analyse überspringen */
    }
  }
  const mittel = (dicts: (Record<string, number> | undefined)[]): Map<string, number> => {
    const sums = new Map<string, number>()
    for (const d of dicts) for (const [k, p] of Object.entries(d || {})) if (typeof p === 'number') sums.set(k, (sums.get(k) || 0) + p / dicts.length)
    return sums
  }
  const top = (m: Map<string, number>): FahrzeugVorschlag | null => {
    let best: FahrzeugVorschlag | null = null
    for (const [wert, p] of m) if (!best || p > best.p) best = { wert, p }
    return best
  }
  const ab = (v: FahrzeugVorschlag | null, min: number) => (v && v.p >= min ? v : null)
  if (!fzs.length) return { marke: null, farbe: null, modell: null, pending }

  const markeTop = top(mittel(fzs.map((f) => f.marke)))
  const key = markeKey(String(marke || '').trim() || markeTop?.wert || '')
  const modellDicts = fzs
    .map((f) => Object.entries(f.modell || {}).find(([m]) => markeKey(m) === key)?.[1])
    .filter((d): d is Record<string, number> => !!d)
  return {
    marke: ab(markeTop, FAHRZEUG_MIN_P),
    farbe: ab(top(mittel(fzs.map((f) => f.farbe))), FAHRZEUG_MIN_P),
    modell: key && modellDicts.length ? ab(top(mittel(modellDicts)), MODELL_VORSCHLAG_P) : null,
    pending,
  }
}

/** Leere Marke/Farbe eines Entwurfs aus den Fotos vorbefüllen – wie beim
 *  Kennzeichen erst, wenn alle Fotos analysiert sind, und nie über eine
 *  Eingabe des Nutzers. */
export async function prefillReportFahrzeug(userId: number, reportId: number): Promise<void> {
  const fz = await bestFahrzeugForReport(reportId)
  if (fz.pending) return
  if (fz.marke) {
    await pool.execute(
      `UPDATE reports SET fahrzeug_marke=?
        WHERE id=? AND user_id=? AND status='entwurf' AND (fahrzeug_marke IS NULL OR fahrzeug_marke='')`,
      [fz.marke.wert, reportId, userId]
    )
  }
  if (fz.farbe) {
    await pool.execute(
      `UPDATE reports SET fahrzeug_farbe=?
        WHERE id=? AND user_id=? AND status='entwurf' AND (fahrzeug_farbe IS NULL OR fahrzeug_farbe='')`,
      [fz.farbe.wert, reportId, userId]
    )
  }
}
