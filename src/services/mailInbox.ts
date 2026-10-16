// Posteingang für Antworten des Ordnungsamts: das Versand-Postfach (MAIL_FROM,
// z.B. owia@treudler.net) wird per IMAP gepollt. Eingehende Mails werden der
// passenden Anzeige zugeordnet (In-Reply-To/References gegen die gespeicherte
// Message-ID des Versands, sonst Aktenzeichen im Betreff/Body – letzteres nur
// bei vom eigenen MTA authentifizierten Amts-Absendern), samt Anhängen
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
import type { FastifyBaseLogger, FastifyReply } from 'fastify'
import { pool } from '../db/connection'
import { MailService } from './mail'
import { UPLOAD_DIR } from './drafts'
import { loadUser } from './users'

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
const MAX_ATTACHMENTS = 10
const MAX_BODY_CHARS = 500_000

// Aktenzeichen im Betreff/Body: aktuelles Format "OWiA-123456",
// Alt-Format "OWiAA-XXXXXX" (Buchstaben+Ziffern).
const AZ_REGEX = /OWiAA?-[A-Z0-9]{6}/i

export function repliesDir(replyId: number): string {
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

/** Vertrauenswürdige Absender-Domains fürs Aktenzeichen-Matching (kommagetrennt
 *  in REPLY_TRUSTED_DOMAINS, Default: Stadt Frankfurt). Das Matching über die
 *  Message-ID-Kette gilt dagegen für alle Absender – wer die IDs kennt, war
 *  Teil des Mail-Verlaufs. Verhindert, dass Fremde mit einem erratenen/geleakten
 *  Aktenzeichen gefälschte "Amts-Antworten" in Nutzerkonten einschleusen. */
function trustedSenderDomains(): string[] {
  // Default = alle freigeschalteten Städte (Frankfurt, Bad Soden, Hanau,
  // Wiesbaden, Mainz, Hamburg inkl. owi-verkehr.hamburg.de) – REPLY_TRUSTED_DOMAINS in der .env ersetzt die Liste.
  return (process.env.REPLY_TRUSTED_DOMAINS || 'stadt-frankfurt.de,badsoden-salmuenster.de,hanau.de,wiesbaden.de,mainz.de,hamburg.de')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
}

function isTrustedSender(fromAddress: string | null): boolean {
  if (!fromAddress) return false
  const domain = fromAddress.split('@')[1]?.toLowerCase() || ''
  return trustedSenderDomains().some((d) => domain === d || domain.endsWith(`.${d}`))
}

export type AuthResult = { method: string; result: string; props: Record<string, string> }

/** Wert eines Authentication-Results-Headers (RFC 8601) zerlegen:
 *  `authserv-id [version]; methode=ergebnis prop=wert …; …`. Kommentare in
 *  Klammern werden verworfen (dort stehen z.B. „(mail.treudler.net: domain of
 *  … designates …)“), Semikolons in Kommentaren/Anführungszeichen trennen nicht. */
export function parseAuthenticationResults(value: string): { authservId: string; results: AuthResult[] } | null {
  const segments: string[] = []
  let cur = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quoted) {
      if (ch === '\\' && i + 1 < value.length) cur += value[++i]
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (depth > 0) {
      if (ch === '\\') i++
      else if (ch === '(') depth++
      else if (ch === ')') depth--
    } else if (ch === '"') quoted = true
    else if (ch === '(') depth++
    else if (ch === ';') { segments.push(cur); cur = '' }
    else cur += ch
  }
  segments.push(cur)
  const authservId = (segments.shift() || '').trim().split(/\s+/)[0]?.toLowerCase() || ''
  if (!authservId) return null
  const results: AuthResult[] = []
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean)
    const m = tokens.shift()?.match(/^([a-z0-9_.-]+)=([a-z0-9_-]+)$/i)
    if (!m) continue // z.B. „none“ = keine Prüfung erfolgt
    const props: Record<string, string> = {}
    for (const t of tokens) {
      const p = t.match(/^([a-z0-9_-]+\.[a-z0-9_-]+)=(.+)$/i)
      if (p) props[p[1].toLowerCase()] = p[2].toLowerCase()
    }
    results.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props })
  }
  return { authservId, results }
}

/** authserv-id, unter der UNSER Mailserver seine Prüfergebnisse einträgt
 *  (MAIL_AUTHSERV_ID; Default IMAP_HOST – bei Mailcow/rspamd ist das der
 *  Hostname, Prod: „mail.treudler.net“). Ohne beides (nur Dev, Mails kommen
 *  dort über /dev/inbound-mail) wird die authserv-id nicht geprüft. */
function expectedAuthservId(): string | null {
  return (process.env.MAIL_AUTHSERV_ID || process.env.IMAP_HOST || '').trim().toLowerCase() || null
}

