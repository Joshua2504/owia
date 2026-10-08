// Datenschutz-Prüfung der Beweisfotos: Auf den Fotos dürfen keine weiteren
// Kennzeichen oder erkennbare Personen zu sehen sein (Hinweis des Frankfurter
// Portals: sonst droht ein Verfahren beim HBDI). Grundlage ist die gespeicherte
// Bildanalyse (report_images.analyse_json, services/alpr.ts BildAnalyse).
// Der Nutzer schwärzt die Funde im Foto-Dialog (photo-edit.js) oder bestätigt
// sie als unbedenklich (report_images.dritte_ok).

import type { BildAnalyse } from './alpr'

export type DritteFund = { art: 'kennzeichen' | 'gesicht'; text?: string; bbox: number[] }

/** Ab dieser Sicherheit zählt eine Kennzeichen-Lesung als „lesbar". */
const PLATE_MIN = 0.4
/** Gesichtsdetektor (YuNet) liefert ab 0.8; darunter viele Fehlalarme. */
const FACE_MIN = 0.85

const compact = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '')

/** Levenshtein-Distanz (kurz: Kennzeichen ≤ 10 Zeichen). */
function distanz(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/** Ist die Lesung das angezeigte Fahrzeug? Kleine OCR-Abweichungen (ein
 *  Zeichen) zählen als dasselbe Kennzeichen. */
export function istAngezeigtesKennzeichen(text: string, kennzeichen: string | null | undefined): boolean {
  const a = compact(text)
  const b = compact(kennzeichen)
  if (!a || !b) return false
  return a === b || distanz(a, b) <= 1
}

export function parseAnalyse(json: unknown): BildAnalyse | null {
  if (!json) return null
  try {
    const a = typeof json === 'string' ? JSON.parse(json) : json
    return a && a.w && a.h ? (a as BildAnalyse) : null
  } catch {
    return null
  }
}

/** Fremde Kennzeichen und Gesichter auf einem Foto. Ohne eingetragenes
 *  Kennzeichen der Anzeige lässt sich „fremd" nicht entscheiden – dann zählen
 *  nur Gesichter (das Einreichen verlangt das Kennzeichen ohnehin). */
export function dritteFunde(analyseJson: unknown, kennzeichen: string | null | undefined): DritteFund[] {
  const a = parseAnalyse(analyseJson)
  if (!a) return []
  const out: DritteFund[] = []
  if (compact(kennzeichen)) {
    for (const p of a.plates) {
      if (p.confidence >= PLATE_MIN && !istAngezeigtesKennzeichen(p.text, kennzeichen)) {
        out.push({ art: 'kennzeichen', text: p.text, bbox: p.bbox })
      }
    }
  }
  for (const f of a.faces) if (f.score >= FACE_MIN) out.push({ art: 'gesicht', bbox: f.bbox })
  return out
}

/** Anteil des angezeigten Kennzeichens an der Bildfläche (für die Foto-Rolle:
 *  kleines Schild = Übersichtsfoto). `null` = nicht erkannt. */
export function kennzeichenFlaeche(analyseJson: unknown, kennzeichen: string | null | undefined): number | null {
  const a = parseAnalyse(analyseJson)
  if (!a) return null
  const p = a.plates.find((x) => istAngezeigtesKennzeichen(x.text, kennzeichen))
  if (!p) return null
  const [x1, y1, x2, y2] = p.bbox
  return Math.max(0, (x2 - x1) * (y2 - y1)) / (a.w * a.h)
}

/** Kurztext für Prüflisten: „weiteres Kennzeichen F-XY 12, Gesicht". */
export function fundeText(funde: DritteFund[]): string {
  const k = funde.filter((f) => f.art === 'kennzeichen')
  const g = funde.filter((f) => f.art === 'gesicht').length
  return [
    k.length ? `${k.length === 1 ? 'weiteres Kennzeichen' : `${k.length} weitere Kennzeichen`} (${k.map((f) => f.text).join(', ')})` : '',
    g ? (g === 1 ? 'ein Gesicht' : `${g} Gesichter`) : '',
  ].filter(Boolean).join(' und ')
}

/** Markierte Box des angezeigten Kennzeichens (report_images.kennzeichen_box,
 *  Anteile 0..1 der gespeicherten Fassung). null = keine/ungültig. */
export function parseKennzeichenBox(v: unknown): number[] | null {
  if (!v) return null
  try {
    const b = typeof v === 'string' ? JSON.parse(v) : v
    if (!Array.isArray(b) || b.length !== 4 || !b.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) return null
    return b[2] > b[0] && b[3] > b[1] ? b : null
  } catch {
    return null
  }
}

/** Vorbelegung fürs Markieren: Box des angezeigten Kennzeichens (bzw. der
 *  Erkennung dieses Fotos) aus der Analyse, als Anteile 0..1. */
export function erkannteKennzeichenBox(analyseJson: unknown, ...kennzeichen: (string | null | undefined)[]): number[] | null {
  const a = parseAnalyse(analyseJson)
  if (!a) return null
  for (const k of kennzeichen) {
    const p = a.plates.find((x) => istAngezeigtesKennzeichen(x.text, k))
    if (p) {
      const [x1, y1, x2, y2] = p.bbox
      const c = (v: number) => Math.max(0, Math.min(1, v))
      return [c(x1 / a.w), c(y1 / a.h), c(x2 / a.w), c(y2 / a.h)]
    }
  }
  return null
}

/** Analyse für die öffentliche Kartenfassung: die erkannten Boxen plus die vom
 *  Nutzer markierte Kennzeichen-Box. `markiert` = der Nutzer hat das Foto auf
 *  das Kennzeichen hin geprüft (Box gesetzt oder „keins sichtbar") – dann
 *  genügt die Schwärzungsstufe auch ohne erkanntes Kennzeichen. */
export type KartenAnalyse = BildAnalyse & { markiert?: boolean }
export function kartenAnalyse(analyseJson: unknown, boxJson: unknown, keins: unknown): KartenAnalyse | null {
  const a = parseAnalyse(analyseJson)
  if (!a) return null
  const box = parseKennzeichenBox(boxJson)
  if (!box) return keins ? { ...a, markiert: true } : a
  const bbox = [box[0] * a.w, box[1] * a.h, box[2] * a.w, box[3] * a.h]
  return { ...a, plates: [...a.plates, { text: '', confidence: 1, bbox }], markiert: true }
}
