// Öffentliche Bußgeld-Statistik (/statistik): summiert die Regelsätze laut
// Bußgeldkatalog über alle versendeten Anzeigen. Nur Aggregate – kein
// Kennzeichen, kein Tatort, kein Nutzer. Grundlage sind dieselben Anzeigen wie
// für Startseite/Karte (status='versendet'), damit die Zahlen zusammenpassen.
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { regelsatzEuro, tbnrAusLabel, verstossText } from '../config/verstoss'
import { getCity } from '../config/cities'

export interface StatistikZeile {
  /** Zeilenkennung: TBNR, Monat „YYYY-MM" oder Stadt-ID. */
  key: string
  label: string
  anzahl: number
  /** Summe der Regelsätze; Anzeigen ohne Regelsatz zählen nur bei `anzahl`. */
  euro: number
}

export interface TatbestandZeile extends StatistikZeile {
  regelsatz: number | null
}

export interface Statistik {
  anzahl: number
  /** Anzeigen mit bekanntem Regelsatz (Rest: fehlende/sonstige Verstoßart). */
  mitRegelsatz: number
  euro: number
  tatbestaende: TatbestandZeile[]
  monate: StatistikZeile[]
  staedte: StatistikZeile[]
}

/** Eine Zeile je Anzeige: gespeichertes Verstoß-Label, Tatmonat, Stadt. */
export interface StatistikEingabe {
  verstoss_art: string | null
  monat: string | null
  city: string | null
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember']

function monatLabel(monat: string): string {
  const [y, m] = monat.split('-')
  return `${MONATE[Number(m) - 1] ?? m} ${y}`
}

function add(map: Map<string, StatistikZeile>, key: string, label: string, euro: number | null) {
  const z = map.get(key) ?? { key, label, anzahl: 0, euro: 0 }
  z.anzahl++
  z.euro += euro ?? 0
  map.set(key, z)
}

/** Reine Aggregation (ohne DB), damit sie isoliert testbar bleibt. */
export function aggregiere(rows: StatistikEingabe[]): Statistik {
  const tat = new Map<string, StatistikZeile>()
  const mon = new Map<string, StatistikZeile>()
  const stadt = new Map<string, StatistikZeile>()
  let euro = 0
  let mitRegelsatz = 0
  for (const r of rows) {
    const tbnr = tbnrAusLabel(r.verstoss_art)
    const betrag = regelsatzEuro(tbnr)
    if (betrag !== null) { euro += betrag; mitRegelsatz++ }
    if (tbnr && betrag !== null) add(tat, tbnr, verstossText(tbnr) ?? tbnr, betrag)
    else add(tat, 'sonstige', 'Sonstige / ohne Katalog-Tatbestand', null)
    if (r.monat) add(mon, r.monat, monatLabel(r.monat), betrag)
    const city = r.city || ''
    add(stadt, city, city ? getCity(city).name : 'unbekannt', betrag)
  }
  const tatbestaende: TatbestandZeile[] = [...tat.values()]
    .map((z) => ({ ...z, regelsatz: z.key === 'sonstige' ? null : regelsatzEuro(z.key) }))
    // Nach Summe, bei Gleichstand nach Anzahl; „sonstige" (0 €) landet unten.
    .sort((a, b) => b.euro - a.euro || b.anzahl - a.anzahl)
  return {
    anzahl: rows.length,
    mitRegelsatz,
    euro,
    tatbestaende,
    monate: [...mon.values()].sort((a, b) => a.key.localeCompare(b.key)),
    staedte: [...stadt.values()].sort((a, b) => b.anzahl - a.anzahl),
  }
}

export async function ladeStatistik(): Promise<Statistik> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT verstoss_art, DATE_FORMAT(tattag, '%Y-%m') AS monat, city
       FROM reports WHERE status = 'versendet'`
  )
  return aggregiere(rows as StatistikEingabe[])
}