/** Ist die Absender-Domain (From) von UNSEREM Mailserver positiv bestätigt?
 *
 *  Der From-Header allein ist fälschbar – und Authentication-Results-Header
 *  ebenso: Ein Absender kann beliebig viele davon (mit „dmarc=pass“) selbst
 *  mitschicken. Früher wurden alle Header zusammengeworfen, sodass ein
 *  mitgeschicktes „dkim=pass“ das „spf=fail“ unseres MTA aufhob und gefälschte
 *  „Amts-Antworten“ per Aktenzeichen in fremden Anzeigen landeten (gespeichertes
 *  XSS über Anhänge). Deshalb gilt nur der OBERSTE Header: der empfangende MTA
 *  stellt seinen Header vor alle mitgebrachten (Prod/Mailcow: direkt unter dem
 *  eigenen Received) – und er muss die erwartete authserv-id tragen, sonst hat
 *  unser MTA gar nicht geprüft und der oberste stammt womöglich vom Absender.
 *
 *  Verlangt wird ein POSITIVES, zur From-Domain passendes Ergebnis:
 *  dmarc=pass (header.from = From-Domain), dkim=pass mit ausgerichtetem
 *  header.d oder spf=pass mit ausgerichtetem smtp.mailfrom. Ein dmarc=fail
 *  sticht alles. Fehlt der Header ganz, gibt es KEIN Aktenzeichen-Matching –
 *  die Mail landet beim Admin unter „nicht zugeordnet“ (sicherer Default;
 *  Antworten im Mail-Verlauf werden weiter über die Message-ID-Kette erkannt). */
export function senderAuthenticated(
  parsed: Pick<ParsedMail, 'headerLines'>,
  fromAddress: string | null
): boolean {
  const fromDomain = fromAddress?.split('@')[1]?.trim().toLowerCase() || ''
  if (!fromDomain) return false
  // headerLines behält die Reihenfolge der Mail (oben = zuletzt hinzugefügt).
  const top = (parsed.headerLines || []).find((h) => h.key === 'authentication-results')
  if (!top) return false
  const ar = parseAuthenticationResults(top.line.replace(/^[^:]*:/, '').replace(/\r?\n[ \t]+/g, ' '))
  if (!ar) return false
  const expected = expectedAuthservId()
  if (expected && ar.authservId !== expected) return false

  // Relaxed Alignment ohne Public-Suffix-Liste: gleiche Domain oder Sub-/
  // Elterndomain. Die From-Domain ist ohnehin schon gegen
  // REPLY_TRUSTED_DOMAINS geprüft, ein „d=de“ kann niemand signieren.
  const aligned = (d: string | undefined) => {
    const dom = (d || '').split('@').pop() || ''
    return !!dom && (dom === fromDomain || fromDomain.endsWith(`.${dom}`) || dom.endsWith(`.${fromDomain}`))
  }
  if (ar.results.some((r) => r.method === 'dmarc' && r.result === 'fail')) return false
  return ar.results.some((r) =>
    (r.method === 'dmarc' && r.result === 'pass' && r.props['header.from'] === fromDomain) ||
    (r.method === 'dkim' && r.result === 'pass' && aligned(r.props['header.d'])) ||
    (r.method === 'spf' && r.result === 'pass' && aligned(r.props['smtp.mailfrom']))
  )
}

