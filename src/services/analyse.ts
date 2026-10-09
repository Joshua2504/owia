// Explorative Analyse (/analyse öffentlich, /admin/analyse mit Kennzeichen).
// Grundlage wie /statistik: nur versendete Anzeigen. Öffentlich werden
// Fahrzeuge pseudonymisiert („Fahrzeug 1"), ohne Tatort und ohne Farbe/Modell,
// damit sich aus Datum + Marke kein konkretes Auto ableiten lässt; das echte
// Kennzeichen gibt es nur in der Admin-Ansicht.
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { regelsatzEuro, tbnrAusLabel, verstossText } from '../config/verstoss'
import { getCity } from '../config/cities'

export interface AnalyseEingabe {
  kennzeichen: string | null
  fahrzeug_marke: string | null
  fahrzeug_typ: string | null
  fahrzeug_farbe: string | null
  verstoss_art: string | null
  tattag: string | null
  stunde: number | null
  city: string | null
  behinderung: number
  fahrzeug_verlassen: number
  tatort: string | null
  // Nur für die Admin-Detailkarte (Hover); öffentlich nie ausgegeben.
  id?: number
  aktenzeichen?: string | null
  tatort_lat?: number | string | null
  tatort_lon?: number | string | null
  tatzeit_von?: string | null
  tatzeit_bis?: string | null
  tattag_bis?: string | null
  fahrzeug_modell?: string | null
  beschreibung?: string | null
  behinderung_text?: string | null
  image_ids?: string | null
  hat_pdf?: number | null
}

/** Anzeigendetails für die Hover-Karte in /admin/analyse. */
export interface VergehenDetail {
  id: number
  az: string | null
  kennzeichen: string | null
  lat: number | null
  lon: number | null
  von: string | null
  bis: string | null
  tattagBis: string | null
  verstoss: string | null
  fahrzeug: string
  beschreibung: string | null
  behinderungText: string | null
  verlassen: boolean
  bilder: number[]
  pdf: boolean
}

export interface Vergehen {
  datum: string | null
  wochentag: string | null
  stunde: number | null
  tatbestand: string
  euro: number | null
  stadt: string
  behinderung: boolean
  /** Nur Admin-Ansicht. */
  tatort?: string | null
  detail?: VergehenDetail
}

export interface Wiederholer {
  platz: number
  /** Echtes Kennzeichen nur, wenn `mitKennzeichen`. */
  name: string
  marke: string | null
  typ: string | null
  farbe?: string | null
  anzahl: number
  tage: number
  euro: number
  erst: string | null
  letzt: string | null
  vergehen: Vergehen[]
}

export interface Zaehler { label: string; anzahl: number }

export interface Analyse {
  anzahl: number
  fahrzeuge: number
  wiederholer: number
  anzeigenVonWiederholern: number
  euro: number
  ranking: Wiederholer[]
  /** Wie viele Fahrzeuge wurden 1×, 2×, 3× … angezeigt. */
  haeufigkeit: Zaehler[]
  /** [Wochentag Mo..So][Stunde 0..23] */
  heatmap: number[][]
  wochentage: Zaehler[]
  stunden: Zaehler[]
  marken: Zaehler[]
  typen: Zaehler[]
  farben: Zaehler[]
  tatbestaende: Zaehler[]
  behinderung: number
  verlassen: number
  mitStunde: number
  mitDatum: number
}

const WT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

function normKz(k: string | null): string {
  return (k || '').toUpperCase().replace(/[\s-]/g, '')
}

function wochentagIndex(datum: string): number {
  // tattag kommt als „YYYY-MM-DD"; UTC, damit die Zeitzone nicht verschiebt.
  return (new Date(datum + 'T00:00:00Z').getUTCDay() + 6) % 7
}

function zaehle(werte: (string | null)[], top = 12): Zaehler[] {
  const m = new Map<string, number>()
  const label = new Map<string, string>()
  for (const w of werte) {
    const k = (w || '').trim()
    if (!k) continue
    // Schreibweisen zusammenfassen („vw"/„VW"), Anzeige in der häufigsten Form.
    const key = k.toLocaleLowerCase('de')
    m.set(key, (m.get(key) ?? 0) + 1)
    if (!label.has(key)) label.set(key, k)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([k, n]) => ({ label: label.get(k)!, anzahl: n }))
}
function koord(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n !== 0 ? n : null
}

