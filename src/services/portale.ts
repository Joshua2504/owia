// Registry der Online-Portale je Stadt (City.portal in config/cities.ts). Jeder
// Adapter kennt die Regeln seines Formulars; der Portal-Dienst (docker/portal)
// wählt das passende Profil über payload.portal.
//
//   ekom21-ffm  Frankfurt  – services/portalFfm.ts (Tatbestand-Baum, Varianten Pflicht, 2-Monats-Frist)
//   ekom21-wi   Wiesbaden  – services/portalWi.ts  (eine Ebene, „Sonstiges", 2-Monats-Frist)
//   civento-mz  Mainz      – services/portalMz.ts  (Art × Rubrik + Freitext, Telefon Pflicht)
//   intelliform-hh Hamburg – services/portalHh.ts  (24 Tatvorwürfe + „keiner" mit Sachverhalt, ≤ 3 Fotos)

import mysql from 'mysql2/promise'
import { CITIES, DEFAULT_CITY_ID, getCity } from '../config/cities'
import { buildPortalPayload, imPortal, portalProblem, photoRoles, erstAbMorgen, verstossVarianten } from './portalFfm'
import { buildWiPayload, wiProblem } from './portalWi'
import { buildMzPayload, mzProblem, mzFotos } from './portalMz'
import { buildHhPayload, hhProblem, hhFotos } from './portalHh'

export type PortalId = 'ekom21-ffm' | 'ekom21-wi' | 'civento-mz' | 'intelliform-hh'

export interface PortalAdapter {
  id: PortalId
  /** Anzeige im UI, z.B. „Online-Portal (ekom21)". */
  bezeichnung: string
  /** Lässt sich dieser Verstoß über das Portal anzeigen? */
  versendbar(verstossArt: string | null | undefined): boolean
  /** Was dem Versand noch fehlt (null = passt). `user` optional (Profilprüfungen). */
  problem(report: Record<string, any>, user?: Record<string, any> | null): string | null
  /** Fehlt die Konkretisierung (Kreuzung/Einmündung …), fragt der Lauf live nach. */
  varianteFehlt(report: Record<string, any>): boolean
  /** Nimmt das Portal Taten vom heutigen Tag an? */
  heuteErlaubt: boolean
  payload(report: mysql.RowDataPacket, user: mysql.RowDataPacket, letztesFoto?: string | null): Record<string, unknown>
  /** Fotos auf die Upload-Bereiche verteilen (Mainz: ein Bereich, ≤ 3). */
  fotos<T extends Record<string, any>>(imgs: T[]): { uebersicht: T[]; fahrzeug: T[] }
}

const ffm: PortalAdapter = {
  id: 'ekom21-ffm',
  bezeichnung: 'Online-Portal (ekom21)',
  versendbar: imPortal,
  problem: (r) => portalProblem(r),
  varianteFehlt: (r) => verstossVarianten(r.verstoss_art).length > 0 && !r.verstoss_variante,
  heuteErlaubt: false,
  payload: (r, u, f) => ({ portal: 'ekom21-ffm', ...buildPortalPayload(r, u, f) }),
  fotos: photoRoles,
}

const wi: PortalAdapter = {
  id: 'ekom21-wi',
  bezeichnung: 'Online-Portal (ekom21)',
  // Was keiner Rubrik entspricht, geht über „Sonstiges" mit Beschreibung.
  versendbar: (v) => !!v,
  problem: (r) => wiProblem(r),
  varianteFehlt: () => false,
  heuteErlaubt: true,
  payload: buildWiPayload,
  fotos: photoRoles,
}

const mz: PortalAdapter = {
  id: 'civento-mz',
  bezeichnung: 'Online-Formular (civento, RLP)',
  versendbar: (v) => !!v,
  problem: (r, u) => mzProblem(r, u),
  varianteFehlt: () => false,
  heuteErlaubt: true,
  payload: buildMzPayload,
  fotos: (imgs) => ({ uebersicht: mzFotos(photoRoles(imgs)), fahrzeug: [] }),
}

const hh: PortalAdapter = {
  id: 'intelliform-hh',
  bezeichnung: 'Online-Dienst (Serviceportal Hamburg)',
  // Was keinem der 24 Tatvorwürfe entspricht, geht über „keiner der
  // aufgeführten" mit dem Katalogtext im Sachverhalt.
  versendbar: (v) => !!v,
  problem: (r, u) => hhProblem(r, u),
  varianteFehlt: () => false,
  heuteErlaubt: true,
  payload: buildHhPayload,
  fotos: hhFotos,
}

const ADAPTER: Record<PortalId, PortalAdapter> = { 'ekom21-ffm': ffm, 'ekom21-wi': wi, 'civento-mz': mz, 'intelliform-hh': hh }

/** Adapter der Stadt (null = Versand per Mail). */
export function portalFuer(cityId: string | null | undefined): PortalAdapter | null {
  const id = getCity(cityId).portal
  return id ? ADAPTER[id] : null
}

/** Taten von heute erst ab morgen (nur Portale ohne heuteErlaubt). */
export function erstMorgen(adapter: PortalAdapter, report: Record<string, any>): boolean {
  return !adapter.heuteErlaubt && erstAbMorgen(report)
}

/** Darf dieser Verstoß für die Stadt nicht gewählt werden (Portal kennt ihn nicht)? */
export function verstossGesperrt(cityId: string | null | undefined, verstossArt: string | null | undefined): boolean {
  const adapter = portalFuer(cityId)
  return !!adapter && !!verstossArt && !adapter.versendbar(verstossArt)
}

/** Für die Verstoß-Auswahl (public/js/verstoss-select.js): je Stadt mit Portal
 *  die Indizes der Katalogeinträge, die dort nicht wählbar sind. Indizes statt
 *  Texte, damit die eingebettete Liste klein bleibt. */
export function verstossSperren(labels: string[]): { gesperrt: Record<string, { name: string; idx: number[] }>; standardStadt: string } {
  const gesperrt: Record<string, { name: string; idx: number[] }> = {}
  for (const c of Object.values(CITIES)) {
    const idx = labels.flatMap((l, i) => (verstossGesperrt(c.id, l) ? [i] : []))
    if (idx.length) gesperrt[c.id] = { name: c.name, idx }
  }
  return { gesperrt, standardStadt: DEFAULT_CITY_ID }
}
