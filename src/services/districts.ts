import fs from 'fs'
import path from 'path'
import { CITIES, City, getCityByName } from '../config/cities'

// Bundesweite Zuständigkeits-Tabelle: Postleitzahl -> Ort + Ordnungsamt-Adresse.
// Quelle: resources/districts.csv ("plz","name","email"), einmalig beim Start
// eingelesen (~8.300 Zeilen, wenige hundert KB). Wird NUR zur Erkennung genutzt:
// Aus dem Tatort (dessen PLZ) leiten wir das zuständige Amt ab und entscheiden,
// ob dieser Ort bereits freigeschaltet ist (siehe CITIES). Der tatsächliche
// Versand nutzt die Adresse aus der Stadt-Registry (config/cities.ts), nicht
// diese Tabelle – so bleiben bewusste Overrides (z.B. Bad Soden-Salmünster)
// unabhängig von der CSV.

export interface District {
  plz: string
  /** Ortsname wie in der CSV, z.B. "Frankfurt am Main". */
  name: string
  /** Zuständige Ordnungsamt-/Bußgeldstellen-Adresse laut CSV. */
  email: string
}

const CSV_PATH = path.join(process.cwd(), 'resources', 'districts.csv')

/** Jede Zeile ist "plz","name","email" (alle Felder gequotet, per Prüfung sicher). */
function parse(content: string): Map<string, District> {
  const map = new Map<string, District>()
  const lines = content.split(/\r?\n/)
  const rowRe = /^"([^"]*)","([^"]*)","([^"]*)"\s*$/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const m = rowRe.exec(line)
    if (!m) continue
    const [, plz, name, email] = m
    if (plz === 'plz' || !/^\d{5}$/.test(plz)) continue // Kopfzeile / ungültige PLZ
    // Erste Zuordnung je PLZ gewinnt (Duplikate in der CSV betreffen dieselbe Stadt).
    if (!map.has(plz)) map.set(plz, { plz, name: name.trim(), email: email.trim() })
  }
  return map
}

let districts: Map<string, District>
try {
  districts = parse(fs.readFileSync(CSV_PATH, 'utf8'))
} catch {
  // Fehlt die Datei, bleibt die Erkennung leer (jede Stadt gilt als „unbekannt").
  districts = new Map()
}

// Repräsentative Empfänger-Adresse je Ortsname (erster Treffer gewinnt) – für die
// Anzeige im Formular und als Fallback, wenn die exakte Tatort-PLZ fehlt.
const emailByCityName = new Map<string, string>()
for (const d of districts.values()) {
  const key = d.name.toLowerCase()
  if (!emailByCityName.has(key)) emailByCityName.set(key, d.email)
}

/** Zuständiges Amt zu einer Postleitzahl (5-stellig), sonst undefined. */
export function districtByPlz(plz?: string | null): District | undefined {
  if (!plz) return undefined
  return districts.get(String(plz).trim())
}

/** Erste 5-stellige Zahl (Postleitzahl) aus einem Adress-Label ziehen.
 *  Photon-Labels haben die Form "Straße Hnr, PLZ Ort" – daraus die PLZ. */
export function extractPlz(text?: string | null): string | null {
  if (!text) return null
  const m = /\b(\d{5})\b/.exec(String(text))
  return m ? m[1] : null
}

export type CityDetection =
  | { status: 'unlocked'; city: City; district: District }
  | { status: 'locked'; district: District }
  | { status: 'unknown' }

/**
 * Aus einer Postleitzahl ableiten, ob (und für welche freigeschaltete Stadt)
 * eine Anzeige erstattet werden kann:
 *  - unlocked: PLZ gehört zu einer freigeschalteten Stadt (aus CITIES).
 *  - locked:   Amt bekannt, aber Ort noch nicht freigeschaltet.
 *  - unknown:  PLZ nicht in der Tabelle (oder keine PLZ übergeben).
 */
export function detectCityByPlz(plz?: string | null): CityDetection {
  const district = districtByPlz(plz)
  if (!district) return { status: 'unknown' }
  const city = getCityByName(district.name)
  return city ? { status: 'unlocked', city, district } : { status: 'locked', district }
}

/** Wie detectCityByPlz, aber direkt aus einem Adress-Label (zieht die PLZ selbst). */
export function detectCityByLabel(label?: string | null): CityDetection {
  return detectCityByPlz(extractPlz(label))
}

/** Repräsentative Empfänger-Adresse einer (freigeschalteten) Stadt aus districts.csv. */
export function cityEmail(city: City): string | null {
  return emailByCityName.get(city.name.toLowerCase()) || null
}

/**
 * Empfänger-Adresse einer Anzeige – IMMER aus districts.csv. Primär exakt über die
 * PLZ des Tatorts, sonst repräsentativ über die (freigeschaltete) Stadt.
 */
export function recipientEmailForReport(report: {
  tatort?: string | null
  city?: string | null
  [key: string]: unknown
}): string | null {
  const byPlz = districtByPlz(extractPlz(report.tatort))
  if (byPlz) return byPlz.email
  const city = report.city ? CITIES[report.city] : undefined
  return city ? cityEmail(city) : null
}

/** Anzahl geladener PLZ-Einträge (für Diagnose/Logging beim Start). */
export function districtCount(): number {
  return districts.size
}

/** Namen aller freigeschalteten Städte als Fließtext ("A", "A und B", "A, B und C"). */
function unlockedNamesText(): string {
  const names = Object.values(CITIES).map((c) => c.name)
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} und ${names[names.length - 1]}`
}

export type SendGate =
  | { ok: true; cityId: string }
  | { ok: false; message: string }

/**
 * Vor dem Versand prüfen, an welche (freigeschaltete) Stadt eine Anzeige geht.
 * Der Tatort entscheidet (dort ist das Amt zuständig): Aus seiner PLZ wird die
 * Stadt abgeleitet. Ist der Ort nicht freigeschaltet, wird abgewiesen.
 *
 *  - PLZ -> freigeschaltete Stadt: ok, diese Stadt ist maßgeblich (self-heilt ein
 *    ggf. veraltetes Dropdown).
 *  - PLZ -> bekanntes, aber nicht freigeschaltetes Amt: abgewiesen (mit Hinweis
 *    auf das eigentlich zuständige Amt).
 *  - keine PLZ erkennbar: nur zulässig, wenn im Dropdown bereits eine gültige
 *    freigeschaltete Stadt gewählt ist (manueller Override), sonst abgewiesen.
 */
export function resolveSendCity(
  tatortLabel: string | null | undefined,
  currentCityId: string | null | undefined
): SendGate {
  const det = detectCityByLabel(tatortLabel)
  if (det.status === 'unlocked') return { ok: true, cityId: det.city.id }
  if (det.status === 'locked') {
    return {
      ok: false,
      message:
        `Für ${det.district.name} (${det.district.plz}) ist die Anzeige über OWiA noch ` +
        `nicht freigeschaltet. Zuständig wäre: ${det.district.email}. ` +
        `Aktuell werden nur ${unlockedNamesText()} unterstützt.`,
    }
  }
  // unknown: PLZ nicht in der Tabelle / kein Tatort mit PLZ.
  if (currentCityId && CITIES[currentCityId]) return { ok: true, cityId: currentCityId }
  return {
    ok: false,
    message:
      'Bitte einen Tatort mit Postleitzahl aus der Vorschlagsliste wählen – nur so ' +
      'lässt sich das zuständige Ordnungsamt ermitteln.',
  }
}

// Re-Export, damit Aufrufer nicht zusätzlich config/cities importieren müssen.
export { CITIES }