/** Anzeige zur eingehenden Mail finden: erst Message-ID-Bezug, dann Aktenzeichen. */
async function matchReport(parsed: ParsedMail, log: FastifyBaseLogger): Promise<mysql.RowDataPacket | null> {
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

  // Aktenzeichen-Matching nur für vertrauenswürdige UND von unserem MTA
  // authentifizierte Absender (s.o.); alle anderen Mails ohne Message-ID-Bezug
  // landen als "nicht zugeordnet" beim Admin und können dort nach Sichtprüfung
  // manuell zugeordnet werden.
  const from = parsed.from?.value?.[0]?.address || null
  if (!isTrustedSender(from)) return null
  if (!senderAuthenticated(parsed, from)) {
    log.warn({ from }, 'Posteingang: Absender nicht authentifiziert – kein Aktenzeichen-Matching')
    return null
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

  const report = await matchReport(parsed, log)

  let body = parsed.text || ''
  if (!body && typeof parsed.html === 'string') body = htmlToText(parsed.html)
  body = body.slice(0, MAX_BODY_CHARS)

  // Erst die vollständige Nachricht veröffentlichen. INSERT und alle Anhang-
  // Metadaten gehören in dieselbe Transaktion; ein Wiederholungsversuch darf
  // nur eine vollständig gespeicherte Nachricht als Duplikat überspringen.
  const conn = await pool.getConnection()
  let replyId: number | undefined
  let commitStarted = false
  try {
    await conn.beginTransaction()
    const [result] = await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO report_replies (report_id, message_id, from_address, subject, body_text, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        report?.id ?? null, messageId, from ? from.slice(0, 255) : null,
        (parsed.subject || '').slice(0, 500) || null, body || null,
        parsed.date instanceof Date && !isNaN(parsed.date.getTime()) ? parsed.date : new Date(),
      ]
    )
    replyId = result.insertId
    const attachments = (parsed.attachments || []).slice(0, MAX_ATTACHMENTS)
    for (const att of attachments) {
      if (!att.content?.length) continue
      if (att.content.length > MAX_ATTACHMENT_BYTES) {
        log.warn({ size: att.content.length, replyId }, 'Posteingang: Anhang zu groß – übersprungen')
        continue
      }
      const { display, ext } = sanitizeAttachmentName(att.filename)
      const stored = `anhang-${crypto.randomBytes(6).toString('hex')}.${ext}`
      await fs.mkdir(repliesDir(replyId), { recursive: true })
      await fs.writeFile(path.join(repliesDir(replyId), stored), att.content)
      await conn.execute(
        `INSERT INTO report_reply_attachments (reply_id, filename, original_filename, mimetype, size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
        // Content-Type kommt vom Absender – nur harmlose, anzeigbare Typen
        // übernehmen, alles andere (text/html, image/svg+xml, …) wird
        // application/octet-stream (s. normalizeAttachmentType).
        [replyId, stored, display, normalizeAttachmentType(att.contentType), att.content.length]
      )
    }
    commitStarted = true
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    // Bei verlorener COMMIT-Antwort könnten die DB-Zeilen bereits sichtbar
    // sein. Dann niemals deren Dateien entfernen! Ein Prozessabbruch kann
    // lediglich verwaiste Dateien hinterlassen, keine halbe sichtbare Mail.
    if (replyId !== undefined && !commitStarted) {
      await fs.rm(repliesDir(replyId), { recursive: true, force: true }).catch((cleanupError) => {
        log.warn({ err: cleanupError, replyId }, 'Posteingang: verwaistes Anhang-Verzeichnis')
      })
    }
    if (replyId === undefined && (err as { code?: string }).code === 'ER_DUP_ENTRY') {
      log.info({ messageId }, 'Posteingang: vollständig gespeichertes Duplikat übersprungen')
      return null
    }
    throw err
  } finally {
    conn.release()
  }

  // Nutzer informieren (Fehler loggen, aber die Verarbeitung nie blockieren).
  // Die Antwort wird auch bei anonymisierten Konten gespeichert (Aktenrecord),
  // aber es geht keine Hinweis-Mail mehr raus (liefe an die Platzhalter-Adresse).
  if (report) {
    try {
      const user = await loadUser(report.user_id)
      if (user && !user.anonymized_at) {
        await MailService.sendReplyNotification(user, report)
      }
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

/** Anhang-Typen, die der Browser selbst darstellen darf (PDF-Viewer, Bilder).
 *  Nichts davon führt im Kontext unserer Origin Skripte aus – anders als
 *  text/html, image/svg+xml oder text/xml aus einer fremden Mail. */
const SAFE_ATTACHMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** Content-Type eines Antwort-Anhangs auf die Whitelist abbilden, sonst
 *  application/octet-stream. Gilt beim Speichern (processInboundMail) UND beim
 *  Ausliefern (sendReplyAttachment) – Altbestand vor dem Fix trägt noch den
 *  ungeprüften Typ aus der Mail. */
export function normalizeAttachmentType(contentType: string | null | undefined): string {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (base === 'image/jpg' || base === 'image/pjpeg') return 'image/jpeg'
  return SAFE_ATTACHMENT_TYPES.has(base) ? base : 'application/octet-stream'
}

/** Content-Disposition mit sicherem Dateinamen: ASCII-Fallback in
 *  Anführungszeichen (ohne " \ und Steuerzeichen – sonst Header-Injection bzw.
 *  kaputter Header) plus RFC 5987 filename* für Umlaute. */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Steuerzeichen sollen gerade entfernt werden.
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 200) || 'anhang'
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// CSP für ausgelieferte Anhänge: „sandbox“ gibt dem Dokument eine opake
// Origin ohne Skripte – selbst wenn doch einmal ein aktiver Inhalt gerendert
// würde, kommt er weder an Cookies noch an unsere Endpunkte. Getestet
// (Chromium 1234, /root/owia/work/csp-test): der eingebaute PDF-Viewer zeigt
// PDFs mit diesem Header weiterhin an, auch im iframe der Anzeigen-Seite.
// frame-ancestors wie in der globalen helmet-CSP (server.ts), die dieser
// Header für Anhänge ersetzt: Einbetten nur durch eigene Seiten.
const ATTACHMENT_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'"

/** Antwort-Anhang ausliefern (Nutzer- und Admin-Route). Inline nur für die
 *  Whitelist-Typen; alles andere immer als Download mit octet-stream. */
export function sendReplyAttachment(
  reply: FastifyReply,
  att: { filename: string; original_filename?: string | null; mimetype?: string | null },
  buffer: Buffer,
  wantInline: boolean
): FastifyReply {
  const type = normalizeAttachmentType(att.mimetype)
  const inline = wantInline && type !== 'application/octet-stream'
  return reply
    .header('Content-Type', type)
    .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', att.original_filename || att.filename))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', ATTACHMENT_CSP)
    .send(buffer)
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