function detail(r: AnalyseEingabe): VergehenDetail | undefined {
  if (r.id === undefined) return undefined
  return {
    id: r.id,
    az: r.aktenzeichen ?? null,
    kennzeichen: r.kennzeichen,
    lat: koord(r.tatort_lat),
    lon: koord(r.tatort_lon),
    von: r.tatzeit_von?.slice(0, 5) ?? null,
    bis: r.tatzeit_bis?.slice(0, 5) ?? null,
    tattagBis: r.tattag_bis ?? null,
    verstoss: r.verstoss_art,
    fahrzeug: [r.fahrzeug_marke, r.fahrzeug_modell, r.fahrzeug_typ, r.fahrzeug_farbe].filter(Boolean).join(' · '),
    beschreibung: r.beschreibung ?? null,
    behinderungText: r.behinderung_text ?? null,
    verlassen: !!r.fahrzeug_verlassen,
    pdf: !!r.hat_pdf,
    bilder: String(r.image_ids || '').split(',').filter(Boolean).map(Number).slice(0, 12),
  }
}

function tatbestand(verstoss: string | null): { text: string; euro: number | null } {
  const tbnr = tbnrAusLabel(verstoss)
  const euro = regelsatzEuro(tbnr)
  if (tbnr && euro !== null) return { text: verstossText(tbnr) ?? tbnr, euro }
  return { text: (verstoss || '').trim() || 'ohne Angabe', euro: null }
}

