// Anzeigende Person: Anrede und Anschrift (Straße und Hausnummer getrennt seit
// Migration 0039 – das Frankfurter Portal verlangt beides als eigene Felder).

export const ANREDEN: { value: string; label: string; portal: string }[] = [
  { value: 'herr', label: 'Herr', portal: 'Herr' },
  { value: 'frau', label: 'Frau', portal: 'Frau' },
  { value: 'neutral', label: 'Geschlechtsneutral', portal: 'Mit geschlechtsneutraler Anrede' },
]

/** Portal-Anrede; ohne Angabe geschlechtsneutral. */
export function portalAnrede(anrede: string | null | undefined): string {
  return ANREDEN.find((a) => a.value === anrede)?.portal ?? 'Mit geschlechtsneutraler Anrede'
}

/** „Straße Hausnummer" für PDF, Mails und Ansichten. */
export function strasseMitNummer(u: Record<string, any>): string {
  return [u.strasse, u.hausnummer].map((x) => (x || '').trim()).filter(Boolean).join(' ')
}
