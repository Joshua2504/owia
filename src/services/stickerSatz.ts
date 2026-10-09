// Satz der Sticker-Textvorlagen (services/stickerEntwuerfe.ts): eine Vorlage
// wird für ein Etikettenformat einmal gesetzt und ergibt eine Zeichenliste in
// mm (Ursprung oben links, y nach unten). Aus derselben Liste entstehen
//   - die Druckvorlage im PDF (zeichnePdf → services/stickers.ts bettet sie
//     einmal je Batch als Form-XObject ein und setzt pro Sticker nur noch
//     QR-Code und Code-Text darauf) und
//   - die Vorschau als SVG (svgVon → /sticker, /sticker-test).
// Gemessen wird immer mit den PDF-Standardschriften von pdf-lib; die SVG-Texte
// bekommen die gemessene Breite als textLength. Vorschau und Druck brechen
// damit an denselben Stellen um.
//
// Geometrie (Ränder, QR, Piktogramme) skaliert mit dem Format (g), die Schrift
// (t) schrumpft zusätzlich schrittweise, bis alles aufs Etikett passt.
// Referenzformat: 96 × 50,8 mm (ablösbare Etiketten), dort ist g = t = 1.
import {
  PDFDocument, PDFFont, PDFPage, StandardFonts, LineCapStyle, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
} from 'pdf-lib'

export const MM = 72 / 25.4
const REF_W = 96
const REF_H = 50.8
const GELB = '#ffd400'

// ---------------------------------------------------------------------------
// Vorlagen-Datenmodell
// ---------------------------------------------------------------------------

/** Text-Auszeichnung in allen Texten: **fett**, ==gelb markiert==,
 *  __unterstrichen__ (Markierung für Schwarzweiß) und {betrag}. */
export type Block =
  | { t: 'bar' }
  | { t: 'kicker'; text: string; linien?: boolean }
  | { t: 'h' | 'p' | 's' | 'riesig' | 'gross' | 'einzeiler'; text: string; gelb?: boolean }
  | { t: 'preis' }
  | { t: 'stempel'; text: string }
  | { t: 'blase'; text: string }
  | { t: 'liste'; art: 'haken' | 'num' | 'ampel'; items: Array<{ text: string; marke?: string; an?: boolean }> }
  | { t: 'zeilen'; kopf?: string; gross?: boolean; items: Array<[string, string]> }
  | { t: 'qa'; items: Array<[string, string]> }
  | { t: 'spalten'; items: Array<{ h: string; s: string }> }

export interface Entwurf {
  slug: string
  name: string
  idee: string
  /** Untergrund: weiß, schwarz, signalgelb oder weiß mit grauer Schrift. */
  grund?: 'hell' | 'dunkel' | 'gelb' | 'leise'
  /** mono: alles in Schreibmaschine; serif: Überschrift + Text in Antiqua. */
  schrift?: 'mono' | 'serif'
  rahmen?: { band: string } | 'warnband'
  qr?: 'gross' | 'klein'
  links?: 'rollstuhl' | 'fussgaenger' | 'fahrrad' | 'ausruf' | 'paragraf'
  bloecke: Block[]
  fein: string
  /** Vorlage gehört zu genau diesem Tatbestand (Text nennt ihn) – dann gilt
   *  dessen Regelsatz, egal was im Formular gewählt ist. */
  tbnr?: string
}

/** Nennt die Vorlage einen Betrag? Dann braucht der Batch einen Tatbestand. */
export function brauchtBetrag(e: Entwurf): boolean {
  return JSON.stringify(e.bloecke).includes('{betrag}') || e.bloecke.some((b) => b.t === 'preis') || e.fein.includes('{betrag}')
}

// ---------------------------------------------------------------------------
// Schriften
// ---------------------------------------------------------------------------

export type FontKey = 'sans' | 'sansB' | 'sansI' | 'mono' | 'monoB' | 'serif' | 'serifB'
export type SatzFonts = Record<FontKey, PDFFont>

