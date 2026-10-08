// „Uhrzeit bis" aus Foto-Aufnahmezeiten: Liegen frühestes und spätestes Foto
// am selben Tag weniger als TATZEIT_BIS_MIN_ABSTAND Minuten auseinander, ist
// das ein Zeitpunkt, kein Zeitraum (sonst stünde „16:18 – 16:18" da). Bei
// Tageswechsel (Dauerparken über Nacht) gehört „bis" immer dazu. Gleiche Regel
// in public/js/photo-edit.js und public/js/report-form.js.
export const TATZEIT_BIS_MIN_ABSTAND = 3

const minuten = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** `bis` ('HH:MM[:SS]') oder null, wenn es nur einen Zeitpunkt beschreibt. */
export function tatzeitBis(von: string | null, bis: string | null, tagWechsel: boolean): string | null {
  if (!bis) return null
  if (tagWechsel || !von) return bis
  return minuten(bis) - minuten(von) >= TATZEIT_BIS_MIN_ABSTAND ? bis : null
}
