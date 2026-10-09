import { FastifyInstance, FastifyRequest } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { viewData } from '../middleware/auth'
import { qrcodegen } from '../vendor/qrcodegen'
import { formatEuro, stickerUrl } from '../services/stickers'
import { regelsatzEuro } from '../config/verstoss'

// Textentwürfe für die Sticker (nur Ansicht – gedruckt wird weiter über
// /sticker bzw. services/stickers.ts). Öffentlich wie /logos, aber per
// robots.txt („Disallow: /") ausgenommen. Angemeldete Nutzer können Entwürfe
// als Favorit markieren (Tabelle sticker_entwurf_favoriten); Favoriten stehen
// oben.
//
// Der QR-Code ist echt und zeigt auf den Muster-Code der Kalibrierseite
// (MUSTER00 kann nie ein echter Code sein, siehe stickers.ts). Beträge sind
// Regelsätze aus resources/bussgelder.csv, damit die Beispiele stimmen.
//
// Die Nummer eines Entwurfs ist seine Position hier, das Markup steht unter
// demselben Slug in views/public/sticker-test.ejs. Favoriten hängen am Slug:
// neue Entwürfe nur hinten anfügen, Slugs nie umbenennen.
const ENTWUERFE: Array<[slug: string, name: string, idee: string]> = [
  ['sachlich-ordnungsamt', 'Sachlich – Ordnungsamt', 'Ihr Wortlaut, ruhig gesetzt. Betrag als einzige Farbfläche.'],
  ['sachlich-polizei', 'Sachlich – Verkehrspolizei', 'Ihr erster Wortlaut. Nur für Städte, in denen die Polizei den ruhenden Verkehr verfolgt.'],
  ['preis-zuerst', 'Der Preis zuerst', 'Der Betrag ist das, was auf zwei Meter Abstand gelesen wird.'],
  ['stempel', 'Stempel', 'Ein Wort, schräg gestempelt. Tatbestand und Regelsatz klein darunter.'],
  ['warnband', 'Warnband', 'Absperrband-Rahmen: fällt auf der Scheibe sofort auf.'],
  ['beleg', 'Beleg', 'Wie ein Kassenbon – und ausdrücklich keine amtliche Mitteilung.'],
  ['vorwarnung', 'Freundliche Vorwarnung', 'Gleicher Inhalt, aber als Info „bevor Post kommt“ – nimmt Ärger raus.'],
  ['kinderwagen', 'Gehweg – Kinderwagen', 'Begründet die Anzeige mit den Betroffenen statt mit der Regel.'],
  ['radweg', 'Radweg', 'Dunkler Sticker, eine klare Aussage in Gelb.'],
  ['feuerwehr', 'Feuerwehrzufahrt', 'Kopfband nennt den Ort, die Zeile darunter das Warum.'],
  ['checkliste', 'Checkliste', 'Zwei Haken gesetzt, der dritte liegt beim Amt.'],
  ['ablauf', 'Ablauf in 3 Schritten', 'Erklärt nüchtern, was als Nächstes passiert.'],
  ['zweisprachig', 'Zweisprachig DE/EN', 'Für Touristen, Mietwagen, Lieferfahrer: beide Sprachen gleich groß.'],
  ['minimal', 'Minimal', 'Kürzeste Fassung – trägt auch auf 70 × 37 mm.'],
  ['kein-knoellchen', 'Kein Knöllchen', 'Stellt klar, dass der Zettel nicht vom Amt ist – schützt vor dem Vorwurf, ein Knöllchen vorzutäuschen.'],
  ['wussten-sie', 'Wussten Sie …?', 'Frage als Einstieg, Antwort gleich hinterher.'],
  ['teurer-parkplatz', 'Teurer Parkplatz', 'Vollflächig gelb, zwei Wörter Schlagzeile.'],
  ['naechstes-mal', 'Nächstes Mal', 'Blick nach vorn statt Vorwurf.'],
  ['datenschutz', 'Datenschutz-Hinweis', 'Beantwortet die erste Sorge beim Scannen: Steht mein Kennzeichen im Netz?'],
  ['qr-mitte', 'QR im Mittelpunkt', 'Großer Code links: lädt zum Scannen ein, Text erklärt warum.'],
  // 21–50
  ['dokumentiert', 'Fahrzeug dokumentiert', 'Passt zum heutigen Ablauf: Der Sticker klebt oft, bevor die Anzeige abgeschickt ist.'],
  ['wird-angezeigt', 'Wird angezeigt', 'Zukunftsform – ehrlich, solange die Anzeige noch nicht raus ist.'],
  ['zustaendige-behoerde', 'Zuständige Behörde', 'Ein Text für alle Städte: kein Ordnungsamt/Polizei-Unterschied.'],
  ['schwarzweiss', 'Schwarzweiß-Druck', 'Ohne Gelb – sieht auch aus dem Laserdrucker sauber aus.'],
  ['halteverbot', 'Absolutes Halteverbot', 'Erklärt das Schild gleich mit.'],
  ['schwerbehinderte', 'Schwerbehindertenparkplatz', 'Ruhig im Ton, deutlich in der Sache.'],
  ['haltestelle', 'Bushaltestelle', 'Kurz, mit einem Augenzwinkern.'],
  ['zebrastreifen', 'Zebrastreifen', 'Sichtachse für Kinder als Begründung.'],
  ['kreuzung', '5 Meter vor der Kreuzung', 'Kleiner Betrag, großer Grund – ehrlich mit 10 €.'],
  ['rollstuhl', 'Rollstuhl', 'Wer hier nicht durchkommt, mit Piktogramm.'],
  ['schulweg', 'Schulweg', 'Für Gehwege an Schulen und Kitas.'],
  ['fussgaenger-icon', 'Fußgänger-Piktogramm', 'Großes Piktogramm links, Text rechts, QR klein.'],
  ['fahrrad-icon', 'Fahrrad-Piktogramm', 'Wie 32, für Radwege.'],
  ['ausrufezeichen', 'Ausrufezeichen', 'Gelber Block mit „!“ – Warnschild-Logik.'],
  ['brief', 'Brief', 'Höfliche Anrede und Gruß – wie eine kurze Nachricht.'],
  ['nicht-persoenlich', 'Nicht persönlich gemeint', 'Nimmt die Kränkung raus, ohne die Anzeige zu relativieren.'],
  ['wer-wo-wie', 'Wer? Wo? Wie teuer?', 'Drei Fragen, drei kurze Antworten.'],
  ['rechnung', 'Kleine Rechnung', 'Parkhaus gegen Gehweg – ohne erfundene Parkhauspreise.'],
  ['drei-akte', 'Drei Akte', 'Sie · eine Privatperson · das Amt – je eine Zeile.'],
  ['paragraf', 'Paragraf', 'Großes § mit Fundstelle – für Sachliche.'],
  ['ampel', 'Ampel', 'Zwei Punkte grün, einer offen.'],
  ['sprechblase', 'Sprechblase', '„Nur kurz“ – und die Antwort darauf.'],
  ['kurz-geparkt', 'Kurz geparkt', 'Vier Wörter Schlagzeile, Rest klein.'],
  ['preis-dunkel', 'Preis dunkel', 'Wie 3, invertiert: gelber Betrag auf Schwarz.'],
  ['abriss', 'Abriss-Ticket', 'Ticket-Optik mit Abrissrand und Code-Abschnitt.'],
  ['einzeiler', 'Einzeiler', '„Angezeigt · 55 €“ – für sehr kleine Etiketten.'],
  ['dreisprachig', 'Dreisprachig DE/EN/FR', 'Für Grenzregionen und Touristenviertel.'],
  ['gehweg-fuer-alle', 'Gehweg für alle', 'Positive Botschaft vorn, Anzeige danach.'],
  ['zeitung', 'Schlagzeile', 'Zeitungs-Optik mit Serifenschrift.'],
  ['ruhig-grau', 'Leise', 'Kein Gelb, kein Fett – für alle, die es dezent mögen.'],
]
const SLUGS = new Set(ENTWUERFE.map(([slug]) => slug))

