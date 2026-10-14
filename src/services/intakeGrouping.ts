// Gruppierung der Sammel-Import-Fotos zu "Vorfällen" (je Vorfall entsteht ein
// Entwurf). Grundidee: der Ort ist das primäre Signal – Fotos innerhalb von
// ~50 m am selben Tag gehören zu EINEM Verstoß, dessen Dauer sich aus
// frühester und spätester Aufnahmezeit ergibt (tatzeit_von/bis). Ein Vorfall
// darf über Mitternacht andauern (Dauerparken über Nacht): Fotos am selben Ort
// an Folgetagen werden zusammengefasst, wenn sie zeitlich fortlaufend sind
// (Lücke ≤ OVERNIGHT_GAP_MIN, z.B. Foto abends + Foto am nächsten Morgen) –
// der Vorfall trägt dann day..dayTo. Bewusst ohne Libraries und
// deterministisch, damit dieselben Fotos immer dieselben Gruppen ergeben.
//
// Ort und Zeit allein trennen keine Autos, die man nacheinander in derselben
// Straße fotografiert. Deshalb teilt splitByVehicle jeden Vorfall zusätzlich
// nach den erkannten Kennzeichen (ALPR läuft im Import-Job VOR der Gruppierung).

import { tatzeitBis } from './tatzeit'

export type IntakePhoto = {
  id: number
  capturedAt: string | null // 'YYYY-MM-DD HH:MM:SS' (Wanduhrzeit)
  lat: number | null
  lon: number | null
  /** Erkanntes Kennzeichen (ALPR) und dessen Konfidenz; fehlt ohne Analyse. */
  plate?: string | null
  plateConfidence?: number | null
}

export type GroupOptions = {
  /** Lesungen darunter zählen nicht (wie ALPR_MIN_CONFIDENCE beim Vorbefüllen). */
  minPlateConfidence?: number
}

export type Incident = {
  photoIds: number[]
  day: string | null // 'YYYY-MM-DD'
  dayTo: string | null // Ende an einem anderen Tag (über Mitternacht), sonst null
  timeFrom: string | null // 'HH:MM:SS'
  timeTo: string | null // null, wenn nur ein Zeitpunkt bekannt
  lat: number | null // Mittelwert der Mitglieds-Koordinaten (Anzeige/Geocoding)
  lon: number | null
}

export type GroupingResult = {
  incidents: Incident[]
  unassigned: number[] // Fotos ohne GPS und ohne Zeit -> manuelle Zuordnung
}

// Fotos näher als RADIUS_M gelten als derselbe Ort. GPS-lose Fotos werden
// einem Cluster zugeschlagen, wenn ihre Zeit in dessen Zeitfenster ±SLACK
// fällt; übrige zeitbehaftete Fotos werden bei Lücken > TIME_GAP_MIN getrennt.
// Gleicher Ort an einem ANDEREN Tag ist ein neuer Vorfall – außer die Fotos
// sind zeitlich fortlaufend (Lücke ≤ OVERNIGHT_GAP_MIN): dann dauert derselbe
// Verstoß über Mitternacht an (abends dokumentiert, morgens nachdokumentiert).
export const RADIUS_M = 50
export const TIME_ATTACH_SLACK_MIN = 15
export const TIME_GAP_MIN = 60
export const OVERNIGHT_GAP_MIN = 12 * 60

// Ein Fahrzeug ist ein Kennzeichen, das auf mindestens ZWEI Fotos des Vorfalls
// sicher gelesen wurde. Einzelne Lesungen neben solchen Fahrzeugen sind fast
// immer Autos im Hintergrund von Übersichtsfotos (Prod-Daten 10/2026: in keiner
// von 256 eingereichten Import-Anzeigen hätte ein Einzelfoto eine eigene
// Anzeige verdient). Gibt es im Vorfall nur Einzellesungen (ein Foto je Auto),
// zählen die sehr sicheren (ab SINGLE_PLATE_MIN_CONFIDENCE) als eigene Fahrzeuge.
export const SINGLE_PLATE_MIN_CONFIDENCE = 0.95

type Cluster = {
  anchorLat: number
  anchorLon: number
  day: string | null
  photos: IntakePhoto[]
}

/** Äquirektangulare Näherung – bei 50-m-Schwellen völlig ausreichend. */
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111320
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  return Math.hypot(dLat, dLon)
}

function dayOf(capturedAt: string | null): string | null {
  return capturedAt ? capturedAt.slice(0, 10) : null
}

function timeOf(capturedAt: string | null): string | null {
  return capturedAt ? capturedAt.slice(11, 19) : null
}

/** Minuten auf einer durchgehenden Zeitachse (UTC-interpretiert – nur Differenzen
 *  zählen; so funktionieren Zeit-Lücken auch über Mitternacht hinweg korrekt). */
function epochMinutes(capturedAt: string): number {
  return (
    Date.UTC(
      Number(capturedAt.slice(0, 4)),
      Number(capturedAt.slice(5, 7)) - 1,
      Number(capturedAt.slice(8, 10)),
      Number(capturedAt.slice(11, 13)),
      Number(capturedAt.slice(14, 16))
    ) / 60000
  )
}

