// Mainz: civento-Formular auf antrag-kommunal.service.rlp.de (Erkundung 10/2026:
// /root/owia/work/mainz/BERICHT.md). Flache Auswahl: Art (Halten/Parken/länger
// als eine Stunde) × 11 Rubriken, alle Details in EINEN Freitext (≤ 1000 Zeichen).
// Was keiner Rubrik entspricht, geht über „Sonstige Ordnungswidrigkeit" (dann ist
// der Freitext Pflicht – wir schreiben ihn ohnehin immer). Telefonnummer Pflicht,
// Tatort in PLZ/Ort/Straße + Hausnummer, höchstens 3 Fotos.

import mysql from 'mysql2/promise'
import { portalAnrede } from '../config/person'
import { fahrzeugTyp, portalMarke } from '../config/fahrzeug'
import { verstossText, portalTatzeit, ddmmyyyy, PortalDatenFehler } from './portalFfm'

const RUBRIK = {
  sperr: 'Das Fahrzeug stand auf einer Sperrfläche',
  geh: 'Das Fahrzeug stand auf dem Gehweg',
  halt: 'Das Fahrzeug stand im Haltverbot',
  feuer: 'Das Fahrzeug stand in oder vor einer Feuerwehrzufahrt',
  sb: 'Das Fahrzeug stand auf einem Schwerbehindertenparkplatz',
  elektro: 'Das Fahrzeug stand auf einem Parkplatz für E-Fahrzeuge',
  kreuzung: 'Das Fahrzeug stand im 5-Meter Kreuzungsbereich',
  rad: 'Das Fahrzeug stand auf einem Radweg/Schutzstreifen',
  fuzo: 'Das Fahrzeug stand in der Fußgängerzone/Fußgängerbereich',
  sonst: 'Sonstige Ordnungswidrigkeit',
}

/** Rubrik aus Katalogtext + Variante. „vor meiner Grundstücksein- bzw. Ausfahrt"
 *  gilt nur für die eigene Zufahrt – fremde Zufahrten gehen über „Sonstige". */
function rubrikFuer(text: string, variante: string | null): string {
  if (/Sperrfläche \(Zeichen 298\)/.test(text)) return RUBRIK.sperr
  if (/Zeichen 239\/240\/241\/242\.1/.test(text)) {
    if (/242/.test(variante || '')) return RUBRIK.fuzo
    if (/239/.test(variante || '')) return RUBRIK.geh
    return RUBRIK.rad
  }
  if (/Fußgängerzone/.test(text)) return RUBRIK.fuzo
  if (/auf dem Gehweg|Gehwegparken \(Zeichen 315\)/.test(text)) return RUBRIK.geh
  if (/Feuerwehr/.test(text)) return RUBRIK.feuer
  if (/Schwerbehinderte/.test(text)) return RUBRIK.sb
  if (/elektrisch betriebene Fahrzeuge/.test(text)) return RUBRIK.elektro
  if (/Meter (vor|hinter) der Kreuzung\/Einmündung/.test(text)) return RUBRIK.kreuzung
  if (/Radweg|Schutzstreifen|Geh- und Radweg/.test(text)) return RUBRIK.rad
  if (/Haltverbot|Grenzmarkierung \(Zeichen 299\) für ein Haltverbot/.test(text)) return RUBRIK.halt
  return RUBRIK.sonst
}

function artFuer(text: string): string {
  if (/länger als 1 Stunde/.test(text)) return 'Parken länger als eine Stunde'
  if (/^Sie hielten\b/.test(text) && !/parkten/.test(text)) return 'Halten'
  return 'Parken'
}

// Mainzer Listen weichen von Frankfurt ab (Typen, Markenschreibweisen).
const MZ_TYP: Record<string, string | null> = {
  Elektrokleinstfahrzeug: 'Elektrokleinstrad',
  'Kraftrad mit Anhänger': 'Kraftrad',
  Leichtkraftrad: 'Kraftrad',
  'Kraftomnibus mit Anhänger': 'Kraftomnibus',
  'Kraftomnibus mit Fahrgästen': 'Kraftomnibus',
  Sattelzugmaschine: 'LKW',
}
const MZ_MARKE: Record<string, string> = { Skoda: 'Škoda', Seat: 'SEAT' }

