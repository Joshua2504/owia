// Quellbilder für `npm run assets` (@capacitor/assets) nach mobile/assets/
// zeichnen – dasselbe Halteverbot-Schild wie die PWA-Icons
// (src/scripts/generate-pwa-icons.ts), nur in Store-Größe. Aufruf aus mobile/:
//   node scripts/generate-icons.mjs && npm run assets
// Ein neues Logo (z. B. aus /logos) einfach als assets/*.png ablegen und nur
// `npm run assets` ausführen.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// pngjs liegt in den Abhängigkeiten der Website (Repo-Wurzel).
const { PNG } = createRequire(join(here, '..', '..', 'package.json'))('pngjs')
const OUT = join(here, '..', 'assets')

const BG = [33, 37, 41] // #212529, wie Navbar und PWA-Icons
const BLUE = [0, 79, 159]
const RED = [179, 0, 0]

// radius: Anteil der Kantenlänge; bg null = transparent (Android-Vordergrund).
function draw(size, radius, bg) {
  const png = new PNG({ width: size, height: size })
  const R = size * radius
  const ring = R * 0.24
  const SS = 3
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - size / 2
          const dy = y + (sy + 0.5) / SS - size / 2
          const dist = Math.hypot(dx, dy)
          let c
          if (dist > R) c = bg
          else c = (dist >= R - ring || Math.abs(dx + dy) / Math.SQRT2 <= ring / 2) ? RED : BLUE
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255 }
        }
      }
      const i = (y * size + x) * 4
      const n = SS * SS
      // Farbe über die deckenden Samples mitteln (keine dunklen Säume bei Transparenz).
      const k = a ? 255 * n / a : 0
      png.data[i] = Math.round(r / n * k)
      png.data[i + 1] = Math.round(g / n * k)
      png.data[i + 2] = Math.round(b / n * k)
      png.data[i + 3] = Math.round(a / n)
    }
  }
  return PNG.sync.write(png)
}

function solid(size, c) {
  const png = new PNG({ width: size, height: size })
  for (let i = 0; i < size * size * 4; i += 4) { png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255 }
  return PNG.sync.write(png)
}

mkdirSync(OUT, { recursive: true })
// iOS/Store-Icon: volle Fläche, keine Transparenz (Apple lehnt Alpha ab).
writeFileSync(join(OUT, 'icon-only.png'), draw(1024, 0.42, BG))
// Android Adaptive Icon: Motiv in der sicheren Zone (66 von 108 dp ⇒ r ≤ 0,30).
writeFileSync(join(OUT, 'icon-foreground.png'), draw(1024, 0.28, null))
writeFileSync(join(OUT, 'icon-background.png'), solid(1024, BG))
// Startbildschirm: kleines Schild mittig, Rest Hintergrund (2732² deckt alle iPads ab).
writeFileSync(join(OUT, 'splash.png'), draw(2732, 0.07, BG))
writeFileSync(join(OUT, 'splash-dark.png'), draw(2732, 0.07, BG))
console.log('assets/ erzeugt')
