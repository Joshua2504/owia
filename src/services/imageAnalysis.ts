// Hintergrund-Analyse eines hochgeladenen Beweisfotos: Kennzeichen (ALPR) +
// Verstoßart/Fahrzeug/Beschreibung (VLM). Wird vom Upload-Handler per
// fire-and-forget angestoßen; das Ergebnis landet in report_images und wird vom
// Bearbeiten-Formular per Poll abgeholt.
//
// Die Verarbeitung läuft SERIELL über eine einfache Promise-Kette: das VLM ist
// auf CPU rechen-/speicherintensiv und teilt sich die Maschine mit dem
// Tileserver – mehrere Bilder gleichzeitig würden die CPU sättigen.
import path from 'path'
import { pool } from '../db/connection'
import { recognizePlate } from './alpr'
import { analyzeViolation } from './vlm'

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')

let queue: Promise<void> = Promise.resolve()

/**
 * Ob die selbst-gehostete Foto-Analyse (alpr + ollama) genutzt wird. Diese Dienste
 * laufen nur im Production-Compose-Profil; in der Entwicklung ist die Analyse daher
 * standardmäßig AUS. Mit PHOTO_AI_ENABLED=on/off gezielt überschreibbar.
 */
export function isPhotoAiEnabled(): boolean {
  const v = (process.env.PHOTO_AI_ENABLED || '').toLowerCase()
  if (['on', '1', 'true', 'yes'].includes(v)) return true
  if (['off', '0', 'false', 'no'].includes(v)) return false
  return process.env.NODE_ENV === 'production'
}

/** Reiht die Analyse eines Bildes ein (kehrt sofort zurück, läuft im Hintergrund). */
export function analyzeImageInBackground(
  userId: number,
  reportId: number,
  imageId: number,
  filename: string,
  mimetype: string
): void {
  if (!isPhotoAiEnabled()) return
  queue = queue
    .then(() => runAnalysis(userId, reportId, imageId, filename, mimetype))
    .catch(() => {
      /* Einzelfehler dürfen die Kette nicht abreißen lassen. */
    })
}

async function setStatus(imageId: number, status: 'pending' | 'error'): Promise<void> {
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
  const filePath = path.join(UPLOAD_DIR, String(userId), String(reportId), filename)
  await setStatus(imageId, 'pending')

  try {
    const [plate, violation] = await Promise.all([
      recognizePlate(filePath, mimetype),
      analyzeViolation(filePath),
    ])

    await pool.execute(
      `UPDATE report_images
         SET detected_plate=?, plate_confidence=?, vlm_verstoss_art=?, vlm_marke=?,
             vlm_beschreibung=?, analysis_status='done', analyzed_at=NOW()
       WHERE id=?`,
      [
        plate?.plate ?? null,
        plate?.confidence ?? null,
        violation?.verstossArt ?? null,
        violation?.marke ?? null,
        violation?.beschreibung ?? null,
        imageId,
      ]
    )
  } catch (err) {
    console.error('Bildanalyse fehlgeschlagen', err)
    await setStatus(imageId, 'error')
  }
}
