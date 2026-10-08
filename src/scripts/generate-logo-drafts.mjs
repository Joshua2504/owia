// Erzeugt public/logos/NN-slug.svg (+ -dunkel.svg) für die Seite /logos (routes/logos.ts).
// Aufruf: node src/scripts/generate-logo-drafts.mjs public/logos
import { writeFileSync, mkdirSync } from 'node:fs'

const OUT = process.argv[2]
mkdirSync(OUT, { recursive: true })

const RED = '#D52B1E', BLUE = '#1356A8', INK = '#1C2430', YEL = '#F2C200'
// FIX bleibt auch in der dunklen Variante dunkel (Flächen, auf denen Weiß/Gelb steht).
const FIX = '#1B2330'
const GREEN = '#1E9E5A', GREY = '#9AA4B2', LIGHT = '#E9ECEF'
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

const PIN = 'M60 6C36.8 6 18 24.8 18 48c0 30 42 66 42 66s42-36 42-66C102 24.8 83.2 6 60 6z'

// Seitenansicht Auto (x 22–102, y 39–83), Räder bei (38,74) und (86,74).
const carSide = (body, win, wheel, rim) => `
  <path d="M22 74V62q0-6 6-7l12-2 10-11q3-3 8-3h18q5 0 8 4l8 10 6 2q4 1 4 6v13z" fill="${body}"/>
  <path d="M53 53l6-9h9v9zM72 53v-9h6q2 0 3 2l5 7z" fill="${win}"/>
  <circle cx="38" cy="74" r="9" fill="${wheel}" stroke="${rim}" stroke-width="3"/>
  <circle cx="86" cy="74" r="9" fill="${wheel}" stroke="${rim}" stroke-width="3"/>`

// Frontansicht Auto (x 30–90, y 37–86), Mitte (60,61).
const carFront = (body, glass, lights, wheel) => `
  <rect x="32" y="78" width="10" height="8" rx="2" fill="${wheel}"/>
  <rect x="78" y="78" width="10" height="8" rx="2" fill="${wheel}"/>
  <path d="M38 58l6-18q1-3 5-3h22q4 0 5 3l6 18z" fill="${body}"/>
  <rect x="30" y="56" width="60" height="25" rx="7" fill="${body}"/>
  <path d="M44 56l4-13h24l4 13z" fill="${glass}"/>
  <circle cx="41" cy="67" r="4.5" fill="${lights}"/>
  <circle cx="79" cy="67" r="4.5" fill="${lights}"/>
  <rect x="51" y="70" width="18" height="4" rx="2" fill="${glass}"/>`

const halteverbot = (cx, cy, r, ring, x = true) => {
  const o = (r - ring / 2) * 0.68
  const lines = x
    ? `<path d="M${cx - o} ${cy - o}L${cx + o} ${cy + o}M${cx + o} ${cy - o}L${cx - o} ${cy + o}" stroke="${RED}" stroke-width="${ring * 0.85}" stroke-linecap="butt"/>`
    : `<path d="M${cx - o} ${cy - o}L${cx + o} ${cy + o}" stroke="${RED}" stroke-width="${ring * 0.9}"/>`
  return `<circle cx="${cx}" cy="${cy}" r="${r - ring / 2}" fill="${BLUE}" stroke="${RED}" stroke-width="${ring}"/>${lines}`
}

const L = []
const add = (slug, svg) => L.push({ slug, svg })

// 1 Halteverbot im Standort-Pin
add('halteverbot-pin', `
  <path d="${PIN}" fill="${RED}"/>
  <circle cx="60" cy="48" r="30" fill="#fff"/>
  ${halteverbot(60, 48, 25, 6)}`)

