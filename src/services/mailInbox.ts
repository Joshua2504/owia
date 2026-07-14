// Posteingang für Antworten des Ordnungsamts: das Versand-Postfach (MAIL_FROM,
// z.B. owia@treudler.net) wird per IMAP gepollt. Eingehende Mails werden der
// passenden Anzeige zugeordnet (In-Reply-To/References gegen die gespeicherte
// Message-ID des Versands, sonst Aktenzeichen im Betreff/Body), samt Anhängen
// gespeichert und dem Nutzer per Hinweis-Mail + Detailseite gezeigt.
//
// Aufbau: processInboundMail() ist transport-unabhängig (wird in der
// Entwicklung über POST /dev/inbound-mail gefüttert, da Mailpit kein IMAP
// spricht); startInboxPolling() ist nur eine dünne IMAP-Schleife darum.
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import mysql from 'mysql2/promise'
import { ImapFlow } from 'imapflow'
import { simpleParser, ParsedMail } from 'mailparser'
import type { FastifyBaseLogger } from 'fastify'
import { pool } from '../db/connection'
import { MailService } from './mail'
import { UPLOAD_DIR } from './drafts'

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
const MAX_ATTACHMENTS = 10
const MAX_BODY_CHARS = 500_000

// Aktenzeichen im Betreff/Body: aktuelles Format "OWiA-123456",
// Alt-Format "OWiAA-XXXXXX" (Buchstaben+Ziffern).
const AZ_REGEX = /OWiAA?-[A-Z0-9]{6}/i

function repliesDir(replyId: number): string {
  // Liegt im gemounteten uploads-Volume; "replies" kollidiert nicht mit den
  // numerischen <userId>-Verzeichnissen.
  return path.join(UPLOAD_DIR, 'replies', String(replyId))
}

/** Sehr einfacher HTML->Text-Fallback (mailparser leitet text nicht aus HTML ab). */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Anzeigename eines Anhangs bereinigen; Endung aus Whitelist ableiten. */
function sanitizeAttachmentName(name: string | undefined): { display: string; ext: string } {
  const display = (name || 'anhang').replace(/[^\wäöüÄÖÜß .()-]/g, '_').slice(0, 200) || 'anhang'
  const m = display.toLowerCase().match(/\.([a-z0-9]{1,5})$/)
  return { display, ext: m ? m[1] : 'bin' }
}

/** Anzeige zur eingehenden Mail finden: erst Message-ID-Bezug, dann Aktenzeichen. */
async function matchReport(parsed: ParsedMail): Promise<mysql.RowDataPacket | null> {
  const refs = [
    parsed.inReplyTo,
    ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references]),
  ].filter((r): r is string => !!r)

  if (refs.length) {
    const placeholders = refs.map(() => '?').join(',')
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM reports WHERE sent_message_id IN (${placeholders}) LIMIT 1`,
      refs
    )
    if (rows[0]) return rows[0]

    // Auch Antworten auf spätere Nachrichten des Verlaufs (z.B. eine Rückfrage-
    // Antwort des Nutzers) landen bei der richtigen Anzeige.
    const [viaThread] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.* FROM report_replies rr
         JOIN reports r ON r.id = rr.report_id
        WHERE rr.message_id IN (${placeholders}) LIMIT 1`,
      refs
    )
    if (viaThread[0]) return viaThread[0]
  }

  for (const source of [parsed.subject, parsed.text, parsed.html || '']) {
    const az = typeof source === 'string' ? source.match(AZ_REGEX)?.[0] : undefined
    if (!az) continue
    // Kollation der Spalte ist case-insensitiv – Treffer unabhängig von der Schreibweise.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM reports WHERE aktenzeichen = ? LIMIT 1',
      [az]
    )
    if (rows[0]) return rows[0]
  }
  return null
}

export type InboundResult = { replyId: number; reportId: number | null } | null

