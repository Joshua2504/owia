import { FastifyInstance, FastifyRequest } from 'fastify'
import { viewData } from '../middleware/auth'
import { qrcodegen } from '../vendor/qrcodegen'
import { formatEuro, stickerUrl } from '../services/stickers'
import { regelsatzEuro } from '../config/verstoss'

// Textentwürfe für die Sticker (20 Varianten, nur Ansicht – gedruckt wird
// weiter über /sticker bzw. services/stickers.ts). Öffentlich wie /logos,
// aber per robots.txt („Disallow: /") ausgenommen.
//
// Der QR-Code ist echt und zeigt auf den Muster-Code der Kalibrierseite
// (MUSTER00 kann nie ein echter Code sein, siehe stickers.ts). Beträge sind
// Regelsätze aus resources/bussgelder.csv, damit die Beispiele stimmen.

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

export default async function stickerTestRoutes(app: FastifyInstance) {
  app.get('/sticker-test', async (request, reply) => {
    const base = baseUrl(request)
    const qr = qrPath(stickerUrl(base, 'MUSTER00'))
    const host = base.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()
    return reply.view('/public/sticker-test.ejs', viewData(request, {
      title: 'Sticker-Entwürfe',
      wide: true,
      qr,
      codeLabel: `${host}/S/MUSTER`,
      betrag: {
        gehweg: euro('112454', 55),
        radweg: euro('112474', 55),
        feuerwehr: euro('112216', 55),
      },
    }))
  })
}
