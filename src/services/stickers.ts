// QR-Sticker: Codes erzeugen, Kontingent prüfen, mit Anzeigen verknüpfen und
// die Druckbögen als PDF rendern.
//
// Ablauf: Nutzer erzeugt einen Batch (bis STICKER_MAX_SEITEN Bögen) → druckt
// das PDF selbst auf Etikettenbögen → nach dem Erstellen einer Anzeige scannt
// er einen Sticker (Scanner in der Anzeige oder Kamera → /S/<code>) und
// verknüpft ihn → klebt ihn ans Fahrzeug. Wer den Code danach scannt, sieht
// unter /S/<code> nur die öffentlichen Angaben (routes/sticker.ts).
//
// Der QR-Inhalt ist komplett in Großbuchstaben (`HTTPS://HOST/S/7KQ2XM9P`):
// so passt die URL in den alphanumerischen QR-Modus und damit in Version 2
// (25×25 Module) – der Code bleibt auch auf 70×37-mm-Etiketten gut scanbar.
// Deshalb gibt es die Route in routes/sticker.ts auch als `/S/:code`.
import crypto from 'crypto'
import mysql from 'mysql2/promise'
import { PDFDocument, PDFEmbeddedPage, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { pool } from '../db/connection'
import { qrcodegen } from '../vendor/qrcodegen'
import { regelsatzEuro, verstossText } from '../config/verstoss'
import { MM, Entwurf, embedSatzFonts, satzFonts, setze, svgVon, zeichnePdf } from './stickerSatz'
import { brauchtBetrag, entwurf as findeEntwurf, entwurfTbnr } from './stickerEntwuerfe'

/** Höchstzahl Bögen mit offenen Codes – über alle Batches eines Nutzers
 *  zusammen (siehe createBatch). So lassen sich Bögen für mehrere Verstöße
 *  und Vorlagen im Voraus drucken, ohne dass unbegrenzt Codes herumliegen.
 *  Große Batches gibt es als PDF in Teilen (STICKER_PDF_TEIL Bögen). */
export const STICKER_MAX_SEITEN = 1000
/** Bögen je PDF-Download – ein Teil rendert in wenigen Sekunden. */
export const STICKER_PDF_TEIL = 100
/** So lange kann der Besitzer eine Verknüpfung wieder lösen (Verklicker). */
export const STICKER_LOESEN_MINUTEN = 30

// Crockford-Base32 ohne I, L, O, U: keine Verwechslung beim Abtippen.
// „MUSTER…" kann daher nie ein echter Code sein (U fehlt) – die
// Kalibrierseite nutzt das.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LEN = 8
const MUSTER_CODE = 'MUSTER00'

export function generateCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)]
  return s
}

/** Code aus Nutzereingabe oder gescannter URL: Großbuchstaben, Trenner raus,
 *  O→0, I/L→1 (Crockford). Liefert null, wenn kein gültiger Code übrig bleibt. */