/** Reine Aggregation (ohne DB). */
export function analysiere(rows: AnalyseEingabe[], opts: { mitKennzeichen?: boolean; rankingMin?: number } = {}): Analyse {
  const min = opts.rankingMin ?? 2
  const gruppen = new Map<string, AnalyseEingabe[]>()
  const heatmap = WT.map(() => Array<number>(24).fill(0))
  const wt = Array<number>(7).fill(0)
  const st = Array<number>(24).fill(0)
  let euro = 0, behinderung = 0, verlassen = 0, mitStunde = 0, mitDatum = 0

  for (const r of rows) {
    const k = normKz(r.kennzeichen)
    if (k) gruppen.set(k, [...(gruppen.get(k) ?? []), r])
    euro += tatbestand(r.verstoss_art).euro ?? 0
    if (r.behinderung) behinderung++
    if (r.fahrzeug_verlassen) verlassen++
    const d = r.tattag ? wochentagIndex(r.tattag) : null
    const h = r.stunde
    if (d !== null) { wt[d]++; mitDatum++ }
    if (h !== null && h >= 0 && h < 24) { st[h]++; mitStunde++ }
    if (d !== null && h !== null && h >= 0 && h < 24) heatmap[d][h]++
  }

  const ranking: Wiederholer[] = [...gruppen.entries()]
    .filter(([, rs]) => rs.length >= min)
    .map(([kz, rs]) => {
      const vergehen: Vergehen[] = rs
        .map((r) => {
          const t = tatbestand(r.verstoss_art)
          const v: Vergehen = {
            datum: r.tattag,
            wochentag: r.tattag ? WT[wochentagIndex(r.tattag)] : null,
            stunde: r.stunde,
            tatbestand: t.text,
            euro: t.euro,
            stadt: r.city ? getCity(r.city).name : 'unbekannt',
            behinderung: !!r.behinderung,
          }
          if (opts.mitKennzeichen) {
            v.tatort = r.tatort
            v.detail = detail(r)
          }
          return v
        })
        .sort((a, b) => (a.datum ?? '').localeCompare(b.datum ?? '') || (a.stunde ?? 0) - (b.stunde ?? 0))
      const daten = vergehen.map((v) => v.datum).filter((d): d is string => !!d)
      const erste = (f: (r: AnalyseEingabe) => string | null) => zaehle(rs.map(f), 1)[0]?.label ?? null
      const w: Wiederholer = {
        platz: 0,
        name: kz,
        marke: erste((r) => r.fahrzeug_marke),
        typ: erste((r) => r.fahrzeug_typ),
        anzahl: rs.length,
        tage: new Set(daten).size,
        euro: vergehen.reduce((s, v) => s + (v.euro ?? 0), 0),
        erst: daten[0] ?? null,
        letzt: daten[daten.length - 1] ?? null,
        vergehen,
      }
      if (opts.mitKennzeichen) {
        w.farbe = erste((r) => r.fahrzeug_farbe)
        // Gruppiert wird über die normalisierte Form („FMM1016"), angezeigt
        // die häufigste gespeicherte Schreibweise („F-MM 1016").
        w.name = erste((r) => r.kennzeichen) ?? kz
      }
      return w
    })
    // Verschiedene Tattage zählen vor reiner Anzahl: zwei Anzeigen am selben
    // Tag sind oft nur ein doppelt angelegter Vorgang.
    .sort((a, b) => b.tage - a.tage || b.anzahl - a.anzahl || b.euro - a.euro)
  ranking.forEach((w, i) => {
    w.platz = i + 1
    if (!opts.mitKennzeichen) {
      w.name = `Fahrzeug ${i + 1}`
      // Öffentlich nur Monatsgenauigkeit (Zeitraum und Einzeltaten), damit sich
      // ein Platz nicht über Tag + Uhrzeit mit der öffentlichen Karte verknüpfen lässt.
      w.erst = w.erst?.slice(0, 7) ?? null
      w.letzt = w.letzt?.slice(0, 7) ?? null
      for (const v of w.vergehen) v.datum = v.datum?.slice(0, 7) ?? null
    }
  })

  const haeufig = new Map<number, number>()
  for (const rs of gruppen.values()) haeufig.set(rs.length, (haeufig.get(rs.length) ?? 0) + 1)
  const wiederholerGruppen = [...gruppen.values()].filter((rs) => rs.length >= 2)

  return {
    anzahl: rows.length,
    fahrzeuge: gruppen.size,
    wiederholer: wiederholerGruppen.length,
    anzeigenVonWiederholern: wiederholerGruppen.reduce((s, rs) => s + rs.length, 0),
    euro,
    ranking,
    haeufigkeit: [...haeufig.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, c]) => ({ label: `${n}×`, anzahl: c })),
    heatmap,
    wochentage: WT.map((l, i) => ({ label: l, anzahl: wt[i] })),
    stunden: st.map((n, i) => ({ label: String(i), anzahl: n })),
    marken: zaehle(rows.map((r) => r.fahrzeug_marke)),
    typen: zaehle(rows.map((r) => r.fahrzeug_typ)),
    farben: zaehle(rows.map((r) => r.fahrzeug_farbe)),
    tatbestaende: zaehle(rows.map((r) => tatbestand(r.verstoss_art).text), 15),
    behinderung,
    verlassen,
    mitStunde,
    mitDatum,
  }
}

export async function ladeAnalyse(opts: { mitKennzeichen?: boolean } = {}): Promise<Analyse> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT kennzeichen, fahrzeug_marke, fahrzeug_typ, fahrzeug_farbe, verstoss_art,
            DATE_FORMAT(tattag, '%Y-%m-%d') AS tattag, HOUR(tatzeit_von) AS stunde,
            city, behinderung, fahrzeug_verlassen, tatort,
            id, aktenzeichen, tatort_lat, tatort_lon,
            TIME_FORMAT(tatzeit_von, '%H:%i') AS tatzeit_von, TIME_FORMAT(tatzeit_bis, '%H:%i') AS tatzeit_bis,
            DATE_FORMAT(tattag_bis, '%Y-%m-%d') AS tattag_bis, fahrzeug_modell, beschreibung, behinderung_text,
            pdf_filename IS NOT NULL AS hat_pdf,
            (SELECT GROUP_CONCAT(ri.id ORDER BY ri.sort_order, ri.id) FROM report_images ri
              WHERE ri.report_id = reports.id) AS image_ids
       FROM reports WHERE status = 'versendet'`
  )
  return analysiere(rows as AnalyseEingabe[], opts)
}
