import path from 'path'
import nodemailer from 'nodemailer'
import mysql from 'mysql2/promise'
import { getCity } from '../config/cities'
import { formatEuro } from '../config/credits'

/** Daten für die Rechnung einer bestätigten Guthabenaufladung. */
export type DepositInvoiceData = {
  amountCents: number
  method: string
  reference: string
  paymentReference: string
  invoiceNumber: string
}

function methodLabel(method: string): string {
  return method === 'paypal' ? 'PayPal' : 'Überweisung'
}

function escapeHtml(s: string): string {
  return String(s || '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

function createTransport() {
  if (process.env.MAIL_DRIVER === 'smtp') {
    return nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT) || 587,
      auth: process.env.MAIL_USER
        ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
        : undefined,
    })
  }
  // mailpit (dev default)
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'mail',
    port: 1025,
    ignoreTLS: true,
  })
}

/** Betreff + Text der Anzeige-E-Mail. Wird für den echten Versand und als
 *  Beispieltext für den Selbst-Versand auf der Detailseite verwendet. */
export function buildReportMail(
  report: mysql.RowDataPacket,
  user: mysql.RowDataPacket
): { subject: string; text: string } {
  const tattag = report.tattag
    ? new Date(report.tattag).toLocaleDateString('de-DE')
    : 'unbekannt'
  const von = report.tatzeit_von ? String(report.tatzeit_von).slice(0, 5) : ''
  const bis = report.tatzeit_bis ? String(report.tatzeit_bis).slice(0, 5) : ''
  const tatzeit = von && bis ? `${von} – ${bis} Uhr` : von ? `${von} Uhr` : bis ? `${bis} Uhr` : ''

  const az = report.aktenzeichen ? ` (${report.aktenzeichen})` : ''
  const subject = `Anzeige Ordnungswidrigkeit – Kfz ${report.kennzeichen}${az}`
  const text = [
    'Sehr geehrte Damen und Herren,',
    '',
    'hiermit erstatte ich Anzeige wegen folgender Ordnungswidrigkeit:',
    '',
    report.aktenzeichen ? `Aktenzeichen: ${report.aktenzeichen}` : '',
    `Kennzeichen:  ${report.kennzeichen}`,
    `Fahrzeug:     ${report.fahrzeug_marke || '—'}`,
    `Tattag:       ${tattag}`,
    `Tatzeit:      ${tatzeit || '—'}`,
    `Tatort:       ${report.tatort}`,
    `Verstoß:      ${report.verstoss_art}`,
    report.beschreibung ? `Beschreibung: ${report.beschreibung}` : '',
    '',
    'Das ausgefüllte Formular finden Sie im Anhang.',
    '',
    'Mit freundlichen Grüßen',
    [user.vorname, user.nachname].filter(Boolean).join(' ') || user.email,
  ]
    .filter((line) => line !== undefined)
    .join('\n')

  return { subject, text }
}