export function normalizeCode(input: unknown): string | null {
  let s = String(input ?? '').trim()
  const fromUrl = /\/S\/([0-9A-Za-z-]{8,9})\/?(?:[?#].*)?$/i.exec(s)
  if (fromUrl) s = fromUrl[1]
  s = s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== CODE_LEN) return null
  for (const ch of s) if (!ALPHABET.includes(ch)) return null
  return s
}

/** Lesbare Schreibweise auf dem Sticker: „7KQ2-XM9P". */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function stickerUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/$/, '')}/S/${code}`.toUpperCase()
}

// ---------------------------------------------------------------------------
// Bogenvorlagen
// ---------------------------------------------------------------------------

/** Geometrie eines Etikettenbogens (A4, alle Maße in mm) plus Druckoptionen. */
export interface StickerLayout {
  vorlage: string
  cols: number
  rows: number
  labelW: number
  labelH: number
  marginTop: number
  marginLeft: number
  gapX: number
  gapY: number
  /** Druckversatz: verschiebt alles nach rechts (+) bzw. unten (+). */
  dx: number
  dy: number
  /** Etikettenränder mitdrucken (Normalpapier zum Ausschneiden / Testdruck). */
  rahmen: boolean
  /** Fall-Sticker: Tatbestand (TBNR) + Aufdrucktext. Dann stehen Verstoß und
   *  Regelsatz auf dem Sticker, dazu Schreiblinien für Ort und Zeit. Fehlt
   *  bei neutralen Bögen (und bei allen Batches von vor dieser Option). */
  tbnr?: string | null
  aufdruck?: string | null
  /** Textvorlage (Slug aus services/stickerEntwuerfe.ts). Fehlt bzw. null =
   *  klassischer Text mit Aufdruck (alle Batches von vor den Vorlagen). */
  entwurf?: string | null
}

type Vorlage = Omit<StickerLayout, 'vorlage' | 'dx' | 'dy' | 'rahmen' | 'tbnr' | 'aufdruck' | 'entwurf'> & { id: string; name: string }

const A4_W = 210
const A4_H = 297

/** Gängige A4-Etikettenformate. Die Ränder sind aus Bogengröße und Raster
 *  errechnet (Bögen sind fast immer zentriert) – Abweichungen des konkreten
 *  Produkts gleicht der Nutzer per Druckversatz bzw. „Eigenes Format" aus. */
export const STICKER_VORLAGEN: Vorlage[] = [
  zentriert('105x57', '10 pro Bogen · 105 × 57 mm (randlos)', 2, 5, 105, 57, 0, 0),
  zentriert('96x50', '10 pro Bogen · 96 × 50,8 mm (z. B. ablösbare Etiketten)', 2, 5, 96, 50.8, 2.5, 0),
  zentriert('105x42', '14 pro Bogen · 105 × 42,3 mm (randlos)', 2, 7, 105, 42.3, 0, 0),
  zentriert('70x37', '24 pro Bogen · 70 × 37 mm (randlos)', 3, 8, 70, 37, 0, 0),
]
export const STICKER_DEFAULT_VORLAGE = '105x57'

function zentriert(
  id: string, name: string, cols: number, rows: number,
  labelW: number, labelH: number, gapX: number, gapY: number
): Vorlage {
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    id, name, cols, rows, labelW, labelH, gapX, gapY,
    marginLeft: round((A4_W - cols * labelW - (cols - 1) * gapX) / 2),
    marginTop: round((A4_H - rows * labelH - (rows - 1) * gapY) / 2),
  }
}

/** Layout aus Formular-/Query-Werten bauen und auf sinnvolle Grenzen prüfen.
 *  Liefert eine Fehlermeldung statt eines Layouts, wenn es nicht auf A4 passt. */
export function parseLayout(input: Record<string, unknown>): StickerLayout | string {
  const num = (k: string, fallback: number) => {
    const v = Number(String(input[k] ?? '').replace(',', '.'))
    return Number.isFinite(v) && String(input[k] ?? '').trim() !== '' ? v : fallback
  }
  const vorlageId = String(input.vorlage || STICKER_DEFAULT_VORLAGE)
  const preset = STICKER_VORLAGEN.find((v) => v.id === vorlageId)
  const base: Vorlage = preset || STICKER_VORLAGEN.find((v) => v.id === STICKER_DEFAULT_VORLAGE)!
  const eigen = vorlageId === 'eigen'
  const layout: StickerLayout = {
    vorlage: preset ? preset.id : eigen ? 'eigen' : base.id,
    cols: eigen ? Math.round(num('cols', base.cols)) : base.cols,
    rows: eigen ? Math.round(num('rows', base.rows)) : base.rows,
    labelW: eigen ? num('labelW', base.labelW) : base.labelW,
    labelH: eigen ? num('labelH', base.labelH) : base.labelH,
    marginTop: eigen ? num('marginTop', base.marginTop) : base.marginTop,
    marginLeft: eigen ? num('marginLeft', base.marginLeft) : base.marginLeft,
    gapX: eigen ? num('gapX', base.gapX) : base.gapX,
    gapY: eigen ? num('gapY', base.gapY) : base.gapY,
    dx: Math.max(-15, Math.min(15, num('dx', 0))),
    dy: Math.max(-15, Math.min(15, num('dy', 0))),
    rahmen: input.rahmen === true || input.rahmen === '1' || input.rahmen === 'on',
    tbnr: null,
    aufdruck: null,
    entwurf: null,
  }
  const tbnr = String(input.tbnr ?? '').trim()
  if (tbnr) {
    const katalog = verstossText(tbnr)
    if (!katalog) return 'Diesen Tatbestand gibt es im Katalog nicht.'
    layout.tbnr = tbnr
    layout.aufdruck = winAnsi(String(input.aufdruck ?? '')).slice(0, AUFDRUCK_MAX) || winAnsi(katalog)
  }
  const slug = String(input.entwurf ?? '').trim()
  if (slug) {
    const e = findeEntwurf(slug)
    if (!e) return 'Diese Textvorlage gibt es nicht.'
    // Vorlagen, deren Text einen Tatbestand nennt, bringen ihren eigenen mit.
    const tb = entwurfTbnr(e, layout.tbnr)
    if (brauchtBetrag(e) && !tb) return 'Diese Textvorlage nennt den Betrag – bitte einen Verstoß wählen.'
    if (tb && regelsatzEuro(tb) === null) return 'Für diesen Tatbestand ist kein Regelsatz hinterlegt.'
    layout.entwurf = e.slug
    layout.tbnr = tb
    layout.aufdruck = null
  }
  if (layout.cols < 1 || layout.cols > 6 || layout.rows < 1 || layout.rows > 15) {
    return 'Bitte 1–6 Spalten und 1–15 Zeilen angeben.'
  }
  if (layout.labelW < 40 || layout.labelH < 25) {
    return 'Etiketten müssen mindestens 40 × 25 mm groß sein, sonst wird der QR-Code zu klein.'
  }
  if (layout.entwurf && (layout.labelW < 60 || layout.labelH < 33)) {
    return 'Textvorlagen brauchen Etiketten ab 60 × 33 mm.'
  }
  if (layout.tbnr && (layout.labelW < 60 || layout.labelH < 33)) {
    return 'Sticker mit Verstoß brauchen Etiketten ab 60 × 33 mm – sonst bleibt kein Platz zum Ausfüllen von Ort und Zeit.'
  }
  if (layout.marginTop < 0 || layout.marginLeft < 0 || layout.gapX < 0 || layout.gapY < 0) {
    return 'Ränder und Abstände dürfen nicht negativ sein.'
  }
  const w = layout.marginLeft + layout.cols * layout.labelW + (layout.cols - 1) * layout.gapX
  const h = layout.marginTop + layout.rows * layout.labelH + (layout.rows - 1) * layout.gapY
  if (w > A4_W + 0.5 || h > A4_H + 0.5) {
    return `Das Raster ist größer als A4 (${Math.round(w)} × ${Math.round(h)} mm).`
  }
  return layout
}

export function perPage(layout: StickerLayout): number {
  return layout.cols * layout.rows
}

export const AUFDRUCK_MAX = 140

/** Nur Zeichen, die die PDF-Standardschriften (WinAnsi) setzen können –
 *  sonst wirft pdf-lib beim Rendern. */
function winAnsi(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF€„“”‚‘’–—…]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** „55 €" bzw. „17,50 €". */
export function formatEuro(euro: number): string {
  // Geschütztes Leerzeichen: Betrag und € nie auf zwei Zeilen.
  return `${Number.isInteger(euro) ? euro : euro.toFixed(2).replace('.', ',')}\u00a0€`
}

/** Verwarnungsgeld geht bis 55 €, darüber ist es ein Bußgeld (§ 56 OWiG). */
export function geldArt(euro: number): string {
  return euro <= 55 ? 'Verwarnungsgeld' : 'Bußgeld'
}

// ---------------------------------------------------------------------------
// Datenbank
// ---------------------------------------------------------------------------

/** Offene Codes = weder verknüpft noch entwertet. */
export async function openCodeCount(userId: number, conn: mysql.Pool | mysql.PoolConnection = pool): Promise<number> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM sticker_codes WHERE user_id = ? AND linked_at IS NULL AND voided_at IS NULL',
    [userId]
  )
  return Number(rows[0]?.c || 0)
}

/** Bögen aus Batches, in denen noch mindestens ein Code offen ist – zählt
 *  gegen STICKER_MAX_SEITEN. */
export async function openSheetCount(userId: number, conn: mysql.Pool | mysql.PoolConnection = pool): Promise<number> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT COALESCE(SUM(b.seiten), 0) AS s FROM sticker_batches b
      WHERE b.user_id = ? AND EXISTS (SELECT 1 FROM sticker_codes c WHERE c.batch_id = b.id
                                         AND c.linked_at IS NULL AND c.voided_at IS NULL)`,
    [userId]
  )
  return Number(rows[0]?.s || 0)
}

