import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

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
  // jpeg-js liefert RGBA (4 Bytes/Pixel) als TypedArray.
  const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 256 })
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
 * Liefert ein stark verpixeltes JPEG (winzige Auflösung) des Eingabebildes.
 * Wirft, wenn das Bild nicht dekodiert werden kann.
 */
export function pixelate(buffer: Buffer, mimetype: string): Buffer {
  const src = decode(buffer, mimetype)
  const scale = Math.min(1, PIXEL_MAX / Math.max(src.width, src.height))
  const outW = Math.max(1, Math.round(src.width * scale))
  const outH = Math.max(1, Math.round(src.height * scale))
  const rgba = downsample(src, outW, outH)
  const encoded = jpeg.encode({ data: rgba, width: outW, height: outH }, 70)
  return Buffer.from(encoded.data)
}