// 2 Kennzeichen OW·IA
{
  const stars = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    return `<circle cx="${(15 + 5.6 * Math.cos(a)).toFixed(2)}" cy="${(51 + 5.6 * Math.sin(a)).toFixed(2)}" r="1.1" fill="${YEL}"/>`
  }).join('')
  add('kennzeichen', `
  <clipPath id="p"><rect x="6" y="38" width="108" height="44" rx="6"/></clipPath>
  <rect x="6" y="38" width="108" height="44" rx="6" fill="#fff"/>
  <rect x="6" y="38" width="18" height="44" fill="#003399" clip-path="url(#p)"/>
  ${stars}
  <text x="15" y="75" font-family="${FONT}" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">D</text>
  <text x="45" y="68" font-family="'DIN Alternate', 'Arial Narrow', ${FONT}" font-size="19" font-weight="700" fill="${FIX}" text-anchor="middle">OW</text>
  <circle cx="72" cy="53" r="4.5" fill="${BLUE}" stroke="${FIX}" stroke-width="1"/>
  <circle cx="72" cy="66" r="4.5" fill="${RED}" stroke="${FIX}" stroke-width="1"/>
  <text x="95" y="68" font-family="'DIN Alternate', 'Arial Narrow', ${FONT}" font-size="19" font-weight="700" fill="${FIX}" text-anchor="middle">IA</text>
  <rect x="7.5" y="39.5" width="105" height="41" rx="5" fill="none" stroke="${FIX}" stroke-width="3"/>`)
}

// 3 Kamera mit P-Linse
add('kamera-p', `
  <rect x="38" y="24" width="32" height="16" rx="5" fill="${INK}"/>
  <rect x="10" y="34" width="100" height="68" rx="14" fill="${INK}"/>
  <rect x="88" y="43" width="12" height="7" rx="2" fill="${YEL}"/>
  <circle cx="24" cy="47" r="4" fill="${RED}"/>
  <circle cx="60" cy="68" r="25" fill="#fff"/>
  <circle cx="60" cy="68" r="19" fill="${BLUE}"/>
  <text x="60" y="78.5" font-family="${FONT}" font-size="29" font-weight="800" fill="#fff" text-anchor="middle">P</text>`)

// 4 Sucher-Ecken um ein Auto
add('sucher', `
  <path d="M14 36V16h20M86 16h20v20M106 84v20H86M34 104H14V84" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="92" cy="30" r="5" fill="${RED}"/>
  <g transform="translate(-2 1)">${carSide(BLUE, '#fff', INK, '#fff')}</g>`)

// 5 Monogramm O + A
add('monogramm-oa', `
  <circle cx="60" cy="60" r="45" fill="none" stroke="${BLUE}" stroke-width="14"/>
  <path fill-rule="evenodd" d="M60 30L83 86H71L67 75H53L49 86H37ZM60 55L63.6 65H56.4Z" fill="${RED}"/>`)

// 6 Stempel
add('stempel', `
  <g transform="rotate(-12 60 60)" fill="none" stroke="${RED}">
    <circle cx="60" cy="60" r="53" stroke-width="4"/>
    <circle cx="60" cy="60" r="36" stroke-width="2"/>
    <path id="r" d="M60 60m-44.5 0a44.5 44.5 0 1 1 89 0a44.5 44.5 0 1 1-89 0" stroke="none"/>
    <text font-family="${FONT}" font-size="9.5" font-weight="800" fill="${RED}" stroke="none" letter-spacing="1"><textPath href="#r" textLength="272" lengthAdjust="spacing">ORDNUNGSWIDRIGKEIT • ANZEIGE • OWIA •</textPath></text>
    <text x="60" y="68" font-family="${FONT}" font-size="22" font-weight="900" fill="${RED}" stroke="none" text-anchor="middle">OWiA</text>
    <path d="M36 78h48M36 44h48" stroke-width="2"/>
  </g>`)

// 7 Halteverbot + Häkchen
add('verbot-geprueft', `
  ${halteverbot(52, 52, 46, 11)}
  <circle cx="88" cy="88" r="23" fill="${GREEN}" stroke="#fff" stroke-width="5"/>
  <path d="M77 88l8 8 14-15" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`)