export type CreateBatchResult = { batchId: number } | { error: string }

export async function createBatch(userId: number, layout: StickerLayout, seiten: number): Promise<CreateBatchResult> {
  if (!Number.isInteger(seiten) || seiten < 1 || seiten > STICKER_MAX_SEITEN) {
    return { error: `Bitte 1 bis ${STICKER_MAX_SEITEN} Seiten wählen.` }
  }
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // Nutzerzeile sperren: zwei parallele Anfragen dürfen das Kontingent
    // nicht beide als frei sehen.
    await conn.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [userId])
    const offeneBoegen = await openSheetCount(userId, conn)
    if (offeneBoegen + seiten > STICKER_MAX_SEITEN) {
      await conn.rollback()
      const frei = Math.max(0, STICKER_MAX_SEITEN - offeneBoegen)
      return {
        error: frei
          ? `Du kannst gerade nur noch ${frei} ${frei === 1 ? 'Bogen' : 'Bögen'} erzeugen – ${offeneBoegen} Bögen haben noch offene Sticker.`
          : `Du hast schon ${offeneBoegen} Bögen mit offenen Stickern. Neue gibt es, wenn Sticker verknüpft oder Reste entwertet sind.`,
      }
    }
    const [res] = await conn.execute<mysql.ResultSetHeader>(
      'INSERT INTO sticker_batches (user_id, seiten, layout) VALUES (?, ?, ?)',
      [userId, seiten, JSON.stringify(layout)]
    )
    const batchId = res.insertId
    const total = seiten * perPage(layout)
    const codes = new Set<string>()
    let position = 0
    while (codes.size < total) {
      const chunk: string[] = []
      const imChunk = new Set<string>()
      while (chunk.length < 500 && codes.size + chunk.length < total) {
        const c = generateCode()
        if (!codes.has(c) && !imChunk.has(c)) { chunk.push(c); imChunk.add(c) }
      }
      // INSERT IGNORE: eine (astronomisch unwahrscheinliche) Kollision mit
      // einem bestehenden Code fällt einfach weg und wird nachgezogen.
      const values: (string | number)[] = []
      for (const c of chunk) values.push(c, batchId, position++, userId)
      await conn.execute(
        `INSERT IGNORE INTO sticker_codes (code, batch_id, position, user_id)
         VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}`,
        values
      )
      const [ins] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT code FROM sticker_codes WHERE batch_id = ? AND code IN (${chunk.map(() => '?').join(',')})`,
        [batchId, ...chunk]
      )
      for (const r of ins) codes.add(String(r.code))
    }
    await conn.commit()
    return { batchId }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export interface StickerBatch {
  id: number
  seiten: number
  layout: StickerLayout
  created_at: Date
}

export async function loadBatch(userId: number, batchId: number): Promise<StickerBatch | null> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id, seiten, layout, created_at FROM sticker_batches WHERE id = ? AND user_id = ?',
    [batchId, userId]
  )
  if (!rows[0]) return null
  return { ...(rows[0] as StickerBatch), layout: JSON.parse(rows[0].layout) as StickerLayout }
}

export async function batchCodes(batchId: number): Promise<string[]> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT code FROM sticker_codes WHERE batch_id = ? ORDER BY position',
    [batchId]
  )
  return rows.map((r) => String(r.code))
}

export type LinkResult = 'ok' | 'unbekannt' | 'fremd' | 'vergeben' | 'entwertet' | 'anzeige'

/** Verknüpft einen eigenen, offenen Code mit einer eigenen Anzeige. Atomar über
 *  die WHERE-Bedingung – ein Code kann nur einmal verknüpft werden. */
export async function linkCode(userId: number, code: string, reportId: number): Promise<LinkResult> {
  const [reports] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM reports WHERE id = ? AND user_id = ? AND status <> 'papierkorb'",
    [reportId, userId]
  )
  if (!reports[0]) return 'anzeige'
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE sticker_codes SET report_id = ?, linked_at = NOW()
      WHERE code = ? AND user_id = ? AND linked_at IS NULL AND voided_at IS NULL`,
    [reportId, code, userId]
  )
  if (res.affectedRows === 1) return 'ok'
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT user_id, linked_at, voided_at FROM sticker_codes WHERE code = ?',
    [code]
  )
  const row = rows[0]
  if (!row) return 'unbekannt'
  if (Number(row.user_id) !== userId) return 'fremd'
  if (row.voided_at) return 'entwertet'
  return 'vergeben'
}

