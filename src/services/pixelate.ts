import path from 'path'
import fs from 'fs/promises'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import exifr from 'exifr'

// Serverseitige Verpixelung für die anonyme Übersichtskarte.
//
// Wichtig fürs Datenschutzkonzept: Das Originalbild verlässt den Server NIE.
// Wir rechnen es auf wenige Pixel herunter und kodieren ein winziges JPEG neu.
// Im Browser wird es per `image-rendering: pixelated` blockig hochskaliert –
// erkennbar bleibt grob die Szene, nicht aber Kennzeichen oder Gesichter.

// Längste Kante des heruntergerechneten Bildes. Klein genug, dass Details wie
// Kennzeichen unkenntlich sind, groß genug, dass man Auto/Umfeld grob erahnt.
const PIXEL_MAX = 32

type Raw = { data: Uint8Array | Buffer; width: number; height: number }

function decode(buffer: Buffer, mimetype: string): Raw {
  if (mimetype === 'image/png') {
    const png = PNG.sync.read(buffer)
    return { data: png.data, width: png.width, height: png.height }
  }
  // jpeg-js liefert RGBA (4 Bytes/Pixel) als TypedArray. Das Limit muss für
  // aktuelle Handy-Fotos reichen (48 MP RGBA ≈ 200 MB + Decoder-Overhead);
  // sonst wirft decode() und der Aufrufer liefert das Vollbild aus – genau das
  // machte die Übersichten unbrauchbar langsam.
  const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 1024 })
  return { data: img.data, width: img.width, height: img.height }
}

/**
 * Box-Downsampling auf RGBA. Mittelt je Zielpixel den zugehörigen Quellblock,
 * was eine sauberere Verpixelung gibt als reines Nearest-Neighbor.
 */
function downsample(src: Raw, outW: number, outH: number): Buffer {
  const { data, width: sw, height: sh } = src
  const out = Buffer.alloc(outW * outH * 4)
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = Math.floor((oy * sh) / outH)
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * sh) / outH))
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = Math.floor((ox * sw) / outW)
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * sw) / outW))
      let r = 0, g = 0, b = 0, n = 0
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * sw + x) * 4
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          n++
        }
      }
      const o = (oy * outW + ox) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = 255
    }
  }
  return out
}

/**
 * EXIF-Orientation (1-8) aufs (bereits verkleinerte) RGBA-Bild anwenden.
 * jpeg-js liefert die Pixel in Speicher-Orientierung; Handys drehen Hochkant-
 * Fotos nur per EXIF-Tag. Ohne diesen Schritt wären Vorschaubilder 90°/180°
 * gedreht (der Browser wendet EXIF nur auf Originaldateien an, unsere
 * neu kodierten JPEGs haben kein EXIF mehr). Spiegelungen (2,4,5,7) werden
 * auf die reine Drehung reduziert – für Vorschaubilder unerheblich.
 */
function applyOrientation(src: Raw, orientation: number): Raw {
  if (!orientation || orientation < 3 || orientation > 8) return src
  const { data, width: w, height: h } = src
  const rot90 = orientation >= 5
  const ow = rot90 ? h : w
  const oh = rot90 ? w : h
  const out = Buffer.alloc(ow * oh * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number
      let ny: number
      if (orientation === 3 || orientation === 4) {
        nx = w - 1 - x
        ny = h - 1 - y // 180°
      } else if (orientation === 5 || orientation === 6) {
        nx = h - 1 - y
        ny = x // 90° im Uhrzeigersinn
      } else {
        nx = y
        ny = w - 1 - x // 90° gegen den Uhrzeigersinn
      }
      const si = (y * w + x) * 4
      const di = (ny * ow + nx) * 4
      out[di] = data[si]
      out[di + 1] = data[si + 1]
      out[di + 2] = data[si + 2]
      out[di + 3] = data[si + 3]
    }
  }
  return { data: out, width: ow, height: oh }
}

/** EXIF-Orientation eines Bildes lesen; 1 (normal) bei Fehlern/PNG. */
export async function readOrientation(buffer: Buffer): Promise<number> {
  try {
    return (await exifr.orientation(buffer)) || 1
  } catch {
    return 1
  }
}

/**
 * Liefert ein stark verpixeltes JPEG (winzige Auflösung) des Eingabebildes.
 * Wirft, wenn das Bild nicht dekodiert werden kann.
 */