/** Sekunden auf derselben durchgehenden Achse wie epochMinutes. */
function epochSeconds(capturedAt: string): number {
  return epochMinutes(capturedAt) * 60 + Number(capturedAt.slice(17, 19))
}

/** Vergleichsschlüssel eines Kennzeichens: nur Buchstaben/Ziffern, ohne
 *  E-/H-Suffix. Die OCR setzt den Trennstrich oft falsch („F-SL 1912" vs.
 *  „FS-L 1912") und liest das Suffix mal mit, mal nicht. */
export function plateKey(plate: string): string {
  return plate
    .toUpperCase()
    .replace(/[^A-Z0-9ÄÖÜ]/g, '')
    .replace(/(\d)[EH]$/, '$1')
}

/** Editierdistanz ≤ 1 (ein Zeichen vertauscht, zu viel oder zu wenig) – typische
 *  Einzelfehler der OCR („KR-FR 3555" für „KR-FR 3553", „FB-JA" für „F-JA"). */
function nearlySame(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

function sortKey(p: IntakePhoto): string {
  // Fotos ohne Zeit ans Ende; ID als Tiebreaker für Determinismus.
  return `${p.capturedAt ?? '9999-99-99 99:99:99'}#${String(p.id).padStart(12, '0')}`
}

export function toIncident(photos: IntakePhoto[]): Incident {
  const times = photos.map((p) => p.capturedAt).filter((t): t is string => t !== null).sort()
  const coords = photos.filter((p) => p.lat !== null && p.lon !== null)
  const day = times.length ? dayOf(times[0]) : null
  const dayToRaw = times.length ? dayOf(times[times.length - 1]) : null
  const dayTo = dayToRaw && dayToRaw !== day ? dayToRaw : null
  const timeFrom = times.length ? timeOf(times[0]) : null
  const timeToRaw = times.length ? timeOf(times[times.length - 1]) : null
  return {
    photoIds: photos.map((p) => p.id),
    day,
    dayTo,
    timeFrom,
    // Bei Tageswechsel gehört timeTo immer dazu – auch wenn die Uhrzeit zufällig
    // der Startzeit entspricht (24h später ist ein anderer Zeitpunkt); am selben
    // Tag erst ab TATZEIT_BIS_MIN_ABSTAND Minuten.
    timeTo: tatzeitBis(timeFrom, timeToRaw, !!dayTo),
    lat: coords.length
      ? Math.round((coords.reduce((s, p) => s + (p.lat as number), 0) / coords.length) * 1e6) / 1e6
      : null,
    lon: coords.length
      ? Math.round((coords.reduce((s, p) => s + (p.lon as number), 0) / coords.length) * 1e6) / 1e6
      : null,
  }
}

/** Einen Vorfall nach Fahrzeugen aufteilen (Regel siehe
 *  SINGLE_PLATE_MIN_CONFIDENCE). Fotos ohne eigenes Fahrzeug (Übersichtsbilder,
 *  unleserliche oder Hintergrund-Kennzeichen) gehen zum zeitlich nächsten Foto
 *  mit Fahrzeug, bei Gleichstand zum vorherigen – Fotos einer Tat entstehen
 *  direkt nacheinander. Weniger als zwei Fahrzeuge: Vorfall bleibt, wie er ist. */
export function splitByVehicle(photos: IntakePhoto[], minConfidence: number): IntakePhoto[][] {
  const sorted = [...photos].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
  const keyOf = (p: IntakePhoto): string | null =>
    p.plate && (p.plateConfidence ?? 0) >= minConfidence ? plateKey(p.plate) || null : null

  // Lesungen zu Fahrzeugen bündeln: häufigste Schreibweise zuerst, Varianten mit
  // Editierdistanz ≤ 1 gehören dazu (OCR-Fehler statt zweites Auto).
  const counts = new Map<string, number>()
  for (const p of sorted) {
    const k = keyOf(p)
    if (k) counts.set(k, (counts.get(k) || 0) + 1)
  }
  const keys = [...counts.keys()].sort((a, b) => (counts.get(b) as number) - (counts.get(a) as number))
  const vehicleOfKey = new Map<string, number>()
  const vehicles: { key: string; photos: number }[] = []
  for (const k of keys) {
    const v = vehicles.findIndex((x) => nearlySame(x.key, k))
    if (v >= 0) {
      vehicleOfKey.set(k, v)
      vehicles[v].photos += counts.get(k) as number
    } else {
      vehicleOfKey.set(k, vehicles.length)
      vehicles.push({ key: k, photos: counts.get(k) as number })
    }
  }
  const multi = vehicles.some((v) => v.photos >= 2)
  const counted = new Set(
    vehicles
      .map((v, i) => ({ v, i }))
      .filter(({ v }) =>
        multi
          ? v.photos >= 2
          : sorted.some((p) => keyOf(p) === v.key && (p.plateConfidence ?? 0) >= SINGLE_PLATE_MIN_CONFIDENCE)
      )
      .map(({ i }) => i)
  )
  if (counted.size < 2) return [photos]

  const own: (number | null)[] = sorted.map((p) => {
    const k = keyOf(p)
    const v = k !== null ? (vehicleOfKey.get(k) as number) : null
    return v !== null && counted.has(v) ? v : null
  })
  const assigned = own.map((v, i) => {
    if (v !== null) return v
    let prev = i - 1
    while (prev >= 0 && own[prev] === null) prev--
    let next = i + 1
    while (next < own.length && own[next] === null) next++
    if (prev < 0) return own[next] as number
    if (next >= own.length) return own[prev] as number
    const t = sorted[i].capturedAt
    const tp = sorted[prev].capturedAt
    const tn = sorted[next].capturedAt
    if (t && tp && tn && epochSeconds(tn) - epochSeconds(t) < epochSeconds(t) - epochSeconds(tp)) {
      return own[next] as number
    }
    return own[prev] as number
  })
  const groups = new Map<number, IntakePhoto[]>()
  sorted.forEach((p, i) => groups.set(assigned[i], [...(groups.get(assigned[i]) || []), p]))
  // Reihenfolge: nach erstem Foto (Map behält die Einfügereihenfolge).
  return [...groups.values()]
}

export function groupPhotos(input: IntakePhoto[], options: GroupOptions = {}): GroupingResult {
  const minPlateConfidence = options.minPlateConfidence ?? 0.75
  const photos = [...input].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))

  const withGps = photos.filter((p) => p.lat !== null && p.lon !== null)
  const timeOnly = photos.filter((p) => (p.lat === null || p.lon === null) && p.capturedAt)
  const noMeta = photos.filter((p) => (p.lat === null || p.lon === null) && !p.capturedAt)

  // Pass 1: räumliche Cluster. Anker = erstes Foto (kein wanderndes Zentroid,
  // sonst hinge das Ergebnis von der Reihenfolge ab). Gleicher Ort an einem
  // anderen Tag ist ein neuer Vorfall – außer das Foto schließt zeitlich an die
  // bisherigen Fotos des Clusters an (über Mitternacht andauernder Verstoß).
  const clusters: Cluster[] = []
  for (const p of withGps) {
    const day = dayOf(p.capturedAt)
    const match = clusters.find((c) => {
      if (distanceMeters(c.anchorLat, c.anchorLon, p.lat as number, p.lon as number) > RADIUS_M) {
        return false
      }
      if (day === null || c.day === null || c.day === day) return true
      // Anderer Tag: nur zusammenfassen, wenn zeitlich fortlaufend. Fotos sind
      // chronologisch sortiert – die Lücke zum spätesten Cluster-Foto zählt.
      const ts = c.photos
        .filter((g) => g.capturedAt)
        .map((g) => epochMinutes(g.capturedAt as string))
      if (!ts.length) return false
      return epochMinutes(p.capturedAt as string) - Math.max(...ts) <= OVERNIGHT_GAP_MIN
    })
    if (match) {
      match.photos.push(p)
      if (match.day === null) match.day = day
    } else {
      clusters.push({ anchorLat: p.lat as number, anchorLon: p.lon as number, day, photos: [p] })
    }
  }

  // Pass 2: GPS-lose Fotos mit Zeit. Eindeutig (genau ein Cluster, dessen
  // Zeitfenster ±Slack passt – durchgehende Zeitachse, deckt also auch Cluster
  // über Mitternacht ab) -> anhängen; sonst sammeln und zeitlich bei großen
  // Lücken splitten -> Vorfälle ohne Koordinaten.
  const leftover: IntakePhoto[] = []
  for (const p of timeOnly) {
    const t = epochMinutes(p.capturedAt as string)
    const candidates = clusters.filter((c) => {
      const ts = c.photos.filter((g) => g.capturedAt).map((g) => epochMinutes(g.capturedAt as string))
      if (!ts.length) return false
      return t >= Math.min(...ts) - TIME_ATTACH_SLACK_MIN && t <= Math.max(...ts) + TIME_ATTACH_SLACK_MIN
    })
    if (candidates.length === 1) candidates[0].photos.push(p)
    else leftover.push(p)
  }

  const incidents = clusters.flatMap((c) =>
    splitByVehicle(c.photos, minPlateConfidence).map((photos) => toIncident(photos))
  )

  // Übrige zeitbehaftete Fotos: chronologisch, bei Lücke > TIME_GAP_MIN neuer
  // Vorfall (durchgehende Zeitachse: 23:50 -> 00:10 ist KEINE große Lücke,
  // ein kurzer Vorfall über Mitternacht bleibt also zusammen).
  let run: IntakePhoto[] = []
  const flushRun = () => {
    if (run.length) {
      for (const photos of splitByVehicle(run, minPlateConfidence)) incidents.push(toIncident(photos))
    }
    run = []
  }
  for (const p of leftover) {
    const prev = run[run.length - 1]
    if (
      prev &&
      epochMinutes(p.capturedAt as string) - epochMinutes(prev.capturedAt as string) > TIME_GAP_MIN
    ) {
      flushRun()
    }
    run.push(p)
  }
  flushRun()

  return { incidents, unassigned: noMeta.map((p) => p.id) }
}