export const LINK_MELDUNG: Record<Exclude<LinkResult, 'ok'>, string> = {
  unbekannt: 'Diesen Sticker-Code gibt es nicht. Bitte erneut scannen oder den Code unter dem QR-Code abtippen.',
  fremd: 'Dieser Sticker gehört zu einem anderen Konto.',
  vergeben: 'Dieser Sticker ist bereits mit einer Anzeige verknüpft.',
  entwertet: 'Dieser Sticker wurde entwertet und kann nicht mehr verknüpft werden.',
  anzeige: 'Anzeige nicht gefunden.',
}

/** Verknüpfung lösen – nur kurz nach dem Verknüpfen (Verklicker), danach
 *  klebt der Sticker vermutlich schon und muss stabil bleiben. */
export async function unlinkCode(userId: number, code: string): Promise<boolean> {
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE sticker_codes SET report_id = NULL, linked_at = NULL
      WHERE code = ? AND user_id = ? AND linked_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [code, userId, STICKER_LOESEN_MINUTEN]
  )
  return res.affectedRows === 1
}

/** Alle offenen Codes eines Batches entwerten (verdruckt, verloren, kaputt) –
 *  sonst blockieren sie das Kontingent für immer. */
export async function voidOpenCodes(userId: number, batchId: number): Promise<number> {
  const [res] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE sticker_codes SET voided_at = NOW()
      WHERE batch_id = ? AND user_id = ? AND linked_at IS NULL AND voided_at IS NULL`,
    [batchId, userId]
  )
  return res.affectedRows
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------


// Texte: sachlich, Deutsch groß, Englisch klein darunter. Neutrale Bögen:
// ohne Betrag, weil beim Druck noch kein Verstoß feststeht. Bögen für einen
// bestimmten Verstoß (Fall-Sticker) nennen Tatbestand und Regelsatz, siehe
// fallAbsaetze – immer als Regelsatz laut Katalog, nicht als verhängte Strafe.
// {PFEIL} zeigt auf den QR-Code rechts daneben. Nur WinAnsi-Zeichen (Standard-
// fonts von pdf-lib), daher wird der Pfeil gezeichnet statt als „→" gesetzt.
type Absatz = { de: string; en: string; fett?: boolean }

const ABSAETZE: Absatz[] = [
  {
    de: 'Sie wurden von einer Privatperson wegen Falschparkens angezeigt.',
    en: 'You have been reported for illegal parking by a private person.',
    fett: true,
  },
  {
    de: 'Wenn das Ordnungsamt dem nachgeht, wird ein Verwarnungs- oder Bußgeld fällig.',
    en: 'If the authorities follow up, you will have to pay a fine.',
  },
  {
    de: 'Die Anzeige gegen Sie hier ansehen {PFEIL}',
    en: 'View the report here.',
  },
]

/** Fall-Sticker (Verstoß vorgedruckt): kein Pfeil-Satz mit langem Erklärtext,
 *  dafür Tatbestand + Regelsatz. */
interface Fall {
  aufdruck: string
  tbnr: string
  euro: number | null
}

function fallAbsaetze(fall: Fall): Absatz[] {
  const out: Absatz[] = [
    { de: `Sie wurden von einer Privatperson angezeigt: ${fall.aufdruck}`, en: 'You have been reported by a private person.', fett: true },
  ]
  if (fall.euro !== null) {
    out.push({
      de: `Wenn das Ordnungsamt dem nachgeht, kostet Sie das ${formatEuro(fall.euro)}.`,
      en: `If the authorities follow up, this will cost you ${formatEuro(fall.euro)} (fine catalogue no. ${fall.tbnr}).`,
      fett: true,
    })
  }
  out.push({ de: 'Die Anzeige gegen Sie hier ansehen {PFEIL}', en: 'View the report here.' })
  return out
}

function fallAus(layout: StickerLayout): Fall | null {
  if (!layout.tbnr) return null
  return {
    tbnr: layout.tbnr,
    aufdruck: layout.aufdruck || winAnsi(verstossText(layout.tbnr) || ''),
    euro: regelsatzEuro(layout.tbnr),
  }
}

interface Fonts {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
  mono: PDFFont
}

type Token = { text: string; kind: 'wort' | 'pfeil' }
type Line = { tokens: Token[]; size: number; font: PDFFont; color: number; gapBefore: number }

function tokenWidth(t: Token, font: PDFFont, size: number): number {
  if (t.kind === 'pfeil') return size * 1.3
  return font.widthOfTextAtSize(t.text, size)
}

function tokenize(text: string): Token[] {
  return text.split(' ').map((w) =>
    w === '{PFEIL}' ? { text: '', kind: 'pfeil' } : { text: w, kind: 'wort' }
  )
}

function wrap(tokens: Token[], font: PDFFont, size: number, maxW: number): Token[][] | null {
  const space = font.widthOfTextAtSize(' ', size)
  const lines: Token[][] = []
  let cur: Token[] = []
  let w = 0
  for (const t of tokens) {
    const tw = tokenWidth(t, font, size)
    if (tw > maxW) return null // einzelnes Wort passt nicht: Schrift zu groß
    const nw = cur.length ? w + space + tw : tw
    if (nw > maxW && cur.length) {
      // Der Pfeil steht nie allein am Zeilenanfang: letztes Wort mitnehmen.
      const carry = t.kind === 'pfeil' && cur.length > 1 ? cur.pop()! : null
      lines.push(cur)
      cur = carry ? [carry, t] : [t]
      w = carry ? tokenWidth(carry, font, size) + space + tw : tw
    } else {
      cur.push(t)
      w = nw
    }
  }
  if (cur.length) lines.push(cur)
  return lines
}

/** Größte Schrift, bei der alle Absätze in die Textbox passen. */
function layoutText(absaetze: Absatz[], fonts: Fonts, maxW: number, maxH: number): Line[] {
  for (let de = 12; de >= 4; de -= 0.25) {
    const en = de * 0.74
    const lines: Line[] = []
    let ok = true
    absaetze.forEach((a, i) => {
      if (!ok) return
      const deFont = a.fett ? fonts.bold : fonts.regular
      const deLines = wrap(tokenize(a.de), deFont, de, maxW)
      const enLines = wrap(tokenize(a.en), fonts.italic, en, maxW)
      if (!deLines || !enLines) { ok = false; return }
      deLines.forEach((tokens, j) =>
        lines.push({ tokens, size: de, font: deFont, color: 0, gapBefore: j === 0 && i > 0 ? de * 0.75 : 0 })
      )
      enLines.forEach((tokens, j) =>
        lines.push({ tokens, size: en, font: fonts.italic, color: 0.38, gapBefore: j === 0 ? en * 0.15 : 0 })
      )
    })
    if (!ok) continue
    const h = lines.reduce((s, l) => s + l.gapBefore + l.size * 1.17, 0)
    if (h <= maxH) return lines
  }
  // Absurd kleine Etiketten verhindert parseLayout; hier nur Notnagel.
  return []
}

/** QR-Module als rohe PDF-Operatoren („x y w h re"): ein gemeinsamer
 *  Content-Stream je Seite statt Hunderter drawRectangle-Objekte je Sticker –
 *  sonst brauchen große Batches Minuten und Gigabytes. */
function qrOps(text: string, x: number, y: number, size: number): string {
  // Feste Maske: Die automatische Wahl probiert alle 8 durch und war der
  // größte Zeitfresser bei großen Batches; jede Maske ist gültig und scanbar.
  const qr = qrcodegen.QrCode.encodeSegments(
    [qrcodegen.QrSegment.makeAlphanumeric(text)],
    qrcodegen.QrCode.Ecc.MEDIUM, 1, 40, 0
  )
  const quiet = 2 // Ruhezone in Modulen; Etikettenrand gibt zusätzlich Luft
  const m = size / (qr.size + 2 * quiet)
  const n = (v: number) => v.toFixed(2)
  let ops = ''
  for (let row = 0; row < qr.size; row++) {
    let start = -1
    for (let col = 0; col <= qr.size; col++) {
      const dark = col < qr.size && qr.getModule(col, row)
      if (dark && start < 0) start = col
      if (!dark && start >= 0) {
        // Horizontale Läufe zusammenfassen; +0,01 gegen Haarlinien zwischen
        // Nachbarzeilen in manchen PDF-Viewern.
        ops += `${n(x + (quiet + start) * m)} ${n(y + size - (quiet + row + 1) * m)} ${n((col - start) * m)} ${n(m + 0.01)} re\n`
        start = -1
      }
    }
  }
  return ops
}

/** Kleine Schnittmarken an den vier Ecken, nach außen als Verlängerung der
 *  Etikettenkanten. Sie liegen damit entweder im Zwischenraum oder (bei
 *  Bögen ohne Abstand) genau auf der Schnittlinie des Nachbarn – nie mitten
 *  auf einem Etikett. Als rohe Linien-Operatoren (siehe qrOps). */
function cutMarkOps(x: number, y: number, w: number, h: number): string {
  const len = 2 * MM
  const off = 0.4 * MM // kleine Lücke zur Ecke, damit nichts aufs Etikett ragt
  const n = (v: number) => v.toFixed(2)
  let ops = ''
  for (const [cx, sx] of [[x, -1], [x + w, 1]]) {
    for (const [cy, sy] of [[y, -1], [y + h, 1]]) {
      ops += `${n(cx + sx * off)} ${n(cy)} m ${n(cx + sx * (off + len))} ${n(cy)} l\n`
      ops += `${n(cx)} ${n(cy + sy * off)} m ${n(cx)} ${n(cy + sy * (off + len))} l\n`
    }
  }
  return ops
}

/** Zeilen in eine Box (links oben ab x/top, Höhe boxH) vertikal zentriert setzen. */
function drawLines(page: PDFPage, lines: Line[], textX: number, top: number, boxH: number) {
  const total = lines.reduce((s, l) => s + l.gapBefore + l.size * 1.17, 0)
  let cursor = top - (boxH - total) / 2 // vertikal zentriert
  for (const line of lines) {
    cursor -= line.gapBefore + line.size * 1.17
    const baseline = cursor + line.size * 0.25
    const color = rgb(line.color, line.color, line.color)
    const space = line.font.widthOfTextAtSize(' ', line.size)
    let cx = textX
    line.tokens.forEach((t, i) => {
      if (i > 0) cx += space
      const tw = tokenWidth(t, line.font, line.size)
      if (t.kind === 'wort') {
        page.drawText(t.text, { x: cx, y: baseline, size: line.size, font: line.font, color })
      } else {
        const mid = baseline + line.size * 0.33
        const head = line.size * 0.3
        page.drawLine({ start: { x: cx, y: mid }, end: { x: cx + tw, y: mid }, thickness: line.size * 0.09, color })
        page.drawLine({ start: { x: cx + tw - head, y: mid + head }, end: { x: cx + tw, y: mid }, thickness: line.size * 0.09, color })
        page.drawLine({ start: { x: cx + tw - head, y: mid - head }, end: { x: cx + tw, y: mid }, thickness: line.size * 0.09, color })
      }
      cx += tw
    })
  }
}

async function newDoc(): Promise<{ doc: PDFDocument; fonts: Fonts }> {
  const doc = await PDFDocument.create()
  doc.setTitle('OWiA-Sticker')
  doc.setCreator('OWiA-Anzeiger')
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    mono: await doc.embedFont(StandardFonts.CourierBold),
  }
  return { doc, fonts }
}

/** Druckform eines Batches: alles, was auf jedem Sticker gleich ist, als
 *  eingebettete Seite (Form-XObject, einmal im PDF) plus die Stellen, an die
 *  pro Sticker QR-Code und Code-Text kommen. Maße in pt relativ zur linken
 *  unteren Etikettenecke. */
interface Druckform {
  statisch: PDFEmbeddedPage
  qr: { x: number; y: number; size: number }
  code: { cx: number; y: number; size: number; color: ReturnType<typeof rgb> }
}

function codeLabel(url: string, code: string, muster: boolean): string {
  // Unter dem QR-Code die Adresse zum Abtippen, z. B. „owia.net/S/7KQ2-XM9P"
  // (/S/ nimmt auch Kleinbuchstaben und Bindestrich, siehe normalizeCode).
  const host = url.replace(/^HTTPS?:\/\//i, '').split('/')[0].toLowerCase()
  return `${host}/S/${muster ? 'MUSTER' : formatCode(code)}`
}

// Die Vorlage wird gespeichert und als Bytes eingebettet: pdf-lib schreibt
// Schriften erst beim Speichern, ein direkt eingebettetes Dokument hätte
// leere Font-Verweise.
async function druckform(doc: PDFDocument, fonts: Fonts, layout: StickerLayout, baseUrl: string, muster: boolean): Promise<Druckform> {
  const w = layout.labelW * MM
  const h = layout.labelH * MM
  const tplDoc = await PDFDocument.create()
  const page = tplDoc.addPage([w, h])
  const beispiel = codeLabel(stickerUrl(baseUrl, 'XXXXXXXX'), 'XXXXXXXX', muster)
  const e = findeEntwurf(layout.entwurf)

  if (e) {
    const satzFonts = await embedSatzFonts(tplDoc)
    const tb = entwurfTbnr(e, layout.tbnr)
    const euro = tb ? regelsatzEuro(tb) : null
    const satz = setze(e, layout.labelW, layout.labelH, {
      betrag: euro === null ? '' : formatEuro(euro), codeLabel: beispiel, fonts: satzFonts,
    })
    zeichnePdf(page, satzFonts, satz.items, 0, h)
    const c = parseInt(satz.code.color.slice(1), 16)
    const [statisch] = await doc.embedPdf(await tplDoc.save(), [0])
    return {
      statisch,
      qr: { x: satz.qr.x * MM, y: h - (satz.qr.y + satz.qr.size) * MM, size: satz.qr.size * MM },
      code: { cx: satz.code.cx * MM, y: h - satz.code.y * MM, size: satz.code.size * MM, color: rgb(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255) },
    }
  }

  // Klassischer Text: links Absätze, rechts QR-Code. Keine Felder zum
  // Ausfüllen: alles Nötige steht vorgedruckt bzw. hinter dem QR-Code.
  const tplFonts: Fonts = {
    regular: await tplDoc.embedFont(StandardFonts.Helvetica),
    bold: await tplDoc.embedFont(StandardFonts.HelveticaBold),
    italic: await tplDoc.embedFont(StandardFonts.HelveticaOblique),
    mono: await tplDoc.embedFont(StandardFonts.CourierBold),
  }
  const pad = Math.min(w, h) * 0.08
  const codeSize = Math.max(6, Math.min(9, h * 0.06))
  const qrSize = Math.min(h - 2 * pad - codeSize * 1.4, w * 0.42)
  const qrX = w - pad - qrSize
  // Adresse darf links und rechts etwas über den QR-Code hinausragen.
  const labelMaxW = qrSize + pad * 1.4
  const labelSize = Math.min(codeSize, codeSize * labelMaxW / fonts.mono.widthOfTextAtSize(beispiel, codeSize))
  const fall = fallAus(layout)
  const absaetze = fall ? fallAbsaetze(fall) : ABSAETZE
  drawLines(page, layoutText(absaetze, tplFonts, qrX - pad * 1.8, h - 2 * pad), pad, h - pad, h - 2 * pad)
  const [statisch] = await doc.embedPdf(await tplDoc.save(), [0])
  return {
    statisch,
    qr: { x: qrX, y: pad + codeSize * 1.4, size: qrSize },
    code: { cx: qrX + qrSize / 2, y: pad, size: labelSize, color: rgb(0.2, 0.2, 0.2) },
  }
}

/** Position eines Etiketts (Index auf der Seite) in PDF-Koordinaten (pt, unten links). */
function labelBox(layout: StickerLayout, index: number) {
  const col = index % layout.cols
  const row = Math.floor(index / layout.cols)
  const left = layout.marginLeft + col * (layout.labelW + layout.gapX) + layout.dx
  const top = layout.marginTop + row * (layout.labelH + layout.gapY) + layout.dy
  return {
    x: left * MM,
    y: (A4_H - top - layout.labelH) * MM,
    w: layout.labelW * MM,
    h: layout.labelH * MM,
  }
}

async function renderSheets(codes: string[], layout: StickerLayout, baseUrl: string, muster: boolean, rahmen: boolean): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc()
  const form = await druckform(doc, fonts, layout, baseUrl, muster)
  const n = perPage(layout)
  for (let p = 0; p * n < codes.length; p++) {
    const page = doc.addPage([A4_W * MM, A4_H * MM])
    let ops = ''
    let linien = ''
    codes.slice(p * n, (p + 1) * n).forEach((code, i) => {
      const b = labelBox(layout, i)
      page.drawPage(form.statisch, { x: b.x, y: b.y })
      linien += rahmen
        ? `${b.x.toFixed(2)} ${b.y.toFixed(2)} ${b.w.toFixed(2)} ${b.h.toFixed(2)} re\n`
        : cutMarkOps(b.x, b.y, b.w, b.h)
      const label = codeLabel(stickerUrl(baseUrl, code), code, muster)
      const lw = fonts.mono.widthOfTextAtSize(label, form.code.size)
      page.drawText(label, { x: b.x + form.code.cx - lw / 2, y: b.y + form.code.y, size: form.code.size, font: fonts.mono, color: form.code.color })
      ops += qrOps(stickerUrl(baseUrl, code), b.x + form.qr.x, b.y + form.qr.y, form.qr.size)
    })
    // QR-Module zuletzt: liegen damit über der Druckform (dort ist das Feld weiß).
    const grau = rahmen ? '0.7 0.7 0.7 RG 0.4 w' : '0.55 0.55 0.55 RG 0.3 w'
    const stream = doc.context.flateStream(`q 0 0 0 rg\n${ops}f\n${grau}\n${linien}S\nQ\n`)
    page.node.addContentStream(doc.context.register(stream))
  }
  return doc.save()
}

export async function renderBatchPdf(codes: string[], layout: StickerLayout, baseUrl: string): Promise<Uint8Array> {
  return renderSheets(codes, layout, baseUrl, false, layout.rahmen)
}

/** Testseite auf Normalpapier: alle Etikettenränder + Muster-Sticker. Gegen
 *  einen leeren Etikettenbogen ins Licht halten, dann Druckversatz anpassen. */
export async function renderCalibrationPdf(layout: StickerLayout, baseUrl: string): Promise<Uint8Array> {
  return renderSheets(Array(perPage(layout)).fill(MUSTER_CODE), layout, baseUrl, true, true)
}

// ---------------------------------------------------------------------------
// Vorschau (SVG) der Textvorlagen – /sticker und /sticker-test
// ---------------------------------------------------------------------------

/** QR-Module als SVG-Pfad (Einheit = Modul), Maske wie im Druck. */
export function qrModulPfad(text: string): { size: number; d: string } {
  const qr = qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeAlphanumeric(text)], qrcodegen.QrCode.Ecc.MEDIUM, 1, 40, 0)
  let d = ''
  for (let y = 0; y < qr.size; y++) {
    let x = 0
    while (x < qr.size) {
      if (!qr.getModule(x, y)) { x++; continue }
      const start = x
      while (x < qr.size && qr.getModule(x, y)) x++
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`
    }
  }
  return { size: qr.size, d }
}

