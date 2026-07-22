import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { ZipArchive } from 'archiver'
import { pool } from '../db/connection'
import { requireAuth, viewData, setFlash } from '../middleware/auth'
import { reportDir, UPLOAD_DIR } from '../services/drafts'
import { replyAttachmentPath } from '../services/mailInbox'
import { MailService } from '../services/mail'

const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')

/** Dateinamen für den ZIP-Export bereinigen. */
function safeName(name: string): string {
  return (name || 'datei').replace(/[^\wäöüÄÖÜß .()-]/g, '_').slice(0, 150)
}

function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

function fmtDate(v: unknown): string {
  if (!v) return '—'
  const d = new Date(v as string)
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString('de-DE')
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/einstellungen', { preHandler: requireAuth }, async (request, reply) => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT email, vorname, nachname, strasse, plz, ort, telefon, cc_self FROM users WHERE id = ?',
      [request.session.userId as number]
    )
    return reply.view('/settings/index.ejs', viewData(request, {
      title: 'Einstellungen',
      user: rows[0],
    }))
  })

  app.post('/einstellungen', { preHandler: requireAuth }, async (request, reply) => {
    const { vorname, nachname, strasse, plz, ort, telefon, cc_self } =
      request.body as Record<string, string>

    await pool.execute(
      `UPDATE users SET vorname=?, nachname=?, strasse=?, plz=?, ort=?, telefon=?, cc_self=?
       WHERE id = ?`,
      [vorname, nachname, strasse, plz, ort, telefon, cc_self ? 1 : 0, request.session.userId as number]
    )

    const name = [vorname, nachname].filter(Boolean).join(' ')
    request.session.userName = name || request.session.userEmail
    setFlash(reply, 'success', 'Einstellungen gespeichert.')
    return reply.redirect('/einstellungen')
  })

  // E-Mail-Adresse ändern (Schritt 1): Bestätigungslink an die NEUE Adresse.
  // Erst die Bestätigung (Schritt 2) übernimmt die Adresse – das beweist,
  // dass der Nutzer das neue Postfach kontrolliert.
  app.post('/einstellungen/email', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const userId = request.session.userId as number
    const neu = String((request.body as { email_neu?: string })?.email_neu || '')
      .trim()
      .toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(neu)) {
      setFlash(reply, 'error', 'Bitte eine gültige E-Mail-Adresse eingeben.')
      return reply.redirect('/einstellungen')
    }
    const [taken] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ?',
      [neu]
    )
    if (taken.length) {
      setFlash(reply, 'error', 'Diese E-Mail-Adresse wird bereits verwendet.')
      return reply.redirect('/einstellungen')
    }

    const token = crypto.randomBytes(32).toString('hex')
    await pool.execute(
      `UPDATE users SET email_change_neu=?, email_change_token=?,
              email_change_expires=DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id=?`,
      [neu, token, userId]
    )
    const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
    try {
      await MailService.sendEmailChangeConfirmation(neu, `${base}/einstellungen/email/bestaetigen/${token}`)
      setFlash(reply, 'success', `Bestätigungslink an ${neu} gesendet – bitte dort klicken.`)
    } catch (err) {
      app.log.error({ err }, 'E-Mail-Änderungs-Mail fehlgeschlagen')
      setFlash(reply, 'error', 'Die Bestätigungs-Mail konnte nicht gesendet werden.')
    }
    return reply.redirect('/einstellungen')
  })

  // E-Mail-Adresse ändern (Schritt 2): Token aus dem Link einlösen.
  app.get('/einstellungen/email/bestaetigen/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, email_change_neu FROM users
        WHERE email_change_token = ? AND email_change_expires > NOW()
          AND email_change_neu IS NOT NULL`,
      [token]
    )
    const user = rows[0]
    if (!user) {
      setFlash(reply, 'error', 'Der Bestätigungslink ist ungültig oder abgelaufen.')
      return reply.redirect('/login')
    }
    // Adresse könnte inzwischen vergeben sein (Race) – Unique-Kollision abfangen.
    try {
      await pool.execute(
        `UPDATE users SET email = email_change_neu, email_change_neu = NULL,
                email_change_token = NULL, email_change_expires = NULL WHERE id = ?`,
        [user.id]
      )
    } catch {
      setFlash(reply, 'error', 'Diese E-Mail-Adresse wird inzwischen bereits verwendet.')
      return reply.redirect('/login')
    }
    // Falls der Bestätigende gerade als dieser Nutzer angemeldet ist: Session aktualisieren.
    if (request.session.userId === user.id) {
      request.session.userEmail = user.email_change_neu
      await request.session.save()
    }
    setFlash(reply, 'success', 'E-Mail-Adresse geändert – bitte künftig damit anmelden.')
    return reply.redirect(request.session.userId === user.id ? '/einstellungen' : '/login')
  })

  // Konto schließen & anonymisieren (DSGVO Art. 17): Statt die Anzeigen hart zu
  // löschen, werden nur die personenbezogenen Daten des Anzeigenerstatters
  // entfernt – die users-Zeile bleibt (geleert, Platzhalter-E-Mail) erhalten,
  // damit die Anzeigen inkl. Fotos/Tatort für Statistik/öffentliche Karte
  // bestehen bleiben. Entfernt werden: Nachrichtenverlauf (Korrespondenz),
  // erzeugte PDFs (enthalten Name/Anschrift/E-Mail) und die Profildaten.
  app.post('/einstellungen/loeschen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const bestaetigung = String((request.body as { bestaetigung?: string })?.bestaetigung || '').trim()
    if (bestaetigung !== 'LÖSCHEN') {
      setFlash(reply, 'error', 'Bitte zur Bestätigung das Wort LÖSCHEN eingeben.')
      return reply.redirect('/einstellungen')
    }

    // 1) Nachrichtenverlauf (Ordnungsamt-Korrespondenz + eigene Mails) samt
    //    Anhängen löschen – enthält Absenderadresse/Signatur des Erstatters.
    const [reportRows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM reports WHERE user_id = ?',
      [userId]
    )
    if (reportRows.length) {
      const ids = reportRows.map((r) => r.id)
      const ph = ids.map(() => '?').join(',')
      const [replyRows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM report_replies WHERE report_id IN (${ph})`,
        ids
      )
      for (const r of replyRows) {
        await fs.rm(path.dirname(replyAttachmentPath(r.id, 'x')), { recursive: true, force: true })
      }
      if (replyRows.length) {
        await pool.execute(
          `DELETE FROM report_replies WHERE id IN (${replyRows.map(() => '?').join(',')})`,
          replyRows.map((r) => r.id)
        )
      }
    }

    // 2) Erzeugte PDFs löschen – das amtliche Formular enthält Name/Anschrift/
    //    E-Mail des Erstatters. Die Sach-Anzeige (Fotos, Tatort) bleibt erhalten.
    await fs.rm(path.join(PDF_DIR, String(userId)), { recursive: true, force: true })
    await pool.execute('UPDATE reports SET pdf_filename = NULL WHERE user_id = ?', [userId])

    // 3) users-Zeile scrubben (Profil leeren, E-Mail durch eindeutigen
    //    Platzhalter ersetzen, Konto als anonymisiert markieren = Login gesperrt).
    const platzhalter = `geloescht-${userId}-${crypto.randomBytes(4).toString('hex')}@anonym.invalid`
    await pool.execute(
      `UPDATE users
          SET vorname=NULL, nachname=NULL, strasse=NULL, plz=NULL, ort=NULL, telefon=NULL,
              email=?, anonymized_at=NOW(),
              email_change_neu=NULL, email_change_token=NULL, email_change_expires=NULL
        WHERE id=?`,
      [platzhalter, userId]
    )

    // 4) Login der bisherigen Adresse entwerten, Session beenden. report_images
    //    und die Dateien unter data/uploads/<userId>/ bleiben bewusst erhalten.
    await pool.execute('UPDATE login_tokens SET used_at = NOW() WHERE used_at IS NULL AND email = ?', [
      request.session.userEmail || '',
    ])
    await request.session.destroy()
    app.log.info({ userId }, 'Konto anonymisiert (Anzeigen bleiben ohne Personenbezug erhalten)')
    return reply.redirect('/')
  })

  // DSGVO-Datenexport (Art. 15/20): ZIP mit ALLEN gespeicherten Daten des
  // Nutzers – daten.json (maschinenlesbar) plus sämtliche Dateien (Beweisfotos
  // inkl. Originalen, PDFs, Mail-Anhänge, unzugeordnete Import-Fotos).
  // Sitzungs-/Anmelde-Artefakte (Sessions, Einmal-Tokens) sind flüchtige
  // Sicherheitsdaten und nicht Teil des Exports.
  app.get('/einstellungen/export', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number

    const [users] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, email, vorname, nachname, strasse, plz, ort, telefon, created_at
         FROM users WHERE id = ?`,
      [userId]
    )
    const [reports] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM reports WHERE user_id = ? ORDER BY id',
      [userId]
    )
    const reportIds = reports.map((r) => r.id)
    const ph = reportIds.map(() => '?').join(',')

    let images: mysql.RowDataPacket[] = []
    let replies: mysql.RowDataPacket[] = []
    let attachments: mysql.RowDataPacket[] = []
    if (reportIds.length) {
      ;[images] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, report_id, filename, original_filename, mimetype, sort_order,
                captured_at, gps_lat, gps_lon, created_at
           FROM report_images WHERE report_id IN (${ph}) ORDER BY report_id, sort_order`,
        reportIds
      )
      ;[replies] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, report_id, direction, from_address, subject, body_text, received_at, read_at
           FROM report_replies WHERE report_id IN (${ph}) ORDER BY report_id, id`,
        reportIds
      )
      if (replies.length) {
        const rph = replies.map(() => '?').join(',')
        ;[attachments] = await pool.execute<mysql.RowDataPacket[]>(
          `SELECT id, reply_id, filename, original_filename, mimetype, size_bytes, created_at
             FROM report_reply_attachments WHERE reply_id IN (${rph}) ORDER BY reply_id, id`,
          replies.map((r) => r.id)
        )
      }
    }
    const [batches] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, status, created_at, grouped_at FROM intake_batches WHERE user_id = ? ORDER BY id',
      [userId]
    )
    const [intakePhotos] = batches.length
      ? await pool.execute<mysql.RowDataPacket[]>(
          `SELECT id, batch_id, filename, upload_name, captured_at, gps_lat, gps_lon, created_at
             FROM intake_photos
            WHERE batch_id IN (${batches.map(() => '?').join(',')}) AND report_id IS NULL`,
          batches.map((b) => b.id)
        )
      : [[] as mysql.RowDataPacket[]]

    // Zu packende Dateien einsammeln: Zip-Pfad -> absoluter Pfad auf Platte.
    // (Fehlende Dateien werden übersprungen, damit der Export nie scheitert.)
    const files: { zipPath: string; absPath: string }[] = []
    const azById = new Map(reports.map((r) => [r.id, r.aktenzeichen]))

    for (const r of reports) {
      const dir = `anzeigen/${safeName(r.aktenzeichen || String(r.id))}`
      if (r.pdf_filename) {
        files.push({ zipPath: `${dir}/${safeName(r.pdf_filename)}`, absPath: path.join(PDF_DIR, String(userId), r.pdf_filename) })
      }
    }
    for (const i of images) {
      const dir = `anzeigen/${safeName(azById.get(i.report_id) || String(i.report_id))}/fotos`
      const nr = String(i.sort_order || 0).padStart(2, '0')
      i.datei = `${dir}/${nr}-${safeName(i.filename)}`
      files.push({ zipPath: i.datei, absPath: path.join(reportDir(userId, i.report_id), i.filename) })
      if (i.original_filename && i.original_filename !== i.filename) {
        i.original_datei = `${dir}/${nr}-original-${safeName(i.original_filename)}`
        files.push({ zipPath: i.original_datei, absPath: path.join(reportDir(userId, i.report_id), i.original_filename) })
      }
    }
    const replyById = new Map(replies.map((r) => [r.id, r]))
    for (const a of attachments) {
      const az = azById.get(replyById.get(a.reply_id)?.report_id) || 'unbekannt'
      a.datei = `anzeigen/${safeName(az)}/nachrichten/anhang-${a.id}-${safeName(a.original_filename || a.filename)}`
      files.push({ zipPath: a.datei, absPath: replyAttachmentPath(a.reply_id, a.filename) })
    }
    for (const p of intakePhotos) {
      p.datei = `foto-import/batch-${p.batch_id}/${safeName(p.upload_name || p.filename)}`
      files.push({
        zipPath: p.datei,
        absPath: path.join(UPLOAD_DIR, String(userId), 'intake', String(p.batch_id), p.filename),
      })
    }

    const strip = ({ filename, ...rest }: Record<string, unknown>) => rest // interne Dateinamen nicht exportieren
    const exportData = {
      hinweis:
        'Datenexport gemäß Art. 15/20 DSGVO. Alle Dateien (Fotos, PDFs, Anhänge) liegen in diesem ZIP; die "datei"-Felder verweisen auf die Pfade im Archiv.',
      exportiert_am: new Date().toISOString(),
      nutzer: users[0],
      anzeigen: reports.map((r) => ({
        ...r,
        pdf_datei: r.pdf_filename ? `anzeigen/${safeName(r.aktenzeichen || String(r.id))}/${safeName(r.pdf_filename)}` : null,
        fotos: images.filter((i) => i.report_id === r.id).map(strip),
        nachrichten: replies
          .filter((m) => m.report_id === r.id)
          .map((m) => ({
            ...m,
            anhaenge: attachments.filter((a) => a.reply_id === m.id).map(strip),
          })),
      })),
      foto_importe: batches.map((b) => ({
        ...b,
        nicht_zugeordnete_fotos: intakePhotos.filter((p) => p.batch_id === b.id).map(strip),
      })),
    }

    // ZIP streamen: daten.json + alle vorhandenen Dateien.
    const datum = new Date().toISOString().slice(0, 10)
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="owia-datenexport-${datum}.zip"`)

    const archive = new ZipArchive({ zlib: { level: 6 } })
    archive.on('warning', (err: Error) => app.log.warn({ err }, 'DSGVO-Export: Warnung'))
    archive.on('error', (err: Error) => app.log.error({ err }, 'DSGVO-Export: Fehler'))

    // index.html: menschenlesbare Übersicht des Exports. Komplett offline
    // (inline-CSS, keine externen Ressourcen); Fotos/PDFs/Anhänge werden über
    // ihre relativen Pfade im entpackten ZIP eingebunden.
    const u = users[0] || {}
    const statusLabel: Record<string, string> = {
      entwurf: 'Entwurf',
      eingereicht: 'Eingereicht (in Prüfung)',
      versendet: 'Versendet',
    }
    const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>OWiA-Anzeiger – Datenexport ${esc(datum)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 2rem; } h3 { font-size: 1rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .muted { color: #666; font-size: .875rem; }
  table { border-collapse: collapse; } td { padding: .15rem .75rem .15rem 0; vertical-align: top; }
  td:first-child { color: #666; white-space: nowrap; }
  .fotos { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0; }
  .fotos a { display: block; } .fotos img { height: 110px; border-radius: 6px; border: 1px solid #ccc; }
  .msg { border-left: 4px solid #0d6efd; padding: .5rem .75rem; margin: .5rem 0; border-radius: 4px; background: #f8f9fa; white-space: pre-wrap; }
  .msg.out { border-left-color: #6c757d; background: #f1f3f5; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; background: #e9ecef; }
  a { color: #0d6efd; }
</style>
</head>
<body>
<h1>🚗 OWiA-Anzeiger – Datenexport</h1>
<p class="muted">Erstellt am ${esc(fmtDate(new Date()))} · gemäß Art. 15/20 DSGVO ·
maschinenlesbare Fassung: <a href="daten.json">daten.json</a></p>

<h2>Profil</h2>
<div class="card"><table>
<tr><td>E-Mail</td><td>${esc(u.email)}</td></tr>
<tr><td>Name</td><td>${esc([u.vorname, u.nachname].filter(Boolean).join(' ') || '—')}</td></tr>
<tr><td>Anschrift</td><td>${esc([u.strasse, [u.plz, u.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—')}</td></tr>
<tr><td>Telefon</td><td>${esc(u.telefon || '—')}</td></tr>
<tr><td>Konto erstellt</td><td>${esc(fmtDate(u.created_at))}</td></tr>
</table></div>

<h2>Anzeigen (${reports.length})</h2>
${reports
  .map((r) => {
    const dirAz = safeName(r.aktenzeichen || String(r.id))
    const fotos = images.filter((i) => i.report_id === r.id)
    const msgs = replies.filter((m) => m.report_id === r.id)
    return `<div class="card">
<h3>${esc(r.aktenzeichen)} <span class="badge">${esc(statusLabel[r.status] || r.status)}</span></h3>
<table>
<tr><td>Kennzeichen</td><td>${esc(r.kennzeichen || '—')}${r.kennzeichen_land && r.kennzeichen_land !== 'D' ? ` (${esc(r.kennzeichen_land)})` : ''}</td></tr>
<tr><td>Tattag / Zeit</td><td>${esc(r.tattag ? new Date(r.tattag).toLocaleDateString('de-DE') : '—')}${r.tatzeit_von ? `, ${esc(String(r.tatzeit_von).slice(0, 5))}${r.tatzeit_bis ? ` – ${esc(String(r.tatzeit_bis).slice(0, 5))}` : ''} Uhr` : ''}</td></tr>
<tr><td>Tatort</td><td>${esc(r.tatort || '—')}</td></tr>
<tr><td>Verstoß</td><td>${esc(r.verstoss_art || '—')}${r.fahrzeug_verlassen === 1 ? ' · Fahrzeug war verlassen' : ''}</td></tr>
${r.beschreibung ? `<tr><td>Beschreibung</td><td>${esc(r.beschreibung)}</td></tr>` : ''}
<tr><td>Behinderung</td><td>${r.behinderung === 1 ? `Ja${r.behinderung_text ? ` – ${esc(r.behinderung_text)}` : ''}` : 'Nein'}</td></tr>
${r.ablehnung_grund ? `<tr><td>Ablehnungsgrund</td><td>${esc(r.ablehnung_grund)}</td></tr>` : ''}
<tr><td>Erstellt</td><td>${esc(fmtDate(r.created_at))}</td></tr>
${r.pdf_filename ? `<tr><td>PDF</td><td><a href="anzeigen/${esc(dirAz)}/${esc(safeName(r.pdf_filename))}">${esc(safeName(r.pdf_filename))}</a></td></tr>` : ''}
</table>
${fotos.length ? `<div class="fotos">${fotos.map((f) => `<a href="${esc(f.datei)}"><img src="${esc(f.datei)}" alt="Beweisfoto" loading="lazy"></a>`).join('')}</div>` : ''}
${msgs.length ? `<h3>Nachrichtenverlauf</h3>${msgs
      .map((m) => {
        const anh = attachments.filter((a) => a.reply_id === m.id)
        return `<div class="msg${m.direction === 'out' ? ' out' : ''}">
<span class="muted">${m.direction === 'out' ? 'Gesendet' : 'Empfangen'} · ${esc(fmtDate(m.received_at))}${m.subject ? ` · ${esc(m.subject)}` : ''}</span>

${esc(m.body_text || '(kein Text)')}${anh.length ? `\n\n${anh.map((a) => `📎 <a href="${esc(a.datei)}">${esc(a.original_filename || 'Anhang')}</a>`).join(' · ')}` : ''}</div>`
      })
      .join('')}` : ''}
</div>`
  })
  .join('')}

${intakePhotos.length ? `<h2>Nicht zugeordnete Import-Fotos (${intakePhotos.length})</h2>
<div class="card"><div class="fotos">${intakePhotos.map((p) => `<a href="${esc(p.datei)}"><img src="${esc(p.datei)}" alt="Import-Foto" loading="lazy"></a>`).join('')}</div></div>` : ''}

<p class="muted">Sitzungs- und Anmelde-Daten (Sessions, Einmal-Codes) sind flüchtige
Sicherheitsartefakte und nicht Teil dieses Exports.</p>
</body>
</html>
`

    archive.append(html, { name: 'index.html' })
    archive.append(JSON.stringify(exportData, null, 2), { name: 'daten.json' })
    for (const f of files) {
      try {
        await fs.access(f.absPath)
        archive.file(f.absPath, { name: f.zipPath })
      } catch {
        app.log.warn({ file: f.absPath }, 'DSGVO-Export: Datei fehlt – übersprungen')
      }
    }
    void archive.finalize()
    return reply.send(archive)
  })
}
