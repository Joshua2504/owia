/** Mögliche Doppel-Anzeigen: gleiches Kennzeichen, Tatzeitpunkte nah beieinander
 *  (z.B. zwei Foto-Importe desselben Falschparkers). Wird in der Anzeigen-Liste
 *  als Hinweis mit „Zusammenführen" angezeigt – entschieden wird vom Nutzer. */

import { localIsoDate } from '../utils/format'

/** Max. Abstand zwischen zwei Tatzeitpunkten, damit sie als derselbe Vorfall gelten. */
export const DUPLICATE_WINDOW_MINUTES = 180

type ReportLike = {
  id: number
  aktenzeichen: string
  kennzeichen: string | null
  tattag: Date | string | null
  tatzeit_von: string | null
  status: string
}

export type DuplicateGroup<T extends ReportLike = ReportLike> = {
  kennzeichen: string
  reports: T[]
  /** Mindestens zwei Entwürfe → zusammenführbar. */
  mergeable: boolean
}

/** Vergleichs-Schlüssel: ohne Leer-/Bindestriche, Großschreibung. */
export function plateKey(p: string | null | undefined): string {
  return String(p || '').toLocaleUpperCase('de-DE').replace(/[\s\-–.]/g, '')
}

function dayStr(d: Date | string | null): string | null {
  if (!d) return null
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null
    return localIsoDate(d)
  }
  return String(d).slice(0, 10)
}

/** Tatzeitpunkt in Minuten seit Epoche (lokal, ohne Uhrzeit = Tagesmitte) oder null. */
function minutes(r: ReportLike): { t: number; hasTime: boolean } | null {
  const day = dayStr(r.tattag)
  if (!day) return null
  const [y, m, d] = day.split('-').map(Number)
  const time = r.tatzeit_von ? String(r.tatzeit_von) : ''
  const hasTime = /^\d{1,2}:\d{2}/.test(time)
  const [hh, mm] = hasTime ? time.split(':').map(Number) : [12, 0]
  return { t: Date.UTC(y, m - 1, d, hh, mm) / 60000, hasTime }
}

function near(a: ReportLike, b: ReportLike): boolean {
  const ta = minutes(a)
  const tb = minutes(b)
  if (!ta || !tb) return false
  // Ohne Uhrzeit genügt derselbe Tag.
  if (!ta.hasTime || !tb.hasTime) return dayStr(a.tattag) === dayStr(b.tattag)
  return Math.abs(ta.t - tb.t) <= DUPLICATE_WINDOW_MINUTES
}

/** Gruppiert Anzeigen mit gleichem Kennzeichen und naher Tatzeit (transitiv). */
export function findDuplicateGroups<T extends ReportLike>(reports: T[]): DuplicateGroup<T>[] {
  const byPlate = new Map<string, T[]>()
  for (const r of reports) {
    const key = plateKey(r.kennzeichen)
    if (key.length < 3) continue
    ;(byPlate.get(key) ?? byPlate.set(key, []).get(key)!).push(r)
  }
  const groups: DuplicateGroup<T>[] = []
  for (const list of byPlate.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => (minutes(a)?.t ?? 0) - (minutes(b)?.t ?? 0))
    let current: T[] = []
    const flush = () => {
      // Nur Gruppen mit mindestens einem Entwurf – sind alle schon eingereicht/versendet,
      // gibt es nichts mehr zu entscheiden (z.B. versehentlich doppelt versendet).
      if (current.length >= 2 && current.some((r) => r.status === 'entwurf')) {
        groups.push({
          kennzeichen: current[0].kennzeichen as string,
          reports: current,
          mergeable: current.filter((r) => r.status === 'entwurf').length >= 2,
        })
      }
      current = []
    }
    for (const r of sorted) {
      if (current.length && !current.some((c) => near(c, r))) flush()
      current.push(r)
    }
    flush()
  }
  return groups
}
