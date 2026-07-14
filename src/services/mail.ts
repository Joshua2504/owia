import path from 'path'
import nodemailer from 'nodemailer'
import mysql from 'mysql2/promise'
import { getCity } from '../config/cities'

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
    `Kennzeichen:  ${report.kennzeichen}${
      report.kennzeichen_land && report.kennzeichen_land !== 'D' ? ` (${report.kennzeichen_land})` : ''
    }`,
    `Fahrzeug:     ${report.fahrzeug_marke || '—'}`,
    `Tattag:       ${tattag}`,
    `Tatzeit:      ${tatzeit || '—'}`,
    `Tatort:       ${report.tatort}`,
    `Verstoß:      ${report.verstoss_art}`,
    report.fahrzeug_verlassen === 1 ? 'Das Fahrzeug war verlassen.' : undefined,
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

  /** Anzeige ans Ordnungsamt senden; gibt Message-ID + Betreff/Text zurück
   *  (Message-ID für die Zuordnung späterer Antworten, Betreff/Text für den
   *  Nachrichtenverlauf auf der Detailseite). */
  async sendReport(
    report: mysql.RowDataPacket,
    user: mysql.RowDataPacket
  ): Promise<{ messageId: string; subject: string; text: string }> {
    const transport = createTransport()
    const pdfPath = path.join(
      process.cwd(),
      'data/pdfs',
      String(user.id),
      report.pdf_filename
    )

    const { subject, text } = buildReportMail(report, user)

    const info = await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: getCity(report.city).email,
      cc: user.email,
      subject,
      text,
      attachments: [
        {
          filename: report.pdf_filename,
          path: pdfPath,
          contentType: 'application/pdf',
        },
      ],
    })
    return { messageId: String(info.messageId || ''), subject, text }
  },

  /** Nachricht des Nutzers ans Ordnungsamt (Antwort auf eine Rückfrage o.Ä.).
   *  Threading-Header sorgen dafür, dass die Mail beim Amt im selben Verlauf
   *  landet und deren Antworten wieder zugeordnet werden können. */
  async sendUserReply(
    report: mysql.RowDataPacket,
    user: mysql.RowDataPacket,
    text: string,
    thread: { inReplyTo?: string | null; references?: string[] }
  ): Promise<{ messageId: string; subject: string }> {
    const transport = createTransport()
    const subject = `Re: Anzeige Ordnungswidrigkeit – Kfz ${report.kennzeichen} (${report.aktenzeichen})`
    const info = await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: getCity(report.city).email,
      cc: user.email,
      subject,
      text,
      inReplyTo: thread.inReplyTo || undefined,
      references: thread.references?.length ? thread.references : undefined,
    })
    return { messageId: String(info.messageId || ''), subject }
  },

  /** Kurzer Hinweis an den Nutzer: das Ordnungsamt hat geantwortet. Der
   *  Inhalt steht bewusst nur in der App (Detailseite), nicht in der Mail. */
  async sendReplyNotification(
    user: mysql.RowDataPacket,
    report: mysql.RowDataPacket
  ): Promise<void> {
    const transport = createTransport()
    const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: user.email,
      subject: `Antwort zu deiner Anzeige ${report.aktenzeichen}`,
      text: [
        'Hallo,',
        '',
        `zu deiner Anzeige ${report.aktenzeichen} ist eine Antwort des Ordnungsamts eingegangen.`,
        '',
        'Du kannst sie hier lesen:',
        `${base}/anzeige/${report.aktenzeichen}`,
        '',
        'Viele Grüße',
        'OWiA-Anzeiger',
      ].join('\n'),
    })
  },

  /** Bestätigungslink für eine E-Mail-Adressänderung (geht an die NEUE Adresse). */
  async sendEmailChangeConfirmation(newEmail: string, link: string): Promise<void> {
    const transport = createTransport()
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: newEmail,
      subject: 'Neue E-Mail-Adresse bestätigen',
      text: [
        'Hallo,',
        '',
        'für dein OWiA-Anzeiger-Konto wurde diese E-Mail-Adresse als neue',
        'Anmelde-Adresse angegeben. Klicke zum Bestätigen auf diesen Link:',
        '',
        link,
        '',
        'Der Link ist 1 Stunde gültig. Wenn du das nicht warst, ignoriere diese E-Mail.',
        '',
        'Viele Grüße',
        'OWiA-Anzeiger',
      ].join('\n'),
    })
  },

  /** Hinweis an die Admins: eine neue Anzeige wartet auf Prüfung. */
  async sendSubmitNotification(
    adminAddresses: string[],
    report: mysql.RowDataPacket,
    userEmail: string
  ): Promise<void> {
    if (!adminAddresses.length) return
    const transport = createTransport()
    const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: adminAddresses.join(','),
      subject: `Neue Anzeige zur Prüfung: ${report.aktenzeichen}`,
      text: [
        `Anzeige ${report.aktenzeichen} wurde von ${userEmail} eingereicht.`,
        '',
        `Verstoß: ${report.verstoss_art || '—'}`,
        `Tatort:  ${report.tatort || '—'}`,
        '',
        `Zur Prüfung: ${base}/admin/anzeigen`,
      ].join('\n'),
    })
  },

  /** Info an den Nutzer: die Prüfung hat die Anzeige zurück in den Entwurf gegeben. */
  async sendReportRejected(
    user: mysql.RowDataPacket,
    report: mysql.RowDataPacket,
    grund: string
  ): Promise<void> {
    const transport = createTransport()
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: user.email,
      subject: `Anzeige ${report.aktenzeichen}: Rückfrage aus der Prüfung`,
      text: [
        'Hallo,',
        '',
        `deine Anzeige ${report.aktenzeichen} wurde bei der Prüfung nicht freigegeben:`,
        '',
        grund,
        '',
        'Die Anzeige ist wieder ein Entwurf – bitte passe sie an und reiche sie erneut ein.',
        '',
        'Viele Grüße',
        'OWiA-Anzeiger',
      ].join('\n'),
    })
  },
}
