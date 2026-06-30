import fs from 'fs/promises'
import path from 'path'
import { PNG } from 'pngjs'

// Statisches Karten-PNG für die Anzeige-PDF: Wir setzen die nötigen OSM-Kacheln
// vom internen Tileserver zu einem Bild zusammen und zeichnen den Tatort-Marker
// darüber. Reines pngjs (keine native Abhängigkeit). Die Kacheln kommen vom
// selben Tileserver wie der /tiles-Proxy (TILESERVER_URL).

const TILE = 256
const TILESERVER_URL = (process.env.TILESERVER_URL || 'http://tileserver:80').replace(/\/$/, '')

// Default-Ausschnitt: Zoom mit Straßendetail, Querformat mit etwas Umfeld.
const ZOOM = 16
const WIDTH = 640
const HEIGHT = 440

// Leaflet-Standardmarker (lokal vendored). Spitze unten-mittig => Anchor (12,41).
const MARKER_PATH = path.join(process.cwd(), 'public', 'vendor', 'leaflet', 'images', 'marker-icon.png')
const MARKER_ANCHOR_X = 12
const MARKER_ANCHOR_Y = 41

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z)
}

function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
}

async function fetchTile(z: number, x: number, y: number): Promise<PNG | null> {
  const max = Math.pow(2, z)
  if (x < 0 || y < 0 || x >= max || y >= max) return null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(`${TILESERVER_URL}/tile/${z}/${x}/${y}.png`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return null
    return PNG.sync.read(Buffer.from(await res.arrayBuffer()))
  } catch {
    return null
  }
}

/** Opakes Kachelbild an Pixelposition (destX,destY) in den Ausgabepuffer kopieren. */
function blitTile(out: PNG, tile: PNG, destX: number, destY: number): void {
  for (let py = 0; py < tile.height; py++) {
    const oy = destY + py
    if (oy < 0 || oy >= out.height) continue
    for (let px = 0; px < tile.width; px++) {
      const ox = destX + px
      if (ox < 0 || ox >= out.width) continue
      const si = (py * tile.width + px) * 4
      const di = (oy * out.width + ox) * 4
      out.data[di] = tile.data[si]
      out.data[di + 1] = tile.data[si + 1]
      out.data[di + 2] = tile.data[si + 2]
      out.data[di + 3] = 255
    }
  }
}

/** Marker mit Alpha über den Ausgabepuffer blenden (Position = obere linke Ecke). */
function blendMarker(out: PNG, marker: PNG, destX: number, destY: number): void {
  for (let py = 0; py < marker.height; py++) {
    const oy = destY + py
    if (oy < 0 || oy >= out.height) continue
    for (let px = 0; px < marker.width; px++) {
      const ox = destX + px
      if (ox < 0 || ox >= out.width) continue
      const si = (py * marker.width + px) * 4
      const a = marker.data[si + 3] / 255
      if (a === 0) continue
      const di = (oy * out.width + ox) * 4
      out.data[di] = Math.round(marker.data[si] * a + out.data[di] * (1 - a))
      out.data[di + 1] = Math.round(marker.data[si + 1] * a + out.data[di + 1] * (1 - a))
      out.data[di + 2] = Math.round(marker.data[si + 2] * a + out.data[di + 2] * (1 - a))
    }
  }
}

/** Einfacher roter Pin als Fallback, falls das Marker-Bild fehlt. */
function drawFallbackPin(out: PNG, cx: number, cy: number): void {
  const radius = 7
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue
      const ox = cx + dx
      const oy = cy + dy
      if (ox < 0 || ox >= out.width || oy < 0 || oy >= out.height) continue
      const di = (oy * out.width + ox) * 4
      out.data[di] = 220
      out.data[di + 1] = 40
      out.data[di + 2] = 40
      out.data[di + 3] = 255
    }
  }
}

/**
 * Erzeugt ein PNG (WIDTH×HEIGHT) mit dem Tatort-Marker in der Mitte.
 * Gibt null zurück, wenn keine einzige Kachel geladen werden konnte
 * (Tileserver nicht erreichbar / Import noch nicht fertig).
 */
export async function renderTatortMap(lat: number, lon: number): Promise<Buffer | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const gx = lonToTileX(lon, ZOOM) * TILE
  const gy = latToTileY(lat, ZOOM) * TILE
  const originX = Math.round(gx - WIDTH / 2)
  const originY = Math.round(gy - HEIGHT / 2)

  const txMin = Math.floor(originX / TILE)
  const txMax = Math.floor((originX + WIDTH - 1) / TILE)
  const tyMin = Math.floor(originY / TILE)
  const tyMax = Math.floor((originY + HEIGHT - 1) / TILE)

  const out = new PNG({ width: WIDTH, height: HEIGHT })
  // Hellgrauer Hintergrund für evtl. fehlende Kacheln.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = out.data[i + 1] = out.data[i + 2] = 235
    out.data[i + 3] = 255
  }

  const jobs: Promise<{ tx: number; ty: number; tile: PNG | null }>[] = []
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      jobs.push(fetchTile(ZOOM, tx, ty).then((tile) => ({ tx, ty, tile })))
    }
  }
  const tiles = await Promise.all(jobs)

  let loaded = 0
  for (const { tx, ty, tile } of tiles) {
    if (!tile) continue
    loaded++
    blitTile(out, tile, tx * TILE - originX, ty * TILE - originY)
  }
  if (loaded === 0) return null

  // Marker mittig platzieren (Spitze auf den Tatort).
  const cx = Math.round(WIDTH / 2)
  const cy = Math.round(HEIGHT / 2)
  try {
    const marker = PNG.sync.read(await fs.readFile(MARKER_PATH))
    blendMarker(out, marker, cx - MARKER_ANCHOR_X, cy - MARKER_ANCHOR_Y)
  } catch {
    drawFallbackPin(out, cx, cy)
  }

  return PNG.sync.write(out)
}
