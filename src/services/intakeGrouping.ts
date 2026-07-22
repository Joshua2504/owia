// Gruppierung der Sammel-Import-Fotos zu "Vorfällen" (je Vorfall entsteht ein
// Entwurf). Grundidee: der Ort ist das primäre Signal – Fotos innerhalb von
// ~50 m am selben Tag gehören zu EINEM Verstoß, dessen Dauer sich aus
// frühester und spätester Aufnahmezeit ergibt (tatzeit_von/bis). Ein Vorfall
// darf über Mitternacht andauern (Dauerparken über Nacht): Fotos am selben Ort
// an Folgetagen werden zusammengefasst, wenn sie zeitlich fortlaufend sind
// (Lücke ≤ OVERNIGHT_GAP_MIN, z.B. Foto abends + Foto am nächsten Morgen) –
// der Vorfall trägt dann day..dayTo. Bewusst ohne Libraries und
// deterministisch, damit dieselben Fotos immer dieselben Gruppen ergeben.

export type IntakePhoto = {
  id: number
  capturedAt: string | null // 'YYYY-MM-DD HH:MM:SS' (Wanduhrzeit)
  lat: number | null
  lon: number | null
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

function sortKey(p: IntakePhoto): string {
  // Fotos ohne Zeit ans Ende; ID als Tiebreaker für Determinismus.
  return `${p.capturedAt ?? '9999-99-99 99:99:99'}#${String(p.id).padStart(12, '0')}`
}

function toIncident(photos: IntakePhoto[]): Incident {
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
    // der Startzeit entspricht (24h später ist ein anderer Zeitpunkt).
    timeTo: timeToRaw && (timeToRaw !== timeFrom || dayTo) ? timeToRaw : null,
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

  const incidents = clusters.map((c) => toIncident(c.photos))

  // Übrige zeitbehaftete Fotos: chronologisch, bei Lücke > TIME_GAP_MIN neuer
  // Vorfall (durchgehende Zeitachse: 23:50 -> 00:10 ist KEINE große Lücke,
  // ein kurzer Vorfall über Mitternacht bleibt also zusammen).
  let run: IntakePhoto[] = []
  const flushRun = () => {
    if (run.length) incidents.push(toIncident(run))
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
