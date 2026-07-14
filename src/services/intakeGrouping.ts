// Gruppierung der Sammel-Import-Fotos zu "Vorfällen" (je Vorfall entsteht ein
// Entwurf). Grundidee: der Ort ist das primäre Signal – Fotos innerhalb von
// ~50 m am selben Tag gehören zu EINEM Verstoß, dessen Dauer sich aus
// frühester und spätester Aufnahmezeit ergibt (tatzeit_von/bis). Erkannte
// Kennzeichen (aus der optionalen, kostenpflichtigen Analyse) verfeinern nur:
// zwei Fahrzeuge am selben Ort werden getrennt. Bewusst ohne Libraries und
// deterministisch, damit dieselben Fotos immer dieselben Gruppen ergeben.

export type IntakePhoto = {
  id: number
  capturedAt: string | null // 'YYYY-MM-DD HH:MM:SS' (Wanduhrzeit)
  lat: number | null
  lon: number | null
  plate?: string | null
}

export type Incident = {
  photoIds: number[]
  day: string | null // 'YYYY-MM-DD'
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
export const RADIUS_M = 50
export const TIME_ATTACH_SLACK_MIN = 15
export const TIME_GAP_MIN = 60

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

/** Minuten seit Mitternacht (Datum wird ignoriert – Cluster sind tagesrein). */
function minutesOf(capturedAt: string): number {
  return Number(capturedAt.slice(11, 13)) * 60 + Number(capturedAt.slice(14, 16))
}

function sortKey(p: IntakePhoto): string {
  // Fotos ohne Zeit ans Ende; ID als Tiebreaker für Determinismus.
  return `${p.capturedAt ?? '9999-99-99 99:99:99'}#${String(p.id).padStart(12, '0')}`
}

function toIncident(photos: IntakePhoto[]): Incident {
  const times = photos.map((p) => p.capturedAt).filter((t): t is string => t !== null).sort()
  const coords = photos.filter((p) => p.lat !== null && p.lon !== null)
  const timeFrom = times.length ? timeOf(times[0]) : null
  const timeToRaw = times.length ? timeOf(times[times.length - 1]) : null
  return {
    photoIds: photos.map((p) => p.id),
    day: times.length ? dayOf(times[0]) : null,
    timeFrom,
    timeTo: timeToRaw && timeToRaw !== timeFrom ? timeToRaw : null,
    lat: coords.length
      ? Math.round((coords.reduce((s, p) => s + (p.lat as number), 0) / coords.length) * 1e6) / 1e6
      : null,
    lon: coords.length
      ? Math.round((coords.reduce((s, p) => s + (p.lon as number), 0) / coords.length) * 1e6) / 1e6
      : null,
  }
}

export function groupPhotos(input: IntakePhoto[]): GroupingResult {
  const photos = [...input].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))

  const withGps = photos.filter((p) => p.lat !== null && p.lon !== null)
  const timeOnly = photos.filter((p) => (p.lat === null || p.lon === null) && p.capturedAt)
  const noMeta = photos.filter((p) => (p.lat === null || p.lon === null) && !p.capturedAt)

  // Pass 1: räumliche Cluster. Anker = erstes Foto (kein wanderndes Zentroid,
  // sonst hinge das Ergebnis von der Reihenfolge ab). Gleicher Ort an einem
  // anderen Tag ist ein neuer Vorfall.
  const clusters: Cluster[] = []
  for (const p of withGps) {
    const day = dayOf(p.capturedAt)
    const match = clusters.find(
      (c) =>
        distanceMeters(c.anchorLat, c.anchorLon, p.lat as number, p.lon as number) <= RADIUS_M &&
        (day === null || c.day === null || c.day === day)
    )
    if (match) {
      match.photos.push(p)
      if (match.day === null) match.day = day
    } else {
      clusters.push({ anchorLat: p.lat as number, anchorLon: p.lon as number, day, photos: [p] })
    }
  }

  // Pass 2: Kennzeichen-Verfeinerung. Nur relevant, wenn Analyse-Daten
  // vorliegen (heute i.d.R. nicht – dann ist das ein No-op). Cluster mit
  // mehreren erkannten Kennzeichen werden pro Kennzeichen aufgeteilt;
  // kennzeichenlose Fotos wandern zum zeitlich nächsten Teil-Cluster.
  const refined: Cluster[] = []
  for (const c of clusters) {
    const plates = [...new Set(c.photos.map((p) => p.plate).filter((x): x is string => !!x))]
    if (plates.length < 2) {
      refined.push(c)
      continue
    }
    const parts = new Map<string, IntakePhoto[]>(plates.map((pl) => [pl, []]))
    const plateless: IntakePhoto[] = []
    for (const p of c.photos) {
      if (p.plate && parts.has(p.plate)) parts.get(p.plate)!.push(p)
      else plateless.push(p)
    }
    for (const p of plateless) {
      if (!p.capturedAt) {
        // Ohne Zeit keine sinnvolle Zuordnung – zum größten Teil-Cluster.
        const biggest = [...parts.values()].sort((a, b) => b.length - a.length)[0]
        biggest.push(p)
        continue
      }
      const t = minutesOf(p.capturedAt)
      let best: IntakePhoto[] | null = null
      let bestDist = Infinity
      for (const group of parts.values()) {
        const ts = group.filter((g) => g.capturedAt).map((g) => minutesOf(g.capturedAt as string))
        if (!ts.length) continue
        const d = Math.min(...ts.map((x) => Math.abs(x - t)))
        if (d < bestDist) {
          bestDist = d
          best = group
        }
      }
      ;(best ?? [...parts.values()][0]).push(p)
    }
    for (const group of parts.values()) {
      if (group.length) {
        refined.push({ anchorLat: c.anchorLat, anchorLon: c.anchorLon, day: c.day, photos: group })
      }
    }
  }

  // Pass 3: GPS-lose Fotos mit Zeit. Eindeutig (genau ein Cluster mit gleichem
  // Tag, dessen Zeitfenster ±Slack passt) -> anhängen; sonst sammeln und
  // zeitlich bei großen Lücken splitten -> Vorfälle ohne Koordinaten.
  const leftover: IntakePhoto[] = []
  for (const p of timeOnly) {
    const day = dayOf(p.capturedAt)
    const t = minutesOf(p.capturedAt as string)
    const candidates = refined.filter((c) => {
      if (c.day !== day) return false
      const ts = c.photos.filter((g) => g.capturedAt).map((g) => minutesOf(g.capturedAt as string))
      if (!ts.length) return false
      return t >= Math.min(...ts) - TIME_ATTACH_SLACK_MIN && t <= Math.max(...ts) + TIME_ATTACH_SLACK_MIN
    })
    if (candidates.length === 1) candidates[0].photos.push(p)
    else leftover.push(p)
  }

  const incidents = refined.map((c) => toIncident(c.photos))

  // Übrige zeitbehaftete Fotos: chronologisch, bei Lücke > TIME_GAP_MIN oder
  // Tageswechsel neuer Vorfall.
  let run: IntakePhoto[] = []
  const flushRun = () => {
    if (run.length) incidents.push(toIncident(run))
    run = []
  }
  for (const p of leftover) {
    const prev = run[run.length - 1]
    if (
      prev &&
      (dayOf(prev.capturedAt) !== dayOf(p.capturedAt) ||
        minutesOf(p.capturedAt as string) - minutesOf(prev.capturedAt as string) > TIME_GAP_MIN)
    ) {
      flushRun()
    }
    run.push(p)
  }
  flushRun()

  return { incidents, unassigned: noMeta.map((p) => p.id) }
}
