// Karten-Kacheln für den /tiles-Proxy (routes/tiles.ts) und die PDF-Karte
// (services/staticmap.ts). Quelle ist seit 10/2026 basemap.de (BKG, ganz
// Deutschland, frei nutzbar unter „Datenlizenz Deutschland – Namensnennung
// 2.0“, Hinweis „© basemap.de / BKG“ an der Karte). Der Browser spricht nie
// direkt mit basemap.de: Nutzer-IPs gehen an keinen Dritten und die CSP
// bleibt same-origin. Der frühere eigene OSM-Tileserver ist seit 10/2026 weg.

const BASEMAP_URL =
  'https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR'

/** Höchste Zoomstufe, die basemap.de liefert (Leaflet skaliert darüber hoch). */
export const MAX_TILE_ZOOM = 19

// Kleiner LRU-Cache im Speicher: Kacheln sind 5–80 KB, 1500 Stück ≈ 50 MB.
// Häufig gesehene Ausschnitte (Startseite, Innenstädte) kommen so ohne
// Upstream-Request; der Browser cacht zusätzlich einen Tag.
const CACHE_MAX = 1500
const CACHE_TTL_MS = 3 * 24 * 3600 * 1000 // basemap.de selbst: max-age 3 Tage
const cache = new Map<string, { buf: Buffer; at: number }>()
const inflight = new Map<string, Promise<Buffer | null>>()

// Negativ-Cache: Upstream-Fehler (basemap.de down/langsam, Kachel gibt es nicht)
// kurz merken, damit eine ausgefallene Quelle nicht von jedem Kartenaufruf mit
// 5 s Timeout neu angefragt wird. Nur für den /tiles-Proxy (negativ = true);
// die PDF-Karte (staticmap.ts) soll bei einem Wiederholungsversuch sofort neu laden.
const FAIL_TTL_MS = 60 * 1000
const FAIL_MAX = 2000
const failed = new Map<string, number>()

/** Großzügige Bounding-Box um Deutschland (inkl. Randgebiete der Nachbarländer). */
const DE_LAT_MIN = 47.0
const DE_LAT_MAX = 55.2
const DE_LON_MIN = 5.5
const DE_LON_MAX = 15.5
/** Bis hierhin (Weltkarte/Kontinent) sind alle Kacheln erlaubt – es sind nur wenige. */
const BOX_AB_ZOOM = 6

function lonZuX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}
function latZuY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

/**
 * Liegt die Kachel (teilweise) in der Deutschland-Box? Der Proxy ist ohne Auth
 * erreichbar; ohne Begrenzung ließe sich über ihn die ganze Welt bei Zoom 19
 * von basemap.de abgrasen (Missbrauch auf unsere Kosten/Reputation). Niedrige
 * Zoomstufen bleiben frei (Leaflet lädt beim Start/Herauszoomen die Weltkacheln).
 */
export function tileInDeutschland(z: number, x: number, y: number): boolean {
  if (z < BOX_AB_ZOOM) return true
  return x >= lonZuX(DE_LON_MIN, z) && x <= lonZuX(DE_LON_MAX, z) &&
    y >= latZuY(DE_LAT_MAX, z) && y <= latZuY(DE_LAT_MIN, z)
}

async function fetchPng(url: string, timeoutMs: number): Promise<Buffer | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'owia.net Kartenproxy (https://owia.net)' },
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function load(z: number, x: number, y: number, timeoutMs: number): Promise<Buffer | null> {
  // basemap.de (WMTS-REST): Reihenfolge {z}/{y}/{x}, nicht {z}/{x}/{y}.
  return fetchPng(`${BASEMAP_URL}/${z}/${y}/${x}.png`, timeoutMs)
}

/**
 * PNG-Kachel (Web-Mercator, 256 px) holen oder null, wenn basemap.de sie
 * nicht liefert. Aufrufer prüfen die Koordinaten vorher.
 */
export async function getTile(
  z: number, x: number, y: number, timeoutMs = 5000, negativ = false,
): Promise<Buffer | null> {
  const key = `${z}/${x}/${y}`
  if (negativ) {
    const bis = failed.get(key)
    if (bis !== undefined) {
      if (bis > Date.now()) return null
      failed.delete(key)
    }
  }
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // Als zuletzt benutzt ans Ende der Map rücken (LRU).
    cache.delete(key)
    cache.set(key, hit)
    return hit.buf
  }

  let pending = inflight.get(key)
  if (!pending) {
    pending = load(z, x, y, timeoutMs).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  const buf = await pending
  if (buf) {
    cache.delete(key)
    cache.set(key, { buf, at: Date.now() })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  } else if (negativ) {
    failed.delete(key)
    failed.set(key, Date.now() + FAIL_TTL_MS)
    if (failed.size > FAIL_MAX) failed.delete(failed.keys().next().value as string)
  }
  return buf
}