export async function embedSatzFonts(doc: PDFDocument): Promise<SatzFonts> {
  return {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansB: await doc.embedFont(StandardFonts.HelveticaBold),
    sansI: await doc.embedFont(StandardFonts.HelveticaOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoB: await doc.embedFont(StandardFonts.CourierBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifB: await doc.embedFont(StandardFonts.TimesRomanBold),
  }
}

let messFonts: Promise<SatzFonts> | null = null
/** Nur zum Messen (SVG-Vorschau ohne eigenes PDF). */
export function satzFonts(): Promise<SatzFonts> {
  if (!messFonts) messFonts = PDFDocument.create().then(embedSatzFonts)
  return messFonts
}

const SVG_FAMILIE: Record<FontKey, string> = {
  sans: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  sansB: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  sansI: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  mono: "'Courier New', Courier, 'Liberation Mono', monospace",
  monoB: "'Courier New', Courier, 'Liberation Mono', monospace",
  serif: "'Times New Roman', Times, 'Liberation Serif', serif",
  serifB: "'Times New Roman', Times, 'Liberation Serif', serif",
}

// ---------------------------------------------------------------------------
// Zeichenliste
// ---------------------------------------------------------------------------

export type Item =
  /** SVG-Pfad in eigenen Einheiten: Punkt p landet bei (tx + k·px, ty + k·py) mm. */
  | { k: 'path'; d: string; tx: number; ty: number; s: number; fill?: string; stroke?: string; sw?: number }
  /** Text ab x auf der Grundlinie y, w = gemessene Breite (inkl. Sperrung). */
  | { k: 'text'; x: number; y: number; size: number; font: FontKey; color: string; text: string; w: number; ls: number }
  | { k: 'rot'; cx: number; cy: number; deg: number; items: Item[] }

const f2 = (n: number) => String(Math.round(n * 1000) / 1000)

function rect(x: number, y: number, w: number, h: number, fill: string): Item {
  return { k: 'path', d: `M${f2(x)} ${f2(y)}h${f2(w)}v${f2(h)}h${f2(-w)}z`, tx: 0, ty: 0, s: 1, fill }
}

function rrectD(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2)
  return `M${f2(x + r)} ${f2(y)}h${f2(w - 2 * r)}a${f2(r)} ${f2(r)} 0 0 1 ${f2(r)} ${f2(r)}v${f2(h - 2 * r)}` +
    `a${f2(r)} ${f2(r)} 0 0 1 ${f2(-r)} ${f2(r)}h${f2(-(w - 2 * r))}a${f2(r)} ${f2(r)} 0 0 1 ${f2(-r)} ${f2(-r)}` +
    `v${f2(-(h - 2 * r))}a${f2(r)} ${f2(r)} 0 0 1 ${f2(r)} ${f2(-r)}z`
}

function kreisD(cx: number, cy: number, r: number): string {
  return `M${f2(cx - r)} ${f2(cy)}a${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0a${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0z`
}

/** Sutherland-Hodgman: konvexes Polygon auf ein Rechteck zuschneiden. */
function clipRect(poly: Array<[number, number]>, x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const kanten: Array<[(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]]> = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]],
  ]
  let out = poly
  for (const [innen, schnitt] of kanten) {
    const inp = out
    out = []
    for (let i = 0; i < inp.length; i++) {
      const a = inp[(i + inp.length - 1) % inp.length]
      const b = inp[i]
      if (innen(b)) {
        if (!innen(a)) out.push(schnitt(a, b))
        out.push(b)
      } else if (innen(a)) {
        out.push(schnitt(a, b))
      }
    }
    if (!out.length) break
  }
  return out
}

/** Absperrband: schwarze 45°-Streifen auf Gelb, auf das Etikett beschnitten. */
function streifen(w: number, h: number, breite: number): Item {
  let d = ''
  for (let x = -h; x < w + h; x += 2 * breite) {
    const p = clipRect([[x, h], [x + breite, h], [x + breite + h, 0], [x + h, 0]], 0, 0, w, h)
    if (p.length > 2) d += `M${p.map(([a, b]) => `${f2(a)} ${f2(b)}`).join('L')}z`
  }
  return { k: 'path', d, tx: 0, ty: 0, s: 1, fill: '#111111' }
}

// ---------------------------------------------------------------------------
// Fließtext mit Auszeichnung
// ---------------------------------------------------------------------------

type Stil = { b: boolean; mark: boolean; ul: boolean }
type Lauf = { text: string; stil: Stil }
type Wort = Lauf[]

/** „Sie ==55 €==." → Wörter aus Läufen. Umbrochen wird nur an normalen
 *  Leerzeichen (formatEuro setzt ein geschütztes zwischen Betrag und €). */
function woerter(text: string): Wort[] {
  const out: Wort[] = []
  const stil: Stil = { b: false, mark: false, ul: false }
  let wort: Wort = []
  let buf = ''
  const lauf = () => { if (buf) { wort.push({ text: buf, stil: { ...stil } }); buf = '' } }
  const ende = () => { lauf(); if (wort.length) out.push(wort); wort = [] }
  for (let i = 0; i < text.length; i++) {
    const zwei = text.slice(i, i + 2)
    if (zwei === '**' || zwei === '==' || zwei === '__') {
      lauf()
      if (zwei === '**') stil.b = !stil.b
      if (zwei === '==') stil.mark = !stil.mark
      if (zwei === '__') stil.ul = !stil.ul
      i++
    } else if (text[i] === ' ') {
      ende()
    } else {
      buf += text[i]
    }
  }
  ende()
  return out
}

type Familie = 'sans' | 'mono' | 'serif'
interface TextStil {
  size: number
  lh: number
  familie: Familie
  bold?: boolean
  italic?: boolean
  color: string
  nowrap?: boolean
  /** Sperrung in em */
  ls?: number
  upper?: boolean
}