export function pixelate(buffer: Buffer, mimetype: string, orientation = 1): Buffer {
  const src = decode(buffer, mimetype)
  const scale = Math.min(1, PIXEL_MAX / Math.max(src.width, src.height))
  const outW = Math.max(1, Math.round(src.width * scale))
  const outH = Math.max(1, Math.round(src.height * scale))
  const oriented = applyOrientation({ data: downsample(src, outW, outH), width: outW, height: outH }, orientation)
  const encoded = jpeg.encode({ data: oriented.data, width: oriented.width, height: oriented.height }, 70)
  return Buffer.from(encoded.data)
}

// Längste Kante des Vorschaubilds für Karten-Marker (2x für scharfe Retina-Darstellung
// bei ~48 px Marker). Ergebnis ist ein winziges JPEG (wenige KB) statt des Vollbilds.
const THUMB_MAX = 96

/**
 * Liefert ein kleines, klares JPEG-Vorschaubild (nicht verpixelt) fürs Karten-Marker.
 * Wirft, wenn das Bild nicht dekodiert werden kann.
 */
export function thumbnail(buffer: Buffer, mimetype: string, maxEdge = THUMB_MAX, orientation = 1): Buffer {
  const src = decode(buffer, mimetype)
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height))
  const outW = Math.max(1, Math.round(src.width * scale))
  const outH = Math.max(1, Math.round(src.height * scale))
  const oriented = applyOrientation({ data: downsample(src, outW, outH), width: outW, height: outH }, orientation)
  const encoded = jpeg.encode({ data: oriented.data, width: oriented.width, height: oriented.height }, 72)
  return Buffer.from(encoded.data)
}

/** Dateiname des gecachten Vorschaubilds neben dem Bild ("bild-x.jpg.thumb.jpg"). */
export function thumbFilename(filename: string): string {
  return `${filename}.thumb.jpg`
}

/**
 * Verpixeltes Bild (öffentliche Karte) mit Datei-Cache: einmal berechnet,
 * danach direkt von Platte. Wirft, wenn das Bild nicht dekodierbar ist.
 */
export async function cachedPixelate(
  dir: string,
  filename: string,
  mimetype: string
): Promise<Buffer> {
  const cachePath = path.join(dir, `${filename}.pixel.jpg`)
  try {
    return await fs.readFile(cachePath)
  } catch {
    /* noch nicht gecacht */
  }
  const original = await fs.readFile(path.join(dir, filename))
  const out = pixelate(original, mimetype || 'image/jpeg', await readOrientation(original))
  fs.writeFile(cachePath, out).catch(() => {})
  return out
}

/**
 * Vorschaubild direkt beim Upload vorberechnen und neben das Bild schreiben.
 * Wichtig für die Übersichtsseiten: thumbnail() dekodiert das Vollbild synchron
 * (jpeg-js, blockiert den Event-Loop) – das soll einmal beim Upload passieren,
 * nicht beim ersten Seitenaufruf für dutzende Bilder gleichzeitig. Best-effort:
 * Fehler (z.B. nicht dekodierbar) werden geschluckt, dann greift der
 * On-demand-Fallback in cachedThumbnail().
 */
export async function writeThumbnailCache(
  dir: string,
  filename: string,
  buffer: Buffer,
  mimetype: string
): Promise<void> {
  try {
    const orientation = await readOrientation(buffer)
    const out = thumbnail(buffer, mimetype || 'image/jpeg', undefined, orientation)
    await fs.writeFile(path.join(dir, thumbFilename(filename)), out)
  } catch {
    /* nicht dekodierbar oder Schreibfehler – Fallback rechnet on demand */
  }
}

/**
 * Vorschaubild mit Datei-Cache: einmal berechnet, danach direkt von Platte.
 * Fällt aufs Originalbild zurück, wenn es nicht dekodierbar ist (dann ohne Cache).
 */
export async function cachedThumbnail(
  dir: string,
  filename: string,
  mimetype: string
): Promise<{ buffer: Buffer; type: string }> {
  const thumbPath = path.join(dir, thumbFilename(filename))
  try {
    return { buffer: await fs.readFile(thumbPath), type: 'image/jpeg' }
  } catch {
    /* noch nicht gecacht */
  }

  const original = await fs.readFile(path.join(dir, filename))
  try {
    const out = thumbnail(original, mimetype || 'image/jpeg', undefined, await readOrientation(original))
    // Cache best-effort – ein Schreibfehler darf die Auslieferung nicht stoppen.
    fs.writeFile(thumbPath, out).catch(() => {})
    return { buffer: out, type: 'image/jpeg' }
  } catch {
    // Nicht dekodierbar -> Originalbild ausliefern (Vorschau bleibt sichtbar).
    return { buffer: original, type: mimetype || 'application/octet-stream' }
  }
}
