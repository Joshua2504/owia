// Hintergrund-Erkennung des Kennzeichens auf hochgeladenen Beweisfotos.
// Wird von den Upload-Handlern per fire-and-forget angestoßen; das Ergebnis
// landet pro Bild in report_images und wird vom Bearbeiten-Formular über
// GET /anzeige/:az/analysis abgeholt. Ist das Kennzeichen-Feld der Anzeige
// noch leer, wird es serverseitig direkt vorbefüllt (nur Entwürfe).
//
// Die Verarbeitung läuft SERIELL über eine einfache Promise-Kette: die
// CPU-Inferenz teilt sich die Maschine mit dem Tileserver – mehrere Bilder
// gleichzeitig würden die CPU sättigen (der Dienst serialisiert zusätzlich).
import path from 'path'
import { pool } from '../db/connection'
import { alprEnabled, recognizePlate, ALPR_MIN_CONFIDENCE } from './alpr'
import { reportDir } from './drafts'

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
         SET detected_plate=?, plate_confidence=?, analysis_status='done', analyzed_at=NOW()
       WHERE id=?`,
      [best?.plate ?? null, best?.confidence ?? null, imageId]
    )

    // Leeres Kennzeichen-Feld der Anzeige vorbefüllen – nur bei sicherer,
    // aufs deutsche Format normalisierter Lesung und nur solange Entwurf.
    // Manuell eingetragene Werte werden nie überschrieben.
    if (best && best.normalized && best.confidence >= ALPR_MIN_CONFIDENCE) {
      await pool.execute(
        `UPDATE reports SET kennzeichen=?
          WHERE id=? AND user_id=? AND status='entwurf'
            AND (kennzeichen IS NULL OR kennzeichen='')`,
        [best.plate, reportId, userId]
      )
    }
  } catch (err) {
    console.error('Kennzeichen-Analyse fehlgeschlagen', err)
    await setStatus(imageId, 'failed')
  }
}