function fontKey(familie: Familie, bold: boolean, italic = false): FontKey {
  if (familie === 'mono') return bold ? 'monoB' : 'mono'
  if (familie === 'serif') return bold ? 'serifB' : 'serif'
  return italic ? 'sansI' : bold ? 'sansB' : 'sans'
}

interface Gesetzt { h: number; w: number; place: (x: number, y: number) => Item[] }

/** Absatz setzen; null, wenn ein Wort (bzw. bei nowrap die Zeile) nicht in die Breite passt. */
function absatz(text: string, st: TextStil, breite: number, fonts: SatzFonts): Gesetzt | null {
  const ls = (st.ls || 0) * st.size
  const roh = st.upper ? text.toUpperCase() : text
  const ws = woerter(roh)
  const font = (s: Stil) => fonts[fontKey(st.familie, !!st.bold || s.b, st.italic)]
  const laufW = (l: Lauf) => font(l.stil).widthOfTextAtSize(l.text, st.size) + ls * l.text.length
  const wortW = (w: Wort) => w.reduce((s, l) => s + laufW(l), 0)
  const space = fonts[fontKey(st.familie, !!st.bold, st.italic)].widthOfTextAtSize(' ', st.size) + ls
  const zeilen: Wort[][] = []
  let cur: Wort[] = []
  let w = 0
  for (const wort of ws) {
    const ww = wortW(wort)
    if (ww > breite + 0.01) return null
    const nw = cur.length ? w + space + ww : ww
    if (nw > breite + 0.01 && cur.length) {
      if (st.nowrap) return null
      zeilen.push(cur)
      cur = [wort]
      w = ww
    } else {
      cur.push(wort)
      w = nw
    }
  }
  if (cur.length) zeilen.push(cur)
  const lineH = st.size * st.lh
  const maxW = Math.max(0, ...zeilen.map((z) => z.reduce((s, wo, i) => s + wortW(wo) + (i ? space : 0), 0)))
  return {
    h: zeilen.length * lineH,
    w: maxW,
    place: (x0, y0) => {
      const items: Item[] = []
      const hinten: Item[] = []
      zeilen.forEach((zeile, zi) => {
        const base = y0 + zi * lineH + lineH / 2 + 0.35 * st.size
        let x = x0
        // Läufe mit Position; Markierung als zusammenhängende Fläche je Zeile.
        type Pos = { l: Lauf; x: number; w: number }
        const pos: Pos[] = []
        zeile.forEach((wort, wi) => {
          if (wi) x += space
          for (const l of wort) {
            const lw = laufW(l)
            pos.push({ l, x, w: lw })
            x += lw
          }
        })
        for (const key of ['mark', 'ul'] as const) {
          let start = -1
          for (let i = 0; i <= pos.length; i++) {
            const an = i < pos.length && pos[i].l.stil[key]
            if (an && start < 0) start = i
            if (!an && start >= 0) {
              const a = pos[start].x
              const e = pos[i - 1].x + pos[i - 1].w - ls
              if (key === 'mark') {
                const pad = 0.18 * st.size
                hinten.push(rect(a - pad, base - 0.86 * st.size, e - a + 2 * pad, 1.12 * st.size, GELB))
              } else {
                items.push(rect(a, base + 0.14 * st.size, e - a, 0.12 * st.size, st.color))
              }
              start = -1
            }
          }
        }
        for (const p of pos) {
          items.push({
            k: 'text', x: p.x, y: base, size: st.size, font: fontKey(st.familie, !!st.bold || p.l.stil.b, st.italic),
            // Auf Gelb immer dunkel, auch auf schwarzem Grund.
            color: p.l.stil.mark ? '#111111' : st.color, text: p.l.text, w: p.w - ls * p.l.text.length, ls,
          })
        }
      })
      return [...hinten, ...items]
    },
  }
}

// ---------------------------------------------------------------------------
// Piktogramme (48er-Raster, Strich 3,2)
// ---------------------------------------------------------------------------

const IKON: Record<'rollstuhl' | 'fussgaenger' | 'fahrrad', string> = {
  fussgaenger: `${kreisD(25, 7, 4)}M24 14L21 27L15 42M21 27L29 33L31 42M23 18L15 24M24 17L31 24L37 25`,
  fahrrad: `${kreisD(11, 32, 8)}${kreisD(37, 32, 8)}M11 32L19 18L32 18L37 32M19 18L26 32L11 32M15 13L22 13M32 18L30 12L35 12`,
  rollstuhl: `${kreisD(19, 7, 4)}M19 14L19 28L31 28L36 39L40 39M19 20L29 20M13 22A11 11 0 1 0 29 35`,
}

// ---------------------------------------------------------------------------
// Satz
// ---------------------------------------------------------------------------