function baseUrl(request: FastifyRequest): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '')
  return `${request.protocol}://${request.headers.host}`
}

/** QR als SVG-Pfad (Module in Pfad-Einheiten, Läufe je Zeile zusammengefasst). */
function qrPath(text: string): { size: number; d: string } {
  const qr = qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeAlphanumeric(text)], qrcodegen.QrCode.Ecc.MEDIUM)
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

function euro(tbnr: string, fallback: number): string {
  return formatEuro(regelsatzEuro(tbnr) ?? fallback)
}

async function favoritenVon(userId: number): Promise<Set<string>> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT slug FROM sticker_entwurf_favoriten WHERE user_id = ?', [userId]
  )
  return new Set(rows.map((r) => String(r.slug)))
}

export default async function stickerTestRoutes(app: FastifyInstance) {
  app.get('/sticker-test', async (request, reply) => {
    const base = baseUrl(request)
    const qr = qrPath(stickerUrl(base, 'MUSTER00'))
    const host = base.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()
    const userId = request.session.userId
    const favoriten = userId ? await favoritenVon(userId) : new Set<string>()
    const entwuerfe = ENTWUERFE.map(([slug, name, idee], i) => ({ nr: i + 1, slug, name, idee, favorit: favoriten.has(slug) }))
    return reply.view('/public/sticker-test.ejs', viewData(request, {
      title: 'Sticker-Entwürfe',
      wide: true,
      qr,
      codeLabel: `${host}/S/MUSTER`,
      angemeldet: Boolean(userId),
      favoriten: entwuerfe.filter((e) => e.favorit),
      andere: entwuerfe.filter((e) => !e.favorit),
      betrag: {
        gehweg: euro('112454', 55),
        radweg: euro('112474', 55),
        feuerwehr: euro('112216', 55),
        halteverbot: euro('141312', 25),
        schwerbehinderte: euro('142278', 55),
        haltestelle: euro('141402', 55),
        zebrastreifen: euro('141302', 25),
        kreuzung: euro('112262', 10),
      },
    }))
  })

  // Favorit an/aus. Formular ohne JS; zurück zur Karte des Entwurfs.
  app.post('/sticker-test/favorit', async (request, reply) => {
    const userId = request.session.userId
    if (!userId) return reply.redirect('/login?weiter=/sticker-test')
    const slug = String((request.body as { slug?: string } | undefined)?.slug || '')
    if (!SLUGS.has(slug)) return reply.status(400).send('Unbekannter Entwurf.')
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      'DELETE FROM sticker_entwurf_favoriten WHERE user_id = ? AND slug = ?', [userId, slug]
    )
    if (res.affectedRows === 0) {
      await pool.execute('INSERT IGNORE INTO sticker_entwurf_favoriten (user_id, slug) VALUES (?, ?)', [userId, slug])
    }
    return reply.redirect(`/sticker-test#${slug}`)
  })
}