/** Betreff, Text und HTML der Rechnung für eine bestätigte Guthabenaufladung. */
export function buildDepositInvoice(
  user: mysql.RowDataPacket,
  data: DepositInvoiceData
): { subject: string; text: string; html: string } {
  const betrag = formatEuro(data.amountCents)
  const datum = new Date().toLocaleDateString('de-DE')
  const name = [user.vorname, user.nachname].filter(Boolean).join(' ') || user.email
  const anschrift = [user.strasse, [user.plz, user.ort].filter(Boolean).join(' ')].filter(Boolean)

  const subject = `Rechnung ${data.invoiceNumber} – Guthabenaufladung OWiA-Anzeiger`
  const text = [
    `Rechnung ${data.invoiceNumber}`,
    `Rechnungsdatum: ${datum}`,
    '',
    'Rechnungsempfänger:',
    name,
    ...anschrift,
    '',
    'Position:',
    `  Guthabenaufladung OWiA-Anzeiger .......... ${betrag}`,
    '',
    `Zahlart:          ${methodLabel(data.method)}`,
    `Verwendungszweck: ${data.reference}`,
    data.paymentReference ? `Zahlungsreferenz: ${data.paymentReference}` : undefined,
    '',
    `Gesamtbetrag: ${betrag}`,
    '',
    'Der Betrag wurde deinem Guthaben gutgeschrieben und steht sofort zur Verfügung.',
    '',
    'Mit freundlichen Grüßen',
    'OWiA-Anzeiger',
  ]
    .filter((line) => line !== undefined)
    .join('\n')

  const html = [
    `<h2>Rechnung ${data.invoiceNumber}</h2>`,
    `<p style="color:#666;">Rechnungsdatum: ${datum}</p>`,
    `<p><strong>${escapeHtml(name)}</strong>${
      anschrift.length ? '<br>' + anschrift.map(escapeHtml).join('<br>') : ''
    }</p>`,
    '<table cellpadding="6" style="border-collapse:collapse;">',
    `<tr><td>Guthabenaufladung OWiA-Anzeiger</td><td style="text-align:right;">${betrag}</td></tr>`,
    `<tr><td><strong>Gesamtbetrag</strong></td><td style="text-align:right;"><strong>${betrag}</strong></td></tr>`,
    '</table>',
    `<p style="color:#666;font-size:13px;">Zahlart: ${methodLabel(data.method)}<br>Verwendungszweck: ${escapeHtml(
      data.reference
    )}${data.paymentReference ? '<br>Zahlungsreferenz: ' + escapeHtml(data.paymentReference) : ''}</p>`,
    '<p>Der Betrag wurde deinem Guthaben gutgeschrieben und steht sofort zur Verfügung.</p>',
    '<p>Mit freundlichen Grüßen<br>OWiA-Anzeiger</p>',
  ].join('\n')

  return { subject, text, html }
}

export const MailService = {
  async sendLoginCode(
    email: string,
    code: string,
    magicLink: string
  ): Promise<void> {
    const transport = createTransport()
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: email,
      subject: `Dein Anmeldecode: ${code}`,
      text: [
        'Hallo,',
        '',
        'mit folgendem Code kannst du dich anmelden:',
        '',
        `    ${code}`,
        '',
        'Oder klick einfach auf diesen Link, um dich direkt anzumelden:',
        '',
        magicLink,
        '',
        'Der Code und der Link sind 15 Minuten gültig.',
        'Wenn du diese Anmeldung nicht angefordert hast, ignoriere diese E-Mail.',
        '',
        'Mit freundlichen Grüßen',
        'OWiA-Anzeiger',
      ].join('\n'),
      html: [
        '<p>Hallo,</p>',
        '<p>mit folgendem Code kannst du dich anmelden:</p>',
        `<p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p>`,
        '<p>Oder klick einfach auf diesen Button, um dich direkt anzumelden:</p>',
        `<p><a href="${magicLink}" style="display:inline-block;padding:10px 18px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:6px;">Jetzt anmelden</a></p>`,
        `<p style="color:#666;font-size:13px;">Der Code und der Link sind 15 Minuten gültig. Wenn du diese Anmeldung nicht angefordert hast, ignoriere diese E-Mail.</p>`,
        '<p>Mit freundlichen Grüßen<br>OWiA-Anzeiger</p>',
      ].join('\n'),
    })
  },

  async sendReport(
    report: mysql.RowDataPacket,
    user: mysql.RowDataPacket
  ): Promise<void> {
    const transport = createTransport()
    const pdfPath = path.join(
      process.cwd(),
      'data/pdfs',
      String(user.id),
      report.pdf_filename
    )

    const { subject, text } = buildReportMail(report, user)

    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: getCity(report.city).email,
      cc: user.email,
      subject,
      text,
      attachments: [
        {
          filename: `anzeige-${report.id}.pdf`,
          path: pdfPath,
          contentType: 'application/pdf',
        },
      ],
    })
  },

  /** Rechnung/Zahlungsbestätigung an den Nutzer, nachdem ein Admin die Einzahlung bestätigt hat. */
  async sendDepositInvoice(user: mysql.RowDataPacket, data: DepositInvoiceData): Promise<void> {
    const transport = createTransport()
    const { subject, text, html } = buildDepositInvoice(user, data)
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: user.email,
      subject,
      text,
      html,
    })
  },
}