interface Palette { bg: string | null; ink: string; sek: string; fein: string; code: string }
const PALETTE: Record<NonNullable<Entwurf['grund']>, Palette> = {
  hell: { bg: null, ink: '#111111', sek: '#444444', fein: '#555555', code: '#333333' },
  dunkel: { bg: '#111111', ink: '#ffffff', sek: '#c8c8c8', fein: '#c8c8c8', code: '#dddddd' },
  gelb: { bg: GELB, ink: '#111111', sek: '#222222', fein: '#222222', code: '#111111' },
  leise: { bg: null, ink: '#333333', sek: '#333333', fein: '#777777', code: '#333333' },
}

export interface SatzKontext {
  /** Formatierter Regelsatz („55 €") für {betrag}. */
  betrag: string
  /** Beispiel-Code-Text unter dem QR (gleich lang wie die echten). */
  codeLabel: string
  fonts: SatzFonts
}

export interface Satz {
  /** Statischer Teil (alles außer QR-Modulen und Code-Text), mm. */
  items: Item[]
  /** QR-Feld inkl. Ruhezone (2 Module), mm. */
  qr: { x: number; y: number; size: number }
  /** Code-Text: mittig über cx, Grundlinie y. */
  code: { cx: number; y: number; size: number; color: string }
  /** false = auch mit kleinster Schrift zu eng (Text wird beschnitten). */
  passt: boolean
}

/** Vorlage für ein Etikett w × h (mm) setzen. */
export function setze(e: Entwurf, w: number, h: number, ctx: SatzKontext): Satz {
  const g = Math.min(w / REF_W, h / REF_H)
  for (let f = 1; f >= 0.5; f -= 0.04) {
    const satz = versuch(e, w, h, g, g * f, ctx)
    if (satz) return satz
  }
  return versuch(e, w, h, g, g * 0.5, ctx, true)!
}

function versuch(e: Entwurf, w: number, h: number, g: number, t: number, ctx: SatzKontext, erzwingen = false): Satz | null {
  const { fonts } = ctx
  const pal = PALETTE[e.grund || 'hell']
  const familie: Familie = e.schrift === 'mono' ? 'mono' : 'sans'
  const titelFamilie: Familie = e.schrift || 'sans'
  const items: Item[] = []
  const ersetze = (s: string) => s.replace(/\{betrag\}/g, ctx.betrag)

  // Untergrund und Rahmen → Inhaltsbox
  if (pal.bg) items.push(rect(0, 0, w, h, pal.bg))
  let box = { x: 3.65 * g, y: 3.26 * g, w: w - 7.3 * g, h: h - 5.95 * g }
  if (e.rahmen === 'warnband') {
    const b = 2.11 * g
    items.push(rect(0, 0, w, h, GELB), streifen(w, h, b))
    items.push({ k: 'path', d: rrectD(b, b, w - 2 * b, h - 2 * b, 0.38 * g), tx: 0, ty: 0, s: 1, fill: '#ffffff' })
    box = { x: b + 2.88 * g, y: b + 2.11 * g, w: w - 2 * b - 5.76 * g, h: h - 2 * b - 4.22 * g }
  } else if (e.rahmen) {
    const size = 2.16 * t
    const bh = size + 2.68 * g
    items.push(rect(0, 0, w, bh, '#111111'))
    const band = absatz(e.rahmen.band, { size, lh: 1, familie: 'sans', bold: true, color: GELB, ls: 0.14, upper: true, nowrap: true }, w - 7.3 * g, fonts)
    if (!band && !erzwingen) return null
    if (band) items.push(...band.place(3.65 * g, (bh - size) / 2))
    box = { x: 3.65 * g, y: bh + 2.3 * g, w: w - 7.3 * g, h: h - bh - 4.6 * g }
  }

  // QR-Spalte: Größe hängt nur am Format, nie an der Schriftgröße.
  const codeSize0 = 1.82 * g
  const codeW0 = fonts.monoB.widthOfTextAtSize(ctx.codeLabel, codeSize0)
  let qrSize = (e.qr === 'gross' ? 28.8 : e.qr === 'klein' ? 18.2 : 23) * g
  qrSize = Math.max(qrSize, Math.min(15, 23 * g)) // klein, aber scanbar
  qrSize = Math.min(qrSize, box.h - codeSize0 * 1.2 - 0.96 * g)
  const codeSize = Math.min(codeSize0, codeSize0 * (qrSize + 4.5 * g) / codeW0)
  const qrX = e.qr === 'gross' ? box.x : box.x + box.w - qrSize
  const qrBlock = qrSize + 0.96 * g + codeSize * 1.2
  const qrY = box.y + (box.h - qrBlock) / 2
  if (pal.bg || e.rahmen === 'warnband') {
    items.push({ k: 'path', d: rrectD(qrX, qrY, qrSize, qrSize, 0.58 * g), tx: 0, ty: 0, s: 1, fill: '#ffffff' })
  }
  const gap = 3.26 * g

  // Piktogramm bzw. Großzeichen links
  let links = 0
  if (e.links === 'paragraf') {
    const size = 21.1 * g
    const pw = fonts.serifB.widthOfTextAtSize('§', size)
    items.push({ k: 'text', x: box.x, y: box.y + box.h / 2 + 0.33 * size, size, font: 'serifB', color: pal.ink, text: '§', w: pw, ls: 0 })
    links = pw + gap
  } else if (e.links) {
    const size = 16.3 * g
    const y = box.y + (box.h - size) / 2
    const gelb = e.links === 'ausruf'
    items.push({ k: 'path', d: rrectD(box.x, y, size, size, 1.92 * g), tx: 0, ty: 0, s: 1, fill: gelb ? GELB : '#111111' })
    if (e.links === 'ausruf') {
      const fs = 12.5 * g
      const ew = fonts.sansB.widthOfTextAtSize('!', fs)
      items.push({ k: 'text', x: box.x + (size - ew) / 2, y: y + size / 2 + 0.36 * fs, size: fs, font: 'sansB', color: '#111111', text: '!', w: ew, ls: 0 })
    } else {
      const k = 12.5 * g / 48
      items.push({ k: 'path', d: IKON[e.links], tx: box.x + (size - 12.5 * g) / 2, ty: y + (size - 12.5 * g) / 2, s: k, stroke: GELB, sw: 3.2 })
    }
    links = size + gap
  }

  // Textspalte
  const tx = box.x + links + (e.qr === 'gross' ? qrSize + gap : 0)
  const tw = box.w - links - qrSize - gap
  const ctxB: BlockKontext = { fonts, pal, familie, titelFamilie, t, leise: e.grund === 'leise', ersetze }
  const gesetzt: Gesetzt[] = []
  for (const b of e.bloecke) {
    const s = block(b, tw, ctxB)
    if (!s) { if (erzwingen) continue; return null }
    gesetzt.push(s)
  }
  const fein = absatz(ersetze(e.fein), { size: 1.68 * t, lh: 1.25, familie, color: pal.fein }, tw, fonts)
  if (!fein && !erzwingen) return null
  const blockGap = 1.63 * t
  const mainH = gesetzt.reduce((s, b) => s + b.h, 0) + blockGap * Math.max(0, gesetzt.length - 1)
  const feinH = fein?.h || 0
  if (mainH + 1.44 * t + feinH > box.h + 0.01 && !erzwingen) return null
  let y = box.y
  for (const b of gesetzt) {
    items.push(...b.place(tx, y))
    y += b.h + blockGap
  }
  if (fein) items.push(...fein.place(tx, box.y + box.h - feinH))

  return {
    items,
    qr: { x: qrX, y: qrY, size: qrSize },
    code: { cx: qrX + qrSize / 2, y: qrY + qrSize + 0.96 * g + codeSize * 0.8, size: codeSize, color: pal.code },
    passt: !erzwingen,
  }
}

