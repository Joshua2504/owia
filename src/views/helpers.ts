// Formatier- und Markup-Helfer für die EJS-Views, als `h` im Render-Kontext
// (server.ts defaultContext). ejs.renderFile kennt diesen Kontext nicht –
// wer Views direkt rendert (editor.ts /listenzeile, Tests), gibt `h` mit.
//
// Foto-Zeitstempel ('YYYY-MM-DD HH:MM:SS') gehen hier nicht durch – die
// bleiben Strings (Konvention, s. CLAUDE.md). Die Helfer sind für DB-DATE/
// DATETIME-Werte, die mysql2 als Date liefert, und für TIME-Strings.

const pad2 = (n: number) => String(n).padStart(2, '0')

function toDate(d: unknown): Date | null {
  if (!d) return null
  const x = d instanceof Date ? d : new Date(String(d))
  return isNaN(x.getTime()) ? null : x
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

// Anzeigen-Status → Badge. „Bereit" ist kein Status, sondern eine Markierung
// am Entwurf (bereit_at) und bleibt Sache von report-row.ejs.
const STATUS: Record<string, { label: string; cls: string }> = {
  entwurf: { label: 'Entwurf', cls: 'text-bg-warning' },
  eingereicht: { label: 'Eingereicht', cls: 'text-bg-info' },
  versendet: { label: 'Versendet', cls: 'text-bg-success' },
  papierkorb: { label: 'Papierkorb', cls: 'text-bg-secondary' },
}

export const viewHelpers = {
  pad2,
  escapeHtml,
  /** TIME/'HH:MM:SS' → 'HH:MM' ('' wenn leer). */
  hhmm: (t: unknown): string => (t ? String(t).slice(0, 5) : ''),
  /** Datum deutsch (TT.MM.JJJJ), sonst `fallback`. */
  fmtDate: (d: unknown, fallback = ''): string => toDate(d)?.toLocaleDateString('de-DE') ?? fallback,
  /** Datum für <input type="date"> (lokale Zeit, nicht UTC wie toISOString). */
  isoDate: (d: unknown): string => {
    const x = toDate(d)
    return x ? `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}` : ''
  },
  /** Sekunden → 'MM:SS' (Minuten auch über 60 – wie der Countdown in report-table.js). */
  mmss: (sek: number): string => pad2(Math.floor(sek / 60)) + ':' + pad2(sek % 60),
  /** Sekunden → 'MM:SS' bzw. 'H:MM:SS'. */
  dauer: (sek: number): string => {
    const h = Math.floor(sek / 3600), m = Math.floor((sek % 3600) / 60), s = sek % 60
    return (h ? `${h}:${pad2(m)}` : pad2(m)) + ':' + pad2(s)
  },
  /** Tattag(e) einer Anzeige: 'TT.MM.JJJJ' bzw. 'TT.MM.JJJJ – TT.MM.JJJJ'; long = '9. Oktober 2026'. */
  tattage: (r: { tattag?: unknown; tattag_bis?: unknown }, { long = false, fallback = '—' } = {}): string => {
    const f = (d: unknown) => toDate(d)?.toLocaleDateString('de-DE', long ? { dateStyle: 'long' } : undefined) ?? ''
    const von = f(r.tattag), bis = f(r.tattag_bis)
    if (!von) return fallback
    return bis && bis !== von ? `${von} – ${bis}` : von
  },
  /** Uhrzeit(en) ohne „Uhr": 'HH:MM' bzw. 'HH:MM – HH:MM' ('' wenn keine). */
  uhrzeit: (r: { tatzeit_von?: unknown; tatzeit_bis?: unknown }): string => {
    const von = viewHelpers.hhmm(r.tatzeit_von), bis = viewHelpers.hhmm(r.tatzeit_bis)
    if (von && bis && bis !== von) return `${von} – ${bis}`
    return von || bis
  },
  zahl: (n: number): string => n.toLocaleString('de-DE'),
  /** Euro, Cent nur wenn nötig. */
  eur: (n: number): string =>
    n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }),
  /** Kennzeichen-Chip (.plate-chip), Länderkürzel außer D klein davor. */
  plate: (kz: unknown, land?: unknown, cls = ''): string => {
    if (!kz) return ''
    const l = land && land !== 'D' ? `<small>${escapeHtml(land)}</small>` : ''
    return `<span class="plate-chip${cls ? ' ' + cls : ''}">${l}${escapeHtml(kz)}</span>`
  },
  /** Status-Badge einer Anzeige; `extra` hängt z.B. eine Uhrzeit an. */
  statusBadge: (status: unknown, extra = ''): string => {
    const s = STATUS[String(status)] || { label: String(status || '—'), cls: 'text-bg-secondary' }
    return `<span class="badge ${s.cls}">${escapeHtml(s.label + extra)}</span>`
  },
}

export type ViewHelpers = typeof viewHelpers
