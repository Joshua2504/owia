// Einmal-Script: PWA-Icons nach public/icons/ generieren (npx tsx src/scripts/generate-pwa-icons.ts).
// Rein geometrisches Motiv (Halteverbot-Schild: blaue Scheibe, roter Ring,
// rote Diagonale) mit pngjs gezeichnet – auf dem Server gibt es weder
// ImageMagick noch eine Font-Rendering-Bibliothek.
import path from 'path'
import fs from 'fs'
import { PNG } from 'pngjs'

const OUT_DIR = path.join(process.cwd(), 'public', 'icons')

const BG: [number, number, number] = [33, 37, 41] // Bootstrap bg-dark (#212529), wie die Navbar
const BLUE: [number, number, number] = [0, 79, 159] // Verkehrsblau
const RED: [number, number, number] = [179, 0, 0] // Verkehrsrot

/** Farbe eines Sub-Pixels (Schildgeometrie über Abstandsfunktionen). */
function colorAt(x: number, y: number, size: number, maskable: boolean): [number, number, number] {
  const cx = size / 2
  const cy = size / 2
  // Maskable: Motiv in die sichere Zone (innere 80 %) verkleinern, der Rest
  // ist Hintergrund und darf von der Plattform-Maske beschnitten werden.
  const R = size * (maskable ? 0.32 : 0.42)
  const ring = R * 0.24
  const dx = x - cx
  const dy = y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist > R) return BG
  // Diagonale (45°, von oben links nach unten rechts) über der Scheibe.
  const diag = Math.abs(dx + dy) / Math.SQRT2
  if (dist >= R - ring || diag <= ring / 2) return RED
  return BLUE
}

function render(size: number, maskable: boolean): PNG {
  const png = new PNG({ width: size, height: size })
  const SS = 3 // 3×3-Supersampling gegen Treppchen an Ring und Diagonale
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size, maskable)
          r += c[0]
          g += c[1]
          b += c[2]
        }
      }
      const idx = (y * size + x) * 4
      png.data[idx] = Math.round(r / (SS * SS))
      png.data[idx + 1] = Math.round(g / (SS * SS))
      png.data[idx + 2] = Math.round(b / (SS * SS))
      png.data[idx + 3] = 255
    }
  }
  return png
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const targets: [string, number, boolean][] = [
  ['icon-180.png', 180, false], // apple-touch-icon (iOS rundet selbst ab)
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
]
for (const [name, size, maskable] of targets) {
  const file = path.join(OUT_DIR, name)
  fs.writeFileSync(file, PNG.sync.write(render(size, maskable)))
  console.log('geschrieben:', file)
}