// 8 Lupe über Auto
add('lupe', `
  <path d="M76 76l28 28" stroke="${INK}" stroke-width="14" stroke-linecap="round"/>
  <circle cx="50" cy="50" r="35" fill="#fff" stroke="${INK}" stroke-width="9"/>
  <g transform="translate(50 52) scale(.6) translate(-60 -61)">${carFront(BLUE, '#fff', YEL, INK)}</g>`)

// 9 Sprechblase mit Ausrufezeichen
add('sprechblase', `
  <rect x="10" y="12" width="100" height="74" rx="20" fill="${RED}"/>
  <path d="M30 80l-6 28 30-24z" fill="${RED}"/>
  <rect x="54" y="25" width="12" height="36" rx="6" fill="#fff"/>
  <circle cx="60" cy="73" r="7" fill="#fff"/>`)

// 10 Fußgänger
add('fussgaenger', `
  <rect x="8" y="8" width="104" height="104" rx="24" fill="${BLUE}"/>
  <circle cx="63" cy="28" r="9" fill="#fff"/>
  <path d="M60 44l-5 26M59 48l-12 11M59 48l12 11M55 70l-11 26M55 70l9 11 2 15" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`)

// 11 Fahrrad
add('fahrrad', `
  <circle cx="60" cy="60" r="54" fill="${BLUE}"/>
  <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="36" cy="72" r="16" stroke-width="6"/>
    <circle cx="84" cy="72" r="16" stroke-width="6"/>
    <path d="M36 72l16-26 8 26zM52 46h24L60 72M76 46l8 26M72 38h9M46 42h12" stroke-width="5"/>
  </g>`)

// 12 Knöllchen
add('knoellchen', `
  <mask id="m"><rect width="120" height="120" fill="#fff"/><circle cx="22" cy="36" r="7" fill="#000"/><circle cx="98" cy="36" r="7" fill="#000"/></mask>
  <rect x="22" y="8" width="76" height="104" rx="9" fill="${YEL}" mask="url(#m)"/>
  <text x="60" y="28" font-family="${FONT}" font-size="15" font-weight="900" fill="${INK}" text-anchor="middle">OWiA</text>
  <path d="M33 36h54" stroke="${INK}" stroke-width="2" stroke-dasharray="4 4"/>
  <rect x="33" y="48" width="54" height="6" rx="3" fill="${INK}"/>
  <rect x="33" y="61" width="40" height="6" rx="3" fill="${INK}"/>
  <rect x="33" y="74" width="48" height="6" rx="3" fill="${INK}"/>
  <circle cx="78" cy="96" r="8" fill="none" stroke="${RED}" stroke-width="3"/>
  <path d="M33 96h28" stroke="${INK}" stroke-width="2"/>`)

// 13 Paragraph
add('paragraph', `
  <rect x="8" y="8" width="104" height="104" rx="24" fill="${BLUE}"/>
  <text x="60" y="88" font-family="Georgia, 'Times New Roman', serif" font-size="80" font-weight="700" fill="#fff" text-anchor="middle">§</text>
  <circle cx="96" cy="24" r="10" fill="${RED}"/>`)

// 14 Wortmarke owia mit rotem i-Punkt
add('wortmarke-owia', `
  <g fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -1)">
    <circle cx="18" cy="65" r="11"/>
    <path d="M41 54l6.5 22 6.5-18 6.5 18 6.5-22"/>
    <path d="M78 56v20"/>
    <circle cx="99" cy="65" r="11"/>
    <path d="M110 54v22"/>
  </g>
  <circle cx="78" cy="41" r="6.5" fill="${RED}"/>`)

// 15 Status-Ampel
add('status-ampel', `
  <rect x="36" y="8" width="48" height="104" rx="24" fill="${INK}"/>
  <circle cx="60" cy="33" r="12" fill="${GREY}"/>
  <circle cx="60" cy="60" r="12" fill="${YEL}"/>
  <circle cx="60" cy="87" r="12" fill="${GREEN}"/>`)

// 16 Wappen mit Auto
add('wappen', `
  <path d="M60 8l42 14v34c0 28-18 46-42 56-24-10-42-28-42-56V22z" fill="${BLUE}"/>
  <g transform="translate(60 60) scale(.72) translate(-60 -61)">${carFront('#fff', BLUE, YEL, '#fff')}</g>`)