/** Tatort „Straße Nr, PLZ Ort" zerlegen. */
export function tatortTeile(tatort: string): { strasse: string; hausnummer: string | null; plz: string; ort: string } | null {
  const m = /^(.*?),\s*(\d{5})\s+([^,]+)$/.exec(String(tatort || '').trim())
  if (!m) return null
  const sm = /^(.*\S)\s+(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d+\s?[a-zA-Z]?)?)$/.exec(m[1].trim())
  return { strasse: sm ? sm[1] : m[1].trim(), hausnummer: sm ? sm[2].replace(/\s+/g, '') : null, plz: m[2], ort: m[3].trim() }
}

export function mzProblem(r: Record<string, any>, u?: Record<string, any> | null): string | null {
  if (u && !String(u.telefon || '').trim()) return 'Mainz verlangt eine Telefonnummer – bitte im Profil ergänzen.'
  if (!tatortTeile(r.tatort)) return 'Der Tatort braucht Straße, Postleitzahl und Ort (Adresse aus der Vorschlagsliste wählen).'
  return null
}

export function buildMzPayload(r: mysql.RowDataPacket, u: mysql.RowDataPacket, letztesFoto?: string | null) {
  const teile = tatortTeile(r.tatort)
  if (!teile) throw new PortalDatenFehler('Der Tatort lässt sich nicht in Straße/PLZ/Ort zerlegen.')
  if (!u.hausnummer) throw new PortalDatenFehler('Im Profil fehlt die Hausnummer.')
  if (!String(u.telefon || '').trim()) throw new PortalDatenFehler('Mainz verlangt eine Telefonnummer im Profil.')
  const text = verstossText(r.verstoss_art || '')
  const zeit = portalTatzeit(r, letztesFoto)
  const behindert = r.behinderung === 1 || /behinderten|behindert wurden/.test(text)
  const freitext = [
    `${String(r.verstoss_art || '').trim()}${r.verstoss_variante ? ` (genauer: ${r.verstoss_variante})` : ''}`,
    behindert ? `Behinderung: ${String(r.behinderung_text || '').trim() || 'Andere Verkehrsteilnehmer wurden behindert (siehe Fotos).'}` : '',
    r.fahrzeug_verlassen === 1 ? 'Das Fahrzeug war verlassen.' : '',
    zeit.zusatz ? `${zeit.zusatz}.` : '',
    String(r.beschreibung || '').replace(/\s+/g, ' ').trim(),
  ].filter(Boolean).join(' ').replace(/\.\./g, '.')
  const typ = r.fahrzeug_typ ? fahrzeugTyp(r.fahrzeug_typ) : 'PKW'
  const marke = portalMarke(r.fahrzeug_marke)
  return {
    portal: 'civento-mz',
    person: {
      anrede: u.anrede ? portalAnrede(u.anrede) : '',
      name: u.nachname || '', vorname: u.vorname || '', plz: u.plz || '', ort: u.ort || '',
      strasse: u.strasse || '', nr: u.hausnummer || '', telefon: String(u.telefon || '').trim(), email: u.email || '',
    },
    mz: { art: artFuer(text), rubrik: rubrikFuer(text, r.verstoss_variante ?? null), freitext: freitext.slice(0, 1000) },
    tat: {
      tattag: ddmmyyyy(r.tattag), von: zeit.von, bis: zeit.bis,
      plz: teile.plz, ortName: teile.ort, strasse: teile.strasse, hausnummer: teile.hausnummer,
      beschreibung: teile.hausnummer ? '' : teile.strasse,
    },
    fahrzeug: {
      landCode: String(r.kennzeichen_land || 'D').toUpperCase(),
      kennzeichen: r.kennzeichen || '',
      typ: typ in MZ_TYP ? MZ_TYP[typ] : typ,
      marke: marke ? MZ_MARKE[marke] ?? marke : r.fahrzeug_marke ? String(r.fahrzeug_marke) : null,
      farbe: String(r.fahrzeug_farbe || '').trim(),
    },
  }
}

/** Höchstens 3 Fotos: Fahrzeugfoto zuerst, dann Übersicht, dann der Rest. */
export function mzFotos<T>(rollen: { uebersicht: T[]; fahrzeug: T[] }): T[] {
  const out: T[] = []
  for (const i of [rollen.fahrzeug[0], rollen.uebersicht[0], ...rollen.fahrzeug.slice(1), ...rollen.uebersicht.slice(1)]) {
    if (i && !out.includes(i)) out.push(i)
  }
  return out.slice(0, 3)
}