/** Eine Textvorlage als SVG mit Muster-Code; Betrag aus tbnr (fester
 *  Tatbestand der Vorlage geht vor). */
export async function entwurfSvg(e: Entwurf, w: number, h: number, tbnr: string | null, baseUrl: string): Promise<string> {
  const fonts = await satzFonts()
  const tb = entwurfTbnr(e, tbnr)
  const euro = tb ? regelsatzEuro(tb) : null
  const url = stickerUrl(baseUrl, MUSTER_CODE)
  const label = codeLabel(url, MUSTER_CODE, true)
  const satz = setze(e, w, h, { betrag: euro === null ? '' : formatEuro(euro), codeLabel: label, fonts })
  return svgVon(satz, w, h, qrModulPfad(url), label, fonts, e.name)
}

/** Vorschau für ein Formular-Layout; null bei klassischem Text. */
export async function vorschauSvg(layout: StickerLayout, baseUrl: string): Promise<string | null> {
  const e = findeEntwurf(layout.entwurf)
  return e ? entwurfSvg(e, layout.labelW, layout.labelH, layout.tbnr ?? null, baseUrl) : null
}

/** Favorisierte Textvorlagen eines Nutzers (/sticker-test). */
export async function entwurfFavoriten(userId: number): Promise<Set<string>> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT slug FROM sticker_entwurf_favoriten WHERE user_id = ?', [userId]
  )
  return new Set(rows.map((r) => String(r.slug)))
}