// 17 Umschlag + Pin
add('brief-pin', `
  <rect x="10" y="42" width="86" height="60" rx="8" fill="#fff" stroke="${INK}" stroke-width="6"/>
  <path d="M15 48l38 29 38-29" fill="none" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
  <g transform="translate(58 4) scale(.5)">
    <path d="${PIN}" fill="${RED}" stroke="#fff" stroke-width="9"/>
    <circle cx="60" cy="48" r="16" fill="#fff"/>
  </g>`)

// 18 Eingeschränktes Halteverbot, pur
add('eingeschraenkt', halteverbot(60, 60, 54, 13, false))

// 19 QR-Sticker
{
  const finder = (x, y) => `<rect x="${x}" y="${y}" width="26" height="26" rx="3" fill="${INK}"/><rect x="${x + 4}" y="${y + 4}" width="18" height="18" rx="1.5" fill="#fff"/><rect x="${x + 8}" y="${y + 8}" width="10" height="10" rx="1" fill="${INK}"/>`
  const mods = [[50, 18], [56, 26], [50, 34], [64, 34], [50, 46], [18, 50], [30, 56], [42, 50], [56, 58], [64, 50], [70, 62], [56, 70], [44, 64], [80, 52], [96, 56], [88, 64], [76, 44], [100, 46], [50, 82], [62, 90], [50, 96], [42, 76], [62, 102]]
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="7" height="7" rx="1" fill="${INK}"/>`).join('')
  add('qr-sticker', `
  <rect x="8" y="8" width="104" height="104" rx="14" fill="#fff" stroke="${INK}" stroke-width="4"/>
  ${finder(16, 16)}${finder(78, 16)}${finder(16, 78)}${mods}
  ${halteverbot(91, 91, 14, 4)}`)
}

// 20 Auto auf dem Bordstein
add('bordstein', `
  <path d="M6 93h58V82h50" fill="none" stroke="${INK}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
  <g transform="rotate(-11.8 38 83) translate(0 8)">${carSide(RED, '#fff', INK, '#fff')}</g>`)

// 21 Fotostapel
add('fotostapel', `
  <rect x="22" y="30" width="76" height="60" rx="6" fill="#9DB4D3" transform="rotate(-16 60 60)"/>
  <rect x="22" y="30" width="76" height="60" rx="6" fill="#C4D3E8" transform="rotate(10 60 60)"/>
  <g transform="rotate(-3 60 62)">
    <rect x="20" y="32" width="80" height="62" rx="6" fill="#fff" stroke="${INK}" stroke-width="4"/>
    <rect x="27" y="39" width="66" height="40" rx="2" fill="#DCE8F7"/>
    <g transform="translate(60 61) scale(.5) translate(-62 -61)">${carSide(BLUE, '#DCE8F7', INK, '#DCE8F7')}</g>
  </g>`)

// 22 Smartphone
add('smartphone', `
  <rect x="30" y="6" width="60" height="108" rx="13" fill="${INK}"/>
  <rect x="36" y="16" width="48" height="82" rx="5" fill="#fff"/>
  ${halteverbot(60, 48, 18, 5)}
  <circle cx="60" cy="83" r="7" fill="${RED}"/>
  <rect x="52" y="104" width="16" height="3" rx="1.5" fill="#fff"/>`)

// 23 Hexagon-Badge
add('hexagon', `
  <path d="M60 6l47 27v54l-47 27-47-27V33z" fill="${FIX}" stroke-linejoin="round"/>
  <path d="M60 15l39 22.5v45L60 105l-39-22.5v-45z" fill="none" stroke="${YEL}" stroke-width="3"/>
  <text x="60" y="69" font-family="${FONT}" font-size="25" font-weight="900" fill="${YEL}" text-anchor="middle">OWiA</text>`)

// 24 Zebrastreifen mit Auto (Draufsicht)
add('zebrastreifen', `
  <clipPath id="c"><circle cx="60" cy="60" r="54"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="120" height="120" fill="${FIX}"/>
    ${[12, 30, 48, 66, 84, 102].map((x) => `<rect x="${x - 5}" y="0" width="10" height="120" fill="#fff"/>`).join('')}
  </g>
  <rect x="38" y="26" width="44" height="68" rx="13" fill="${RED}" stroke="${FIX}" stroke-width="3"/>
  <rect x="44" y="40" width="32" height="13" rx="4" fill="#F7C6C1"/>
  <rect x="45" y="74" width="30" height="9" rx="3" fill="#F7C6C1"/>`)

// 25 Pin mit Uhr (wann + wo)
add('pin-uhr', `
  <path d="${PIN}" fill="${BLUE}"/>
  <circle cx="60" cy="48" r="28" fill="#fff"/>
  ${[[60, 25], [83, 48], [60, 71], [37, 48]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2" fill="${FIX}"/>`).join('')}
  <path d="M60 48V31M60 48l12 7" stroke="${FIX}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="60" cy="48" r="3.5" fill="${RED}"/>`)

// 26 Warndreieck mit Auto
add('warndreieck', `
  <path d="M60 13l50 88H10z" fill="#fff" stroke="${RED}" stroke-width="10" stroke-linejoin="round"/>
  <g transform="translate(60 74) scale(.52) translate(-60 -61)">${carFront(FIX, '#fff', YEL, FIX)}</g>`)

// 27 Papierflieger
add('papierflieger', `
  <path d="M8 100q14-14 30-6" fill="none" stroke="${GREY}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="1 7"/>
  <path d="M10 58L108 16 54 70z" fill="${BLUE}"/>
  <path d="M54 70L108 16 80 104z" fill="#0D3F80"/>
  <path d="M54 70l2 26 12-15z" fill="#0A2F60"/>`)

// 28 A als Straße
add('a-strasse', `
  <path d="M50 8h20l42 104H8z" fill="${INK}" stroke-linejoin="round"/>
  <path d="M60 14v36M60 84v24" stroke="${YEL}" stroke-width="4" stroke-dasharray="7 7"/>
  <rect x="26" y="64" width="68" height="8" fill="${RED}"/>
  <circle cx="60" cy="16" r="5" fill="${YEL}"/>`)

// 29 Parkuhr
add('parkuhr', `
  <rect x="55" y="62" width="10" height="42" fill="${INK}"/>
  <rect x="40" y="102" width="40" height="9" rx="3" fill="${INK}"/>
  <rect x="28" y="8" width="64" height="58" rx="22" fill="${INK}"/>
  <rect x="39" y="19" width="42" height="28" rx="7" fill="#fff"/>
  <text x="60" y="42" font-family="${FONT}" font-size="22" font-weight="900" fill="${BLUE}" text-anchor="middle">P</text>
  <rect x="51" y="53" width="18" height="4" rx="2" fill="${YEL}"/>`)

// 30 P durchgestrichen
add('p-durchgestrichen', `
  <rect x="8" y="8" width="104" height="104" rx="24" fill="${BLUE}"/>
  <text x="60" y="89" font-family="${FONT}" font-size="78" font-weight="900" fill="#fff" text-anchor="middle">P</text>
  <path d="M24 96L96 24" stroke="${BLUE}" stroke-width="16" stroke-linecap="round"/>
  <path d="M24 96L96 24" stroke="${RED}" stroke-width="10" stroke-linecap="round"/>`)

const wrap = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">${body.replace(/\n\s*/g, '')}</svg>\n`
L.forEach(({ slug, svg }, i) => {
  const name = `${String(i + 1).padStart(2, '0')}-${slug}`
  writeFileSync(`${OUT}/${name}.svg`, wrap(svg))
  // Dunkle Variante: Tinte wird hell, alles andere bleibt.
  writeFileSync(`${OUT}/${name}-dunkel.svg`, wrap(svg.replaceAll(INK, LIGHT)))
})
console.log(L.length, 'Logos')