interface BlockKontext {
  fonts: SatzFonts
  pal: Palette
  familie: Familie
  titelFamilie: Familie
  t: number
  leise: boolean
  ersetze: (s: string) => string
}

function block(b: Block, tw: number, c: BlockKontext): Gesetzt | null {
  const { fonts, pal, familie, titelFamilie, t } = c
  switch (b.t) {
    case 'bar':
      return { h: 0.96 * t, w: 7.3 * t, place: (x, y) => [rect(x, y, 7.3 * t, 0.96 * t, GELB)] }

    case 'kicker': {
      const st: TextStil = { size: 2.02 * t, lh: 1.2, familie: 'sans', bold: true, color: pal.ink, ls: 0.12, upper: true }
      const a = absatz(b.text, st, tw, fonts)
      if (!a || !b.linien) return a
      const pad = 0.48 * t
      return {
        h: a.h + 2 * pad + 0.67 * t, w: tw,
        place: (x, y) => [
          rect(x, y, tw, 0.48 * t, pal.ink),
          ...a.place(x, y + 0.48 * t + pad),
          rect(x, y + 0.48 * t + 2 * pad + a.h, tw, 0.19 * t, pal.ink),
        ],
      }
    }

    case 'h': case 'p': case 's': case 'riesig': case 'gross': case 'einzeiler': {
      const color = b.gelb ? GELB : b.t === 's' ? pal.sek : pal.ink
      const serif = titelFamilie === 'serif' && (b.t === 'h' || b.t === 'p')
      const fam: Familie = serif ? 'serif' : familie
      const st: TextStil =
        b.t === 'h' ? { size: (serif ? 4.22 : 3.84) * t, lh: 1.12, familie: fam, bold: true, color }
        : b.t === 'p' ? { size: (c.leise ? 2.88 : 2.69) * t, lh: c.leise ? 1.35 : 1.3, familie: fam, color }
        : b.t === 's' ? { size: 2.16 * t, lh: 1.3, familie: fam, color }
        : b.t === 'riesig' ? { size: 9.12 * t, lh: 1, familie: fam, bold: true, color }
        : b.t === 'gross' ? { size: 6.14 * t, lh: 1.02, familie: fam, bold: true, color }
        : { size: 7.3 * t, lh: 1.1, familie: fam, bold: true, color, nowrap: true }
      return absatz(c.ersetze(b.text), st, tw, fonts)
    }

    case 'preis': {
      const size = 10.56 * t
      const a = absatz(c.ersetze('{betrag}'), { size, lh: 1, familie: 'sans', bold: true, color: '#111111', nowrap: true }, tw - 3.1 * t, fonts)
      if (!a) return null
      const pv = 0.38 * t
      const ph = 1.54 * t
      return {
        h: a.h + 2 * pv, w: a.w + 2 * ph,
        place: (x, y) => [rect(x, y, a.w + 2 * ph, a.h + 2 * pv, GELB), ...a.place(x + ph, y + pv)],
      }
    }

    case 'stempel': {
      const a = absatz(b.text, { size: 6.34 * t, lh: 1, familie: 'sans', bold: true, color: pal.ink, ls: 0.08, upper: true, nowrap: true }, tw, fonts)
      if (!a) return null
      const bw = 0.67 * t
      const bx = a.w + 2 * 1.92 * t + 2 * bw
      const by = a.h + 2 * 0.58 * t + 2 * bw
      const schraeg = bx * Math.sin(4 * Math.PI / 180)
      if (bx + 0.58 * t > tw) return null
      return {
        h: 0.96 * t + by + schraeg, w: bx,
        place: (x, y) => {
          const ox = x + 0.58 * t
          const oy = y + 0.96 * t + schraeg / 2
          const rahmen: Item = {
            k: 'path', tx: 0, ty: 0, s: 1, stroke: pal.ink, sw: bw,
            d: `M${f2(ox + bw / 2)} ${f2(oy + bw / 2)}h${f2(bx - bw)}v${f2(by - bw)}h${f2(-(bx - bw))}z`,
          }
          return [{ k: 'rot', cx: ox + bx / 2, cy: oy + by / 2, deg: -4, items: [rahmen, ...a.place(ox + bw + 1.92 * t, oy + bw + 0.58 * t)] }]
        },
      }
    }

    case 'blase': {
      const a = absatz(b.text, { size: 2.69 * t, lh: 1.2, familie: 'sans', italic: true, color: '#111111', nowrap: true }, tw - 4.3 * t, fonts)
      if (!a) return null
      const bw = a.w + 4.22 * t
      const bh = a.h + 2.3 * t
      const tail = 1.6 * t
      return {
        h: bh + tail, w: bw,
        place: (x, y) => [
          { k: 'path', d: rrectD(x, y, bw, bh, 1.92 * t) + `M${f2(x + 2.9 * t)} ${f2(y + bh - 0.1)}L${f2(x + 2.9 * t)} ${f2(y + bh + tail)}L${f2(x + 4.9 * t)} ${f2(y + bh - 0.1)}z`, tx: 0, ty: 0, s: 1, fill: '#ececec' },
          ...a.place(x + 2.11 * t, y + 1.15 * t),
        ],
      }
    }

    case 'liste': {
      const m = (b.art === 'num' ? 3.65 : 3.07) * t
      const abstand = 1.34 * t
      const st: TextStil = { size: 2.6 * t, lh: 1.2, familie, color: pal.ink }
      const zeilen = b.items.map((it) => absatz(c.ersetze(it.text), st, tw - m - abstand, fonts))
      if (zeilen.some((z) => !z)) return null
      const hs = zeilen.map((z) => Math.max(m, z!.h))
      const gapI = 1.15 * t
      return {
        h: hs.reduce((s, x) => s + x, 0) + gapI * (hs.length - 1), w: tw,
        place: (x, y0) => {
          const out: Item[] = []
          let y = y0
          b.items.forEach((it, i) => {
            const z = zeilen[i]!
            const my = y + (hs[i] - m) / 2
            if (b.art === 'haken') {
              const sw = 0.43 * t
              out.push({ k: 'path', d: `M${f2(x + sw / 2)} ${f2(my + sw / 2)}h${f2(m - sw)}v${f2(m - sw)}h${f2(-(m - sw))}z`, tx: 0, ty: 0, s: 1, stroke: pal.ink, sw })
              if (it.an) {
                const k = (m * 0.8) / 16
                out.push({ k: 'path', d: 'M3 8.5L6.2 11.7L13 4.5', tx: x + m * 0.1, ty: my + m * 0.1, s: k, stroke: pal.ink, sw: 3.2 })
              }
            } else if (b.art === 'num') {
              out.push({ k: 'path', d: kreisD(x + m / 2, my + m / 2, m / 2), tx: 0, ty: 0, s: 1, fill: pal.ink })
              const size = 2.11 * t * ((it.marke || '').length > 2 ? 0.8 : 1)
              const mw = fonts.sansB.widthOfTextAtSize(it.marke || '', size)
              out.push({ k: 'text', x: x + (m - mw) / 2, y: my + m / 2 + 0.36 * size, size, font: 'sansB', color: GELB, text: it.marke || '', w: mw, ls: 0 })
            } else if (it.an) {
              out.push({ k: 'path', d: kreisD(x + m / 2, my + m / 2, m / 2), tx: 0, ty: 0, s: 1, fill: '#1f8a3b' })
            } else {
              const sw = 0.48 * t
              out.push({ k: 'path', d: kreisD(x + m / 2, my + m / 2, (m - sw) / 2), tx: 0, ty: 0, s: 1, stroke: '#999999', sw })
            }
            out.push(...z.place(x + m + abstand, y + (hs[i] - z.h) / 2))
            y += hs[i] + gapI
          })
          return out
        },
      }
    }

    case 'zeilen': {
      const size = (b.gross ? 2.88 : 2.11) * t
      const st: TextStil = { size, lh: 1.25, familie, color: pal.ink, nowrap: true }
      const rows = b.items.map(([l, v]) => [absatz(l, st, tw, fonts), absatz(c.ersetze(v), { ...st, bold: true }, tw, fonts)] as const)
      if (rows.some(([l, v]) => !l || !v || l.w + v.w + 2 * t > tw)) return null
      const kopf = b.kopf ? absatz(b.kopf, { size: 2.5 * t, lh: 1.2, familie, bold: true, color: pal.ink, ls: 0.1, nowrap: true }, tw, fonts) : null
      if (b.kopf && !kopf) return null
      const kopfH = kopf ? kopf.h + 0.77 * t + 0.29 * t + 1.2 * t : 0
      const rowH = size * 1.25
      const gapR = 0.67 * t
      return {
        h: kopfH + rows.length * rowH + gapR * (rows.length - 1), w: tw,
        place: (x, y0) => {
          const out: Item[] = []
          if (kopf) {
            out.push(...kopf.place(x, y0))
            const ly = y0 + kopf.h + 0.77 * t
            let d = ''
            for (let dx = 0; dx < tw; dx += 1.3 * t) d += `M${f2(x + dx)} ${f2(ly)}h${f2(Math.min(0.8 * t, tw - dx))}v${f2(0.29 * t)}h${f2(-Math.min(0.8 * t, tw - dx))}z`
            out.push({ k: 'path', d, tx: 0, ty: 0, s: 1, fill: pal.ink })
          }
          let y = y0 + kopfH
          for (const [l, v] of rows) {
            out.push(...l!.place(x, y), ...v!.place(x + tw - v!.w, y))
            const base = y + rowH / 2 + 0.35 * size
            let d = ''
            const von = x + l!.w + t
            const bis = x + tw - v!.w - t
            for (let dx = von; dx < bis; dx += 0.62 * t) d += `M${f2(dx)} ${f2(base - 0.12 * t)}h${f2(0.24 * t)}v${f2(0.24 * t)}h${f2(-0.24 * t)}z`
            if (d) out.push({ k: 'path', d, tx: 0, ty: 0, s: 1, fill: '#888888' })
            y += rowH + gapR
          }
          return out
        },
      }
    }

    case 'qa': {
      const st: TextStil = { size: 2.5 * t, lh: 1.25, familie, color: pal.ink }
      const fragen = b.items.map(([q]) => absatz(q, { ...st, bold: true, nowrap: true }, tw, fonts))
      if (fragen.some((q) => !q)) return null
      const qw = Math.max(...fragen.map((q) => q!.w))
      const gx = 1.54 * t
      const antworten = b.items.map(([, a]) => absatz(c.ersetze(a), st, tw - qw - gx, fonts))
      if (antworten.some((a) => !a) || qw + gx > tw * 0.7) return null
      const hs = b.items.map((_, i) => Math.max(fragen[i]!.h, antworten[i]!.h))
      const gy = 0.86 * t
      return {
        h: hs.reduce((s, x) => s + x, 0) + gy * (hs.length - 1), w: tw,
        place: (x, y0) => {
          const out: Item[] = []
          let y = y0
          b.items.forEach((_, i) => {
            out.push(...fragen[i]!.place(x, y), ...antworten[i]!.place(x + qw + gx, y))
            y += hs[i] + gy
          })
          return out
        },
      }
    }

    case 'spalten': {
      const n = b.items.length
      const gapC = (n === 2 ? 2.3 : 1.73) * t
      const colW = (tw - gapC * (n - 1)) / n
      const einzug = 2.4 * t
      const cols = b.items.map((it, i) => {
        const innen = i ? colW - einzug : colW
        const hh = absatz(it.h, { size: (n === 3 ? 2.88 : 3.84) * t, lh: 1.12, familie, bold: true, color: pal.ink }, innen, fonts)
        const ss = absatz(c.ersetze(it.s), { size: (n === 3 ? 1.92 : 2.16) * t, lh: 1.3, familie, color: pal.sek }, innen, fonts)
        return hh && ss ? { hh, ss } : null
      })
      if (cols.some((x) => !x)) return null
      const h = Math.max(...cols.map((x) => x!.hh.h + 0.96 * t + x!.ss.h))
      return {
        h, w: tw,
        place: (x, y) => cols.flatMap((col, i) => {
          const cx = x + i * (colW + gapC)
          const ix = i ? cx + einzug : cx
          return [
            ...(i ? [rect(cx, y, 0.29 * t, h, pal.ink)] : []),
            ...col!.hh.place(ix, y),
            ...col!.ss.place(ix, y + col!.hh.h + 0.96 * t),
          ]
        }),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------

function farbe(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** Zeichenliste ins PDF; x0/yTop = linke obere Etikettenecke in pt. */
export function zeichnePdf(page: PDFPage, fonts: SatzFonts, items: Item[], x0: number, yTop: number): void {
  for (const it of items) {
    if (it.k === 'path') {
      page.drawSvgPath(it.d, {
        x: x0 + it.tx * MM, y: yTop - it.ty * MM, scale: it.s * MM,
        color: it.fill ? farbe(it.fill) : undefined,
        borderColor: it.stroke ? farbe(it.stroke) : undefined,
        borderWidth: it.stroke ? it.sw : undefined,
        borderLineCap: it.stroke ? LineCapStyle.Round : undefined,
      })
    } else if (it.k === 'text') {
      const font = fonts[it.font]
      const size = it.size * MM
      const color = farbe(it.color)
      if (!it.ls) {
        page.drawText(it.text, { x: x0 + it.x * MM, y: yTop - it.y * MM, size, font, color })
      } else {
        // Gesperrt: Zeichen einzeln setzen (pdf-lib kennt keine Laufweite).
        let x = x0 + it.x * MM
        for (const ch of it.text) {
          page.drawText(ch, { x, y: yTop - it.y * MM, size, font, color })
          x += font.widthOfTextAtSize(ch, size) + it.ls * MM
        }
      }
    } else {
      // SVG dreht bei y nach unten mit negativem Winkel gegen den Uhrzeigersinn,
      // PDF (y nach oben) mit positivem.
      const th = -it.deg * Math.PI / 180
      const c = Math.cos(th)
      const s = Math.sin(th)
      const px = x0 + it.cx * MM
      const py = yTop - it.cy * MM
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, px - c * px + s * py, py - s * px - c * py))
      zeichnePdf(page, fonts, it.items, x0, yTop)
      page.pushOperators(popGraphicsState())
    }
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function svgItems(items: Item[]): string {
  return items.map((it) => {
    if (it.k === 'path') {
      const tr = it.tx || it.ty || it.s !== 1 ? ` transform="translate(${f2(it.tx)} ${f2(it.ty)}) scale(${f2(it.s)})"` : ''
      const paint = `fill="${it.fill || 'none'}"${it.stroke ? ` stroke="${it.stroke}" stroke-width="${f2(it.sw || 0)}" stroke-linecap="round" stroke-linejoin="round"` : ''}`
      return `<path d="${it.d}"${tr} ${paint}/>`
    }
    if (it.k === 'text') {
      const weight = /B$/.test(it.font) ? ' font-weight="bold"' : ''
      const style = it.font === 'sansI' ? ' font-style="italic"' : ''
      const breite = it.w + it.ls * it.text.length
      return `<text x="${f2(it.x)}" y="${f2(it.y)}" font-size="${f2(it.size)}" font-family="${esc(SVG_FAMILIE[it.font])}"${weight}${style} fill="${it.color}" textLength="${f2(breite)}" lengthAdjust="spacing" xml:space="preserve">${esc(it.text)}</text>`
    }
    return `<g transform="rotate(${it.deg} ${f2(it.cx)} ${f2(it.cy)})">${svgItems(it.items)}</g>`
  }).join('')
}

/** Vorschau als SVG (viewBox in mm). qrPfad: Module als Pfad (n × n). */
export function svgVon(satz: Satz, w: number, h: number, qr: { size: number; d: string }, codeLabel: string, fonts: SatzFonts, titel: string): string {
  const k = satz.qr.size / (qr.size + 4)
  const cw = fonts.monoB.widthOfTextAtSize(codeLabel, satz.code.size)
  const code: Item = { k: 'text', x: satz.code.cx - cw / 2, y: satz.code.y, size: satz.code.size, font: 'monoB', color: satz.code.color, text: codeLabel, w: cw, ls: 0 }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f2(w)} ${f2(h)}" role="img" aria-label="${esc(titel)}">` +
    `<rect width="${f2(w)}" height="${f2(h)}" fill="#ffffff"/>` +
    svgItems(satz.items) +
    `<path d="${qr.d}" transform="translate(${f2(satz.qr.x + 2 * k)} ${f2(satz.qr.y + 2 * k)}) scale(${f2(k)})" fill="#000000"/>` +
    svgItems([code]) +
    '</svg>'
}