/** Eine rohe RFC822-Mail verarbeiten: zuordnen, speichern, Nutzer informieren. */
export async function processInboundMail(
  raw: Buffer,
  log: FastifyBaseLogger
): Promise<InboundResult> {
  const parsed = await simpleParser(raw)

  // Eigene Mails (Versand + Hinweis-Mails laufen über dasselbe Postfach) nie
  // als "Antwort" ingestieren – verhindert Schleifen.
  const from = parsed.from?.value?.[0]?.address?.toLowerCase() || null
  const self = (process.env.MAIL_FROM || '').toLowerCase()
  if (from && self && from === self) {
    log.info({ from }, 'Posteingang: eigene Mail übersprungen')
    return null
  }

  const messageId =
    (parsed.messageId || '').slice(0, 255) ||
    `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`

  const report = await matchReport(parsed)

  let body = parsed.text || ''
  if (!body && typeof parsed.html === 'string') body = htmlToText(parsed.html)
  body = body.slice(0, MAX_BODY_CHARS)

  let replyId: number
  try {
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO report_replies (report_id, message_id, from_address, subject, body_text, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        report?.id ?? null,
        messageId,
        from ? from.slice(0, 255) : null,
        (parsed.subject || '').slice(0, 500) || null,
        body || null,
        parsed.date instanceof Date && !isNaN(parsed.date.getTime()) ? parsed.date : new Date(),
      ]
    )
    replyId = result.insertId
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      // Bereits verarbeitet (z.B. Crash zwischen Speichern und markSeen).
      log.info({ messageId }, 'Posteingang: Duplikat übersprungen')
      return null
    }
    throw err
  }

  // Anhänge (gedeckelt) neben die Antwort legen.
  const attachments = (parsed.attachments || []).slice(0, MAX_ATTACHMENTS)
  for (const att of attachments) {
    if (!att.content || att.content.length === 0) continue
    if (att.content.length > MAX_ATTACHMENT_BYTES) {
      log.warn(
        { filename: att.filename, size: att.content.length, replyId },
        'Posteingang: Anhang zu groß – übersprungen'
      )
      continue
    }
    const { display, ext } = sanitizeAttachmentName(att.filename)
    const stored = `anhang-${crypto.randomBytes(6).toString('hex')}.${ext}`
    await fs.mkdir(repliesDir(replyId), { recursive: true })
    await fs.writeFile(path.join(repliesDir(replyId), stored), att.content)
    await pool.execute(
      `INSERT INTO report_reply_attachments (reply_id, filename, original_filename, mimetype, size_bytes)
       VALUES (?, ?, ?, ?, ?)`,
      [replyId, stored, display, (att.contentType || '').slice(0, 100) || null, att.content.length]
    )
  }

  // Nutzer informieren (Fehler loggen, aber die Verarbeitung nie blockieren).
  if (report) {
    try {
      const [users] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT * FROM users WHERE id = ?',
        [report.user_id]
      )
      if (users[0]) await MailService.sendReplyNotification(users[0], report)
    } catch (err) {
      log.error({ err, replyId }, 'Posteingang: Hinweis-Mail fehlgeschlagen')
    }
  }

  log.info(
    { replyId, reportId: report?.id ?? null, aktenzeichen: report?.aktenzeichen, from },
    'Posteingang: Antwort gespeichert'
  )
  return { replyId, reportId: report?.id ?? null }
}

/** Absoluten Pfad eines gespeicherten Antwort-Anhangs liefern. */
export function replyAttachmentPath(replyId: number, filename: string): string {
  return path.join(repliesDir(replyId), filename)
}

/** IMAP-Polling starten (nur wenn IMAP_HOST/USER/PASS gesetzt sind).
 *  Pro Zyklus wird eine frische Verbindung geöffnet und wieder geschlossen –
 *  das heilt Verbindungsabbrüche und Neustarts ohne Reconnect-Logik. */
export function startInboxPolling(log: FastifyBaseLogger): void {
  const host = process.env.IMAP_HOST
  const user = process.env.IMAP_USER
  const pass = process.env.IMAP_PASS
  if (!host || !user || !pass) {
    log.info('Posteingang: IMAP nicht konfiguriert – Antworten-Abruf deaktiviert')
    return
  }
  const intervalMs = Math.max(30, Number(process.env.IMAP_POLL_SECONDS) || 120) * 1000

  let inFlight = false
  const poll = async () => {
    if (inFlight) return
    inFlight = true
    const client = new ImapFlow({
      host,
      port: Number(process.env.IMAP_PORT) || 993,
      secure: true,
      auth: { user, pass },
      logger: false,
    })
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        const uids = await client.search({ seen: false }, { uid: true })
        for (const uid of uids || []) {
          const { content } = await client.download(String(uid), undefined, { uid: true })
          const chunks: Buffer[] = []
          for await (const chunk of content) chunks.push(chunk as Buffer)
          try {
            await processInboundMail(Buffer.concat(chunks), log)
          } catch (err) {
            // Kaputte Einzel-Mail blockiert nicht den Rest; bleibt ungelesen
            // und wird beim nächsten Lauf erneut versucht.
            log.error({ err, uid }, 'Posteingang: Verarbeitung fehlgeschlagen')
            continue
          }
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
        }
      } finally {
        lock.release()
      }
      await client.logout()
    } catch (err) {
      log.error({ err }, 'Posteingang: IMAP-Abruf fehlgeschlagen')
      try {
        client.close()
      } catch {
        /* Verbindung war schon zu */
      }
    } finally {
      inFlight = false
    }
  }

  log.info({ host, user, intervalSeconds: intervalMs / 1000 }, 'Posteingang: IMAP-Polling aktiv')
  setInterval(poll, intervalMs)
  void poll()
}
