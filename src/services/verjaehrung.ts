/** Verfolgungsverjährung von Verkehrsordnungswidrigkeiten: drei Monate ab der
 *  Tat (§ 26 Abs. 3 StVG), solange noch kein Bußgeldbescheid ergangen ist.
 *  Eine verjährte Anzeige kann das Ordnungsamt nicht mehr ahnden – sie wird
 *  deshalb nicht mehr eingereicht. Maßgeblich ist das Ende der Tat (tattag_bis
 *  bei Tatzeiträumen über Mitternacht, sonst tattag). */

const FRIST_MONATE = 3

import { CITIES } from '../config/cities'

/** Frist für die Stadt der Anzeige: Verjährung (3 Monate) oder die kürzere
 *  Annahmefrist der Stadt (Frankfurt/Wiesbaden-Portal: 2 Monate). */
export function fristMonate(city: unknown): number {
  const c = typeof city === 'string' ? CITIES[city] : undefined
  return c?.fristMonate && c.fristMonate < FRIST_MONATE ? c.fristMonate : FRIST_MONATE
}
/** Ab so vielen Resttagen wird vor der nahenden Verjährung gewarnt. */
const WARN_TAGE = 14

type DateLike = Date | string | null | undefined
// Bewusst lose: DB-Zeilen (RowDataPacket) und View-Objekte gehen direkt hinein.
type TatDaten = { tattag?: unknown; tattag_bis?: unknown; [k: string]: unknown }

/** Kalendertag als lokales Datum (00:00). mysql2 liefert DATE-Spalten als Date
 *  in Server-Zeitzone; Strings im Format YYYY-MM-DD kommen aus Formularen. */
function toDay(d: DateLike): Date | null {
  if (!d) return null
  if (d instanceof Date) return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** Erster Tag, an dem die Tat verjährt ist: Die Frist endet mit Ablauf des
 *  Vortags des kalendermäßig entsprechenden Tags (Tat 6.7. → verjährt ab 6.10.). */
export function verjaehrtAb(r: TatDaten): Date | null {
  const tat = toDay(r.tattag_bis as DateLike) || toDay(r.tattag as DateLike)
  if (!tat) return null
  const ab = new Date(tat.getFullYear(), tat.getMonth() + fristMonate(r.city), tat.getDate())
  // Fehlt der entsprechende Tag (30.11. + 3 Monate), endet die Frist mit dem
  // Monatsletzten (§ 188 Abs. 3 BGB) – verjährt also ab dem 1. des Folgemonats.
  if (ab.getDate() !== tat.getDate()) ab.setDate(1)
  return ab
}

export type VerjaehrungStatus = {
  verjaehrt: boolean; bald: boolean; ab: Date | null; restTage: number | null
  /** 2 = Annahmefrist der Stadt, 3 = Verjährung; text für Hinweise. */
  monate: number; text: string
}

export function verjaehrung(r: TatDaten, now = new Date()): VerjaehrungStatus {
  const ab = verjaehrtAb(r)
  const monate = fristMonate(r.city)
  const text = monate < FRIST_MONATE
    ? `Die Tat liegt mehr als ${monate === 2 ? 'zwei' : monate} Monate zurück – ${CITIES[r.city as string]?.name ?? 'die Stadt'} nimmt sie nicht mehr an.`
    : 'Die Tat liegt mehr als drei Monate zurück und ist verjährt.'
  if (!ab) return { verjaehrt: false, bald: false, ab: null, restTage: null, monate, text }
  const heute = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const restTage = Math.round((ab.getTime() - heute.getTime()) / 86_400_000)
  return { verjaehrt: restTage <= 0, bald: restTage > 0 && restTage <= WARN_TAGE, ab, restTage, monate, text }
}

export function isVerjaehrt(r: TatDaten): boolean {
  return verjaehrung(r).verjaehrt
}
