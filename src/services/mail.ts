import path from 'path'
import fs from 'fs/promises'
import nodemailer from 'nodemailer'
import mysql from 'mysql2/promise'
import { getCity, hasPdfForm } from '../config/cities'
import { pool } from '../db/connection'
import { reportDir } from './drafts'
import { cachedMailVariant, jpegFassung, readOrientation } from './pixelate'
import { renderTatortMap } from './staticmap'
import { recipientEmailForReport } from './districts'
import type { PreparedReportMail } from './reportDispatch'
import { assertProductionMailConfig } from '../config/mail'
import { adminEmails } from '../config/admin'
import { strasseMitNummer } from '../config/person'
import { fahrzeugBeschreibung } from '../config/fahrzeug'

function createTransport() {
  assertProductionMailConfig()
  if (process.env.MAIL_DRIVER === 'smtp') {
    const port = Number(process.env.MAIL_PORT) || 587
    return nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port,
      // Port 465 = SMTPS (TLS ab Verbindungsaufbau); ohne secure:true wartet
      // nodemailer dort vergeblich auf ein Klartext-Greeting (Timeout).
      secure: port === 465,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
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

/** Tattag und Tatzeit deutsch formatiert – gemeinsam genutzt von der Anzeige-Mail
 *  ans Amt und der Prüf-Benachrichtigung an die Admins. */
function formatTatzeit(report: mysql.RowDataPacket): { tattag: string; tatzeit: string } {
  const tattagVon = report.tattag
    ? new Date(report.tattag).toLocaleDateString('de-DE')
    : 'unbekannt'
  const tattagBis = report.tattag_bis
    ? new Date(report.tattag_bis).toLocaleDateString('de-DE')
    : ''
  // Tatzeitraum über Mitternacht: Tattag als Datumsbereich ausgeben.
  const tattag = tattagBis && tattagBis !== tattagVon ? `${tattagVon} – ${tattagBis}` : tattagVon
  const von = report.tatzeit_von ? String(report.tatzeit_von).slice(0, 5) : ''
  const bis = report.tatzeit_bis ? String(report.tatzeit_bis).slice(0, 5) : ''
  const tatzeit = von && bis ? `${von} – ${bis} Uhr` : von ? `${von} Uhr` : bis ? `${bis} Uhr` : ''
  return { tattag, tatzeit }
}

/** Absender für Mails ans Amt: Name des erstattenden Nutzers statt App-Name. */
function userFrom(user: mysql.RowDataPacket): { name: string; address: string } {
  const name = [user.vorname, user.nachname].filter(Boolean).join(' ').trim()
  return { name: name || process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger', address: process.env.MAIL_FROM || '' }
}

/** Betreff + Text der Anzeige-E-Mail. Wird für den echten Versand und als
 *  Beispieltext für den Selbst-Versand auf der Detailseite verwendet. */
export function buildReportMail(
  report: mysql.RowDataPacket,
  user: mysql.RowDataPacket,
  photoLines: string[] = []
): { subject: string; text: string } {
  const { tattag, tatzeit } = formatTatzeit(report)

  const az = report.aktenzeichen ? ` (${report.aktenzeichen})` : ''
  const subject = `Anzeige Ordnungswidrigkeit – Kfz ${report.kennzeichen}${az}`

  // Städte mit amtlichem Formular bekommen das PDF im Anhang; Städte ohne Formular
  // erhalten eine rohe E-Mail, der Beweisfotos und eine Tatort-Karte beiliegen.
  const city = getCity(report.city)
  const withForm = hasPdfForm(city)
  const anhangHinweis = withForm
    ? 'Das ausgefüllte Formular finden Sie im Anhang.'
    : city.mail?.ohneKarte
      ? 'Die Beweisfotos finden Sie im Anhang.'
      : 'Die Beweisfotos und – soweit ermittelbar – eine Tatort-Karte finden Sie im Anhang.'
  // Ladungsfähige Anschrift unter den Namen (Hamburg verlangt sie im Mailtext).
  const anschrift = city.mail?.anschriftImText
    ? [strasseMitNummer(user), [user.plz, user.ort].filter(Boolean).join(' ')].filter(Boolean)
    : []

  const text = [
    'Sehr geehrte Damen und Herren,',
    '',
    'hiermit erstatte ich Anzeige wegen folgender Ordnungswidrigkeit:',
    '',
    report.aktenzeichen ? `Aktenzeichen: ${report.aktenzeichen}` : '',
    `Kennzeichen:  ${report.kennzeichen}${
      report.kennzeichen_land && report.kennzeichen_land !== 'D' ? ` (${report.kennzeichen_land})` : ''
    }`,
    `Fahrzeug:     ${fahrzeugBeschreibung(report) || '—'}`,
    `Tattag:       ${tattag}`,
    `Tatzeit:      ${tatzeit || '—'}`,
    `Tatort:       ${report.tatort}`,
    `Verstoß:      ${report.verstoss_art}${report.verstoss_variante ? ` (genauer: ${report.verstoss_variante})` : ''}`,
    report.fahrzeug_verlassen === 1 ? 'Das Fahrzeug war verlassen.' : undefined,
    report.behinderung === 1
      ? `Behinderung:  ${report.behinderung_text || 'ja'}`
      : undefined,
    report.beschreibung ? `Beschreibung: ${report.beschreibung}` : '',
    '',
    anhangHinweis,
    // Aufnahmezeit je Beweisfoto (nur bei roher E-Mail übergeben; bei Frankfurt
    // stehen die Zeiten stattdessen als Beschriftung auf den PDF-Fotoseiten).
    ...(photoLines.length ? ['', 'Beweisfotos (Aufnahmezeit):', ...photoLines.map((l) => `- ${l}`)] : []),
    '',
    'Für Rückfragen können Sie direkt auf diese E-Mail antworten; bitte lassen Sie',
    'dabei das Aktenzeichen im Betreff stehen.',
    '',
    'Mit freundlichen Grüßen',
    [user.vorname, user.nachname].filter(Boolean).join(' ') || user.email,
    ...anschrift,
  ]
    .filter((line) => line !== undefined)
    .join('\n')

  return { subject, text }
}

/**
 * Anhänge für Städte OHNE amtliches Formular (rohe E-Mail): die Beweisfotos
 * (in nutzbarer Fassung) plus eine gerenderte Tatort-Karte. Best-effort – ein
 * fehlendes Bild/eine fehlende Karte darf den Versand nicht verhindern.
 */
type Attachment = { filename: string; content?: Buffer; path?: string; contentType?: string }

// Stufen zum Verkleinern, wenn die Fotos die Obergrenze eines Amts sprengen
// (Kantenlänge px, JPEG-Qualität). 1100 px reichen für Kennzeichen noch sicher.
const SCHRUMPF_STUFEN: [number, number][] = [[1800, 76], [1400, 72], [1100, 70], [900, 65]]

async function buildEvidenceAttachments(
  report: mysql.RowDataPacket,
  user: mysql.RowDataPacket
): Promise<{ attachments: Attachment[]; photoLines: string[] }> {
  const regeln = getCity(report.city).mail || {}
  const attachments: Attachment[] = []
  // Versandfassungen merken, falls die Fotos für die Größengrenze kleiner müssen.
  const quellen: { basis: Buffer; mimetype: string; attachment: Attachment }[] = []
  // Je Beweisfoto eine Zeile "Beweisfoto-N.jpg – aufgenommen: …" für den Mailtext.
  const photoLines: string[] = []

  const [images] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT filename, mimetype, DATE_FORMAT(captured_at, '%d.%m.%Y, %H:%i') AS captured_at
       FROM report_images WHERE report_id = ? ORDER BY sort_order, id`,
    [report.id]
  )
  const dir = reportDir(Number(user.id), Number(report.id))
  let n = 0
  for (const img of images) {
    try {
      // Versandfassung statt Original: Behörden-Postfächer haben Größenlimits
      // (~15 MB); das Original auf Platte bleibt erhalten.
      let { buffer, type } = await cachedMailVariant(dir, img.filename, img.mimetype)
      if (regeln.nurJpg && type !== 'image/jpeg') {
        const original = await fs.readFile(path.join(dir, img.filename))
        buffer = jpegFassung(original, img.mimetype, await readOrientation(original), 2200, 80)
        type = 'image/jpeg'
      }
      n++
      const ext = type === 'image/png' ? 'png' : 'jpg'
      const name = `Beweisfoto-${n}.${ext}`
      const attachment = { filename: name, content: buffer, contentType: type }
      attachments.push(attachment)
      quellen.push({ basis: buffer, mimetype: type, attachment })
      photoLines.push(
        img.captured_at ? `${name} – aufgenommen: ${img.captured_at} Uhr` : `${name} – Aufnahmezeit unbekannt`
      )
    } catch {
      /* Datei fehlt – überspringen */
    }
  }

  if (regeln.maxAnhangBytes) await fotosEinpassen(quellen, regeln.maxAnhangBytes)

  // Tatort-Karte mit Marker (wie die Kartenseite im PDF), sofern Koordinaten da sind.
  if (!regeln.ohneKarte && report.tatort_lat != null && report.tatort_lon != null) {
    try {
      const mapPng = await renderTatortMap(Number(report.tatort_lat), Number(report.tatort_lon))
      if (mapPng) {
        attachments.push({
          filename: 'Tatort-Karte.png',
          content: mapPng,
          contentType: 'image/png',
        })
      }
    } catch {
      /* Karte nicht verfügbar – ohne Karte versenden */
    }
  }

  return { attachments, photoLines }
}

/** Fotos stufenweise kleiner kodieren, bis alle zusammen unter die Grenze des
 *  Amts passen. Die Grenze gilt für die Mail, Base64 bläht um 4/3 auf – daher
 *  zählt hier nur drei Viertel davon. Passt es auch mit der kleinsten Stufe
 *  nicht, bricht der Versand ab (besser als eine Mail, die zurückkommt). */
async function fotosEinpassen(
  quellen: { basis: Buffer; mimetype: string; attachment: Attachment }[],
  maxBytes: number
): Promise<void> {
  const budget = Math.floor(maxBytes * 0.75)
  const summe = () => quellen.reduce((n, q) => n + (q.attachment.content?.length || 0), 0)
  if (summe() <= budget) return
  // Ausgangspunkt ist die Versandfassung (≤ 2200 px) statt des Originals –
  // spart das Dekodieren der 12-MP-Handyfotos in jeder Stufe.
  // Dateigröße wächst etwa mit der Pixelzahl: Stufen überspringen, die nach
  // dieser Schätzung sicher noch zu groß wären (spart je Stufe einen Durchgang).
  const zielPx = 2200 * Math.sqrt(budget / summe())
  const start = SCHRUMPF_STUFEN.findIndex(([px]) => px <= zielPx * 1.1)
  for (const [px, q] of SCHRUMPF_STUFEN.slice(start === -1 ? SCHRUMPF_STUFEN.length - 1 : start)) {
    for (const quelle of quellen) {
      try {
        const kleiner = jpegFassung(quelle.basis, quelle.mimetype, await readOrientation(quelle.basis), px, q)
        if (kleiner.length < (quelle.attachment.content?.length || Infinity)) {
          quelle.attachment.content = kleiner
          quelle.attachment.contentType = 'image/jpeg'
        }
      } catch {
        /* nicht dekodierbar – bleibt wie es ist */
      }
    }
    if (summe() <= budget) return
  }
  const mb = (maxBytes / 1024 / 1024).toFixed(0)
  throw new Error(`Die Beweisfotos sind auch verkleinert zu groß für die Grenze des Amts (${mb} MB) – bitte Fotos aussortieren.`)
}

/** Was die Anzeige-Mail enthalten wird – für die Einreichen-Vorschau (nur
 *  Städte ohne PDF-Formular und ohne Portal). Erzeugt dieselben Anhänge wie der
 *  Versand, damit Größe und Dateinamen stimmen. */
export async function previewReportMail(
  report: mysql.RowDataPacket,
  user: mysql.RowDataPacket
): Promise<{ subject: string; text: string; attachments: { filename: string; bytes: number }[]; problem?: string }> {
  try {
    const { attachments, photoLines } = await buildEvidenceAttachments(report, user)
    const { subject, text } = buildReportMail(report, user, photoLines)
    return { subject, text, attachments: attachments.map((a) => ({ filename: a.filename, bytes: a.content?.length || 0 })) }
  } catch (err) {
    const { subject, text } = buildReportMail(report, user)
    return { subject, text, attachments: [], problem: (err as Error).message }
  }
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

  /** Mail vollständig vorbereiten. Erst der Aufrufer persistiert Message-ID,
   *  Betreff/Text und Versandsperre, bevor er send() aufruft (reportDispatch.ts). */
  async prepareReport(
    report: mysql.RowDataPacket,
    user: mysql.RowDataPacket,
    messageId: string
  ): Promise<PreparedReportMail> {
    const transport = createTransport()
    const city = getCity(report.city)
    // Empfänger immer aus districts.csv (per Tatort-PLZ) ermitteln.
    const to = recipientEmailForReport(report)
    if (!to) throw new Error('Keine Empfänger-Adresse für den Tatort ermittelbar (PLZ fehlt in districts.csv).')

    // Städte mit Formular: amtliches PDF anhängen (Foto-Zeiten stehen dort auf den
    // PDF-Seiten). Städte ohne Formular: rohe E-Mail mit Beweisfotos + Tatort-Karte;
    // die Aufnahmezeiten der Fotos werden dann direkt in den Mailtext gelistet.
    let attachments: Attachment[]
    let photoLines: string[] = []
    if (hasPdfForm(city) && report.pdf_filename) {
      attachments = [
        {
          filename: report.pdf_filename,
          path: path.join(process.cwd(), 'data/pdfs', String(user.id), report.pdf_filename),
          contentType: 'application/pdf',
        },
      ]
    } else {
      const evidence = await buildEvidenceAttachments(report, user)
      attachments = evidence.attachments
      photoLines = evidence.photoLines
    }

    const { subject, text } = buildReportMail(report, user, photoLines)

    // PDF vor dem Claim-Wechsel zu SMTP lesen: fehlende Dateien sind sichere
    // Vorbereitungsfehler und dürfen ohne manuelle Klärung erneut versucht werden.
    for (const attachment of attachments) {
      if (attachment.path) {
        attachment.content = await fs.readFile(attachment.path)
        delete attachment.path
      }
    }
    return {
      messageId, subject, text, from: process.env.MAIL_FROM || null,
      send: async () => {
        const info = await transport.sendMail({
          messageId,
          from: userFrom(user),
          to,
          cc: user.cc_self === 0 ? undefined : user.email,
          subject, text, attachments,
        })
        // Eine angenommene CC allein ist kein erfolgreicher Versand ans Amt.
        const accepted = ((info.accepted || []) as unknown as (string | { address: string })[]).map((address) =>
          (typeof address === 'string' ? address : address.address).toLowerCase()
        )
        if (!accepted.includes(to.toLowerCase())) {
          throw new Error('Der Amts-Empfänger wurde vom Mailserver nicht angenommen. Versand prüfen.')
        }
      },
    }
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
    const to = recipientEmailForReport(report)
    if (!to) throw new Error('Keine Empfänger-Adresse für den Tatort ermittelbar (PLZ fehlt in districts.csv).')
    const info = await transport.sendMail({
      from: userFrom(user),
      to,
      cc: user.cc_self === 0 ? undefined : user.email,
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

  /** Betriebshinweis an alle Admins (ADMIN_EMAILS), z.B. fehlgeschlagener
   *  Portal-Selbsttest. Ohne Admins passiert nichts. */
  async sendAdminHinweis(subject: string, text: string): Promise<void> {
    const to = adminEmails()
    if (!to.length) return
    const transport = createTransport()
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: to.join(', '),
      subject,
      text,
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

  /** Double-Opt-In: Bestätigungslink für die Newsletter-Anmeldung (neue Städte/PLZ). */
  async sendNewsletterConfirmation(to: string, confirmLink: string): Promise<void> {
    const transport = createTransport()
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to,
      subject: 'Newsletter-Anmeldung bestätigen',
      text: [
        'Hallo,',
        '',
        'du möchtest benachrichtigt werden, sobald der OWiA-Anzeiger in neuen',
        'Städten und Postleitzahlgebieten verfügbar ist. Klicke zum Bestätigen',
        'auf diesen Link:',
        '',
        confirmLink,
        '',
        'Der Link ist 48 Stunden gültig. Wenn du das nicht warst, ignoriere',
        'diese E-Mail – ohne Bestätigung bekommst du keine weiteren Nachrichten.',
        '',
        'Viele Grüße',
        'OWiA-Anzeiger',
      ].join('\n'),
    })
  },

  /** Newsletter-Ankündigung (z.B. neue Stadt freigeschaltet) an einen Abonnenten. */
  async sendNewsletterAnnouncement(
    to: string,
    subject: string,
    text: string,
    unsubscribeLink: string
  ): Promise<void> {
    const transport = createTransport()
    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to,
      subject,
      text: [
        text.trim(),
        '',
        '--',
        'Du erhältst diese E-Mail, weil du dich für Neuigkeiten des',
        'OWiA-Anzeigers angemeldet hast. Abmelden:',
        unsubscribeLink,
      ].join('\n'),
      headers: { 'List-Unsubscribe': `<${unsubscribeLink}>` },
    })
  },

  /**
   * Hinweis an die Admins: eine neue Anzeige wartet auf Prüfung. Enthält alle
   * prüfrelevanten Angaben, damit offensichtliche Fälle (unvollständiges Profil,
   * fehlende Fotos, erneute Einreichung nach Ablehnung) schon in der Mailübersicht
   * auffallen und nicht erst nach dem Öffnen der Prüfseite.
   *
   * `vorherigeAblehnung` = Ablehnungsgrund aus dem Stand VOR dem Einreichen
   * (der Aufrufer setzt die Spalte beim Einreichen zurück).
   */
  async sendSubmitNotification(
    adminAddresses: string[],
    report: mysql.RowDataPacket,
    userEmail: string,
    vorherigeAblehnung?: string | null
  ): Promise<void> {
    if (!adminAddresses.length) return
    const transport = createTransport()
    const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')

    // Zusatzangaben (Profil des Erstatters, Fotoanzahl, Länge der Warteschlange)
    // best-effort nachladen – sie machen die Mail reichhaltiger, dürfen den
    // Versand aber nicht verhindern.
    let extra: mysql.RowDataPacket | undefined
    try {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT u.email, u.vorname, u.nachname, u.strasse, u.hausnummer, u.plz, u.ort, u.telefon,
                (SELECT COUNT(*) FROM report_images ri WHERE ri.report_id = r.id) AS image_count,
                (SELECT COUNT(*) FROM reports p WHERE p.status = 'eingereicht') AS pending_count
           FROM reports r JOIN users u ON u.id = r.user_id
          WHERE r.id = ?`,
        [report.id]
      )
      extra = rows[0]
    } catch {
      /* ohne Zusatzangaben weiter */
    }

    const { tattag, tatzeit } = formatTatzeit(report)
    const city = getCity(report.city)
    const kennzeichen = report.kennzeichen
      ? `${report.kennzeichen}${
          report.kennzeichen_land && report.kennzeichen_land !== 'D'
            ? ` (${report.kennzeichen_land})`
            : ''
        }`
      : '—'
    const profil = extra
      ? [
          [extra.vorname, extra.nachname].filter(Boolean).join(' '),
          strasseMitNummer(extra),
          [extra.plz, extra.ort].filter(Boolean).join(' '),
        ]
          .filter(Boolean)
          .join(', ')
      : ''
    const profilVollstaendig =
      !!extra && !!(extra.vorname && extra.nachname && extra.strasse && extra.hausnummer && extra.plz && extra.ort)
    const fotos = extra ? Number(extra.image_count) : null
    const offen = extra ? Number(extra.pending_count) : null

    // "Label: Wert" mit ausgerichteten Werten; mehrzeilige Texte werden eingerückt.
    const zeile = (label: string, value: unknown): string | undefined => {
      const text = value === null || value === undefined || value === '' ? '' : String(value)
      if (!text) return undefined
      const pad = `${label}:`.padEnd(14)
      return `  ${pad}${text.replace(/\r?\n/g, '\n'.padEnd(17))}`
    }

    const kurz = (s: unknown, max: number): string => {
      const t = String(s ?? '').replace(/\s+/g, ' ').trim()
      return t.length > max ? `${t.slice(0, max - 1)}…` : t
    }

    const verstoss = report.verstoss_art ? kurz(report.verstoss_art, 60) : 'ohne Verstoßangabe'
    const now = new Date()
    const wieder = !!vorherigeAblehnung

    const text = [
      `Anzeige ${report.aktenzeichen} wurde am ${now.toLocaleDateString('de-DE')} um ${now.toLocaleTimeString(
        'de-DE',
        { hour: '2-digit', minute: '2-digit' }
      )} Uhr`,
      `von ${userEmail || extra?.email || 'unbekannt'} zur Prüfung eingereicht.`,
      wieder ? '' : undefined,
      wieder ? `Erneute Einreichung nach Ablehnung. Grund der letzten Ablehnung:` : undefined,
      wieder ? `  ${String(vorherigeAblehnung).replace(/\r?\n/g, '\n  ')}` : undefined,
      '',
      'Tatvorwurf',
      zeile('Verstoß', report.verstoss_art),
      report.fahrzeug_verlassen === 1 ? '  (Fahrzeug war verlassen)' : undefined,
      zeile('Tattag', tattag),
      zeile('Tatzeit', tatzeit || '—'),
      zeile('Tatort', report.tatort),
      report.tatort_lat && report.tatort_lon
        ? zeile(
            'Karte',
            `https://www.openstreetmap.org/?mlat=${report.tatort_lat}&mlon=${report.tatort_lon}#map=19/${report.tatort_lat}/${report.tatort_lon}`
          )
        : zeile('Karte', 'keine Koordinaten hinterlegt'),
      zeile('Kennzeichen', kennzeichen),
      zeile('Fahrzeug', fahrzeugBeschreibung(report)),
      zeile('Behinderung', report.behinderung === 1 ? report.behinderung_text || 'ja' : 'nein'),
      zeile('Beschreibung', report.beschreibung),
      '',
      'Vorgang',
      zeile('Stadt/Amt', `${city.name} – ${city.ordnungsamt}`),
      zeile(
        'Versandart',
        hasPdfForm(city) ? 'amtliches PDF-Formular im Anhang' : city.mail?.ohneKarte ? 'rohe E-Mail mit Fotos (ohne Karte)' : 'rohe E-Mail mit Fotos + Karte'
      ),
      zeile('Empfänger', recipientEmailForReport(report) || 'nicht ermittelbar (!)'),
      zeile('Fotos', fotos === null ? undefined : fotos === 0 ? '0 (!)' : fotos),
      zeile('Erstatter', profilVollstaendig ? profil : `${profil || '—'} — Profil unvollständig (!)`),
      zeile('E-Mail', extra?.email || userEmail),
      zeile('Telefon', extra?.telefon),
      '',
      offen === null ? undefined : `Offen in der Prüfung: ${offen} Anzeige${offen === 1 ? '' : 'n'}.`,
      `Zur Prüfung: ${base}/admin/anzeigen#a-${report.id}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n')

    await transport.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || 'OWiA-Anzeiger'}" <${process.env.MAIL_FROM}>`,
      to: adminAddresses.join(','),
      subject: `Neue Anzeige zur Prüfung: ${report.aktenzeichen} – ${verstoss}${
        wieder ? ' (erneut eingereicht)' : ''
      }`,
      text,
    })
  },

  /** Info an den Nutzer: die Prüfung hat die Anzeige zurück in den Entwurf gegeben. */
  async sendReportRejected(
    user: mysql.RowDataPacket,
    report: mysql.RowDataPacket,
    grund: string
  ): Promise<void> {
    const transport = createTransport()
    const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
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
        'Die Anzeige ist wieder ein Entwurf – bitte passe sie an und reiche sie erneut ein:',
        `${base}/anzeige/${report.aktenzeichen}`,
        '',
        'Viele Grüße',
        'OWiA-Anzeiger',
      ].join('\n'),
    })
  },
}
