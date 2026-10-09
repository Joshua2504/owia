// Karten-Kacheln für den /tiles-Proxy (routes/tiles.ts) und die PDF-Karte
// (services/staticmap.ts). Quelle ist seit 10/2026 basemap.de (BKG, ganz
// Deutschland, frei nutzbar unter „Datenlizenz Deutschland – Namensnennung
// 2.0“, Hinweis „© basemap.de / BKG“ an der Karte). Der Browser spricht nie
// direkt mit basemap.de: Nutzer-IPs gehen an keinen Dritten und die CSP
// bleibt same-origin.
//
// Fallback ist der alte OSM-Tileserver im Docker-Netz (TILESERVER_URL), solange
// der Container noch läuft – er kennt nur Hessen, Mainz und Hamburg.

const BASEMAP_URL =
  'https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR'
const TILESERVER_URL = (process.env.TILESERVER_URL || 'http://tileserver:80').replace(/\/$/, '')

/** Höchste Zoomstufe, die basemap.de liefert (Leaflet skaliert darüber hoch). */
export const MAX_TILE_ZOOM = 19

// Kleiner LRU-Cache im Speicher: Kacheln sind 5–80 KB, 1500 Stück ≈ 50 MB.
// Häufig gesehene Ausschnitte (Startseite, Innenstädte) kommen so ohne
// Upstream-Request; der Browser cacht zusätzlich einen Tag.
const CACHE_MAX = 1500
const CACHE_TTL_MS = 3 * 24 * 3600 * 1000 // basemap.de selbst: max-age 3 Tage
const cache = new Map<string, { buf: Buffer; at: number }>()
const inflight = new Map<string, Promise<Buffer | null>>()

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

async function load(z: number, x: number, y: number, timeoutMs: number): Promise<Buffer | null> {
  // basemap.de (WMTS-REST): Reihenfolge {z}/{y}/{x}, nicht {z}/{x}/{y}.
  const buf = await fetchPng(`${BASEMAP_URL}/${z}/${y}/${x}.png`, timeoutMs)
  if (buf) return buf
  return fetchPng(`${TILESERVER_URL}/tile/${z}/${x}/${y}.png`, Math.min(timeoutMs, 3000))
}

/**
 * PNG-Kachel (Web-Mercator, 256 px) holen oder null, wenn weder basemap.de
 * noch der Fallback sie liefern. Aufrufer prüfen die Koordinaten vorher.
 */
export async function getTile(z: number, x: number, y: number, timeoutMs = 5000): Promise<Buffer | null> {
  const key = `${z}/${x}/${y}`
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
  }
  return buf
}
