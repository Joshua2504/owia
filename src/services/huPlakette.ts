// HU-Prüfplaketten („TÜV-Plaketten") für die Startseite: welche Jahrgänge
// sind heute gültig, welche abgelaufen? Die Plakettenfarbe wiederholt sich im
// Sechs-Jahres-Zyklus (2020 grün, 2021 orange, 2022 blau, 2023 gelb,
// 2024 braun, 2025 rosa, 2026 wieder grün …). Die Plakette gilt bis zum Ende
// des oben angezeigten Monats ihres Jahres.

const COLORS = [
  { name: 'grün', bg: '#3a9d3a', fg: '#fff' },
  { name: 'orange', bg: '#f08a24', fg: '#000' },
  { name: 'blau', bg: '#2f6fc2', fg: '#fff' },
  { name: 'gelb', bg: '#f5d31f', fg: '#000' },
  { name: 'braun', bg: '#8a5a2b', fg: '#fff' },
  { name: 'rosa', bg: '#f2a7c3', fg: '#000' },
]

const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.']

export interface Plakette {
  year: number
  color: { name: string; bg: string; fg: string }
  note: string
}

function plakette(year: number, note: string): Plakette {
  return { year, color: COLORS[(((year - 2020) % 6) + 6) % 6], note }
}

// Gültig: aktuelles Jahr ab dem laufenden Monat, plus die nächsten Jahre (HU
// alle 2 Jahre, Neuwagen erstmals nach 3 Jahren). Abgelaufen: aktuelles Jahr
// bis Vormonat sowie die drei Vorjahre.
export function huPlaketten(now = new Date()) {
  const y = now.getFullYear()
  const m = now.getMonth() // 0-basiert
  const valid: Plakette[] = [
    plakette(y, m === 11 ? 'nur noch Dez.' : `ab ${MONTHS[m]}`),
    plakette(y + 1, 'alle Monate'),
    plakette(y + 2, 'alle Monate'),
    plakette(y + 3, 'Neuwagen'),
  ]
  const expired: Plakette[] = []
  if (m > 0) expired.push(plakette(y, m === 1 ? 'Jan.' : `Jan.–${MONTHS[m - 1]}`))
  for (let i = 1; i <= 3; i++) expired.push(plakette(y - i, 'alle Monate'))
  return { valid, expired, today: `${MONTHS[m]} ${y}` }
}
