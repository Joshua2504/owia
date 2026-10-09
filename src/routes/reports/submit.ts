// Einreichen einer Anzeige: PDF-Download, Einreichen-Vorschau, Submit und
// Zurückziehen sowie die gemeinsame Prüfliste (submitProblems, auch vom
// Prüf-Modus und vom Portal-Versand genutzt).
import { isVerjaehrt, verjaehrung } from '../../services/verjaehrung'
import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../../db/connection'
import { requireAuth, setFlash } from '../../middleware/auth'
import { getCity, hasPdfForm } from '../../config/cities'
import { resolveSendCity, cityEmail } from '../../services/districts'
import { fahrzeugBeschreibung } from '../../config/fahrzeug'
import { portalFuer } from '../../services/portale'
import { dritteFunde, fundeText } from '../../services/dritte'
import { imageVersion } from '../../services/images'
import { PDF_DIR } from '../../services/drafts'
import { isAdminEmail } from '../../config/admin'
import { enqueueJob } from '../../services/jobs'
import { enqueuePortalStart } from '../../services/portalDispatch'
import { previewReportMail } from '../../services/mail'
import { loadReportByAktenzeichen, isProfileComplete, regeneratePdf, enqueuePdf, countUncheckedImages, uncheckedMessage } from './shared'

export default async function submitRoutes(app: FastifyInstance) {
  app.get('/anzeige/:az/pdf', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const inline = (request.query as { inline?: string }).inline === '1'
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT pdf_filename FROM reports WHERE aktenzeichen = ? AND user_id = ?',
      [az, userId]
    )
    const report = rows[0]
    if (!report?.pdf_filename) return reply.status(404).send('PDF nicht verfügbar.')

    const pdfPath = path.join(PDF_DIR, String(userId), report.pdf_filename)
    try {
      const buffer = await fs.readFile(pdfPath)
      const disposition = inline ? 'inline' : 'attachment'
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="${report.pdf_filename}"`)
        .send(buffer)
    } catch {
      return reply.status(404).send('PDF-Datei nicht gefunden.')
    }
  })

  // Vorschau vor dem Einreichen (Modal in der Anzeigen-Liste, report-submit.js):
  // erzeugt das PDF frisch und liefert alle Angaben samt ALLER Hinderungsgründe
  // (gleiche Prüfungen wie /submit, dort bricht die erste ab). Die zuständige
  // Stadt wird wie beim Einreichen aus dem Tatort festgeschrieben, damit PDF-
  // Formular und Empfänger in der Vorschau stimmen.
  app.post('/anzeige/:az/einreichen-vorschau', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send({ error: 'Anzeige nicht gefunden.' })
    if (report.status !== 'entwurf') return reply.status(409).send({ error: 'Die Anzeige ist bereits eingereicht.' })

    const problems = await submitProblems(report, userId)

    const city = getCity(report.city)
    await regeneratePdf(report.id, userId)
    const [fresh] = await pool.execute<mysql.RowDataPacket[]>('SELECT pdf_filename FROM reports WHERE id=?', [report.id])
    const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, filename FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
      [report.id]
    )
    // Mail-Städte (weder PDF noch Portal): den echten Mailtext samt Anhängen
    // zeigen, damit der Nutzer sieht, was beim Amt ankommt.
    let mail: Awaited<ReturnType<typeof previewReportMail>> | null = null
    if (!hasPdfForm(city) && !city.portal) {
      const [users] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM users WHERE id = ?', [userId])
      if (users[0]) {
        mail = await previewReportMail(report, users[0])
        if (mail.problem) problems.push({ kind: 'mail', message: mail.problem })
      }
    }
    const fmtDate = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('de-DE') : null)
    const hhmm = (t: unknown) => (t ? String(t).slice(0, 5) : null)
    const vj = verjaehrung(report)
    return reply.send({
      az,
      canSubmit: problems.length === 0,
      problems,
      fields: {
        kennzeichen: report.kennzeichen,
        fahrzeug_marke: report.fahrzeug_marke,
        fahrzeug: fahrzeugBeschreibung(report),
        verstoss_variante: report.verstoss_variante,
        tattag: fmtDate(report.tattag),
        tattag_bis: report.tattag_bis ? fmtDate(report.tattag_bis) : null,
        tatzeit_von: hhmm(report.tatzeit_von),
        tatzeit_bis: hhmm(report.tatzeit_bis),
        tatort: report.tatort,
        verstoss_art: report.verstoss_art,
        beschreibung: report.beschreibung,
        fahrzeug_verlassen: report.fahrzeug_verlassen === 1,
        behinderung: report.behinderung === 1,
        behinderung_text: report.behinderung_text,
      },
      recipient: { ordnungsamt: city.ordnungsamt, email: cityEmail(city) || '' },
      versandweg: city.portal ? 'portal' : hasPdfForm(city) ? 'pdf' : 'mail',
      hinweise: city.hinweise || city.mail?.hinweise || [],
      mail: mail && { subject: mail.subject, text: mail.text, attachments: mail.attachments },
      verjaehrung: vj.bald ? { restTage: vj.restTage } : null,
      pdfUrl: hasPdfForm(city) && fresh[0]?.pdf_filename ? `/anzeige/${az}/pdf?inline=1&t=${Date.now()}` : null,
      images: imgs.map((i) => ({
        thumb: `/anzeige/${az}/image/${i.id}/thumb.jpg?v=${imageVersion(i.filename)}`,
        full: `/anzeige/${az}/image/${i.id}?v=${imageVersion(i.filename)}`,
      })),
    })
  })

  // Anzeige zur Prüfung einreichen: ein Admin gibt sie frei und verschickt sie
  // ans Ordnungsamt. Nutzer versenden nicht mehr selbst. Die Prüfungen und der
  // Statuswechsel stecken in submitDraft() (auch vom Sammel-Einreichen genutzt).
  app.post('/anzeige/:az/submit', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    // „Speichern & Einreichen" im Editor schickt per fetch (Accept: JSON) und
    // zeigt Fehler direkt an, statt umzuleiten.
    const json = String(request.headers.accept || '').includes('application/json')
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'entwurf') {
      return json ? reply.status(409).send({ error: 'Die Anzeige ist bereits eingereicht.' }) : reply.redirect(`/anzeige/${az}`)
    }
    // Admins dürfen eigene Anzeigen direkt freigeben und versenden (?sofort=1) –
    // dann entfällt die Prüf-Benachrichtigung.
    const sofort = (request.query as { sofort?: string }).sofort === '1' && isAdminEmail(request.session.userEmail)
    const out = await submitDraft(report, userId, { sofort, userEmail: request.session.userEmail || '' })
    if (!out.ok) {
      if (json) return reply.status(out.status).send({ error: out.message, redirect: out.redirect })
      if (out.status === 409) return reply.redirect(`/anzeige/${az}`)
      setFlash(reply, 'error', out.message)
      return reply.redirect(out.redirect)
    }
    if (out.portal) {
      if (json) return reply.send({ ok: true, sent: false, queued: true, portal: out.portal })
      return reply.redirect(out.portal)
    }
    if (json) return reply.send(out.queued ? { ok: true, sent: false, queued: true } : { ok: true })
    setFlash(reply, 'success', out.queued
      ? 'Anzeige eingereicht – der Versand ans Ordnungsamt läuft im Hintergrund.'
      : 'Anzeige eingereicht – sie wird geprüft und dann ans Ordnungsamt verschickt.')
    return reply.redirect(`/anzeige/${az}`)
  })

  // Eingereichte Anzeige zurückziehen (wird wieder bearbeitbarer Entwurf).
  app.post('/anzeige/:az/withdraw', { preHandler: requireAuth }, async (request, reply) => {
    const { az } = request.params as { az: string }
    const userId = request.session.userId as number
    const report = await loadReportByAktenzeichen(az, userId)
    if (!report) return reply.status(404).send('Anzeige nicht gefunden.')
    if (report.status !== 'eingereicht') return reply.redirect(`/anzeige/${az}`)

    const [withdrawn] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE reports SET status='entwurf', eingereicht_at=NULL WHERE id=? AND status='eingereicht' AND versand_status IS NULL",
      [report.id]
    )
    if (!withdrawn.affectedRows) {
      setFlash(reply, 'error', 'Die Anzeige wird bereits versendet und kann nicht zurückgezogen werden.')
      return reply.redirect(`/anzeige/${az}`)
    }
    setFlash(reply, 'success', 'Anzeige zurückgezogen – sie ist wieder ein Entwurf.')
    return reply.redirect(`/anzeige/${az}/bearbeiten`)
  })
}

export type SubmitOutcome =
  | { ok: true; portal?: string; queued?: boolean }
  | { ok: false; status: 409 | 422; message: string; redirect: string }

/** Entwurf einreichen: alle Hinderungsgründe prüfen (submitProblems), den
 *  Status atomar auf 'eingereicht' setzen und die Folgearbeit (PDF, Admin-
 *  Benachrichtigung bzw. Sofortversand) als Jobs einreihen. Nach dem
 *  Statuswechsel werden die Foto-Prüfungen wiederholt: Ein parallel laufender
 *  Upload oder eine Feldänderung zwischen Prüfung und Wechsel würde sonst eine
 *  ungeprüfte Anzeige durchlassen – in dem Fall geht sie zurück auf Entwurf. */
export async function submitDraft(
  report: mysql.RowDataPacket,
  userId: number,
  opts: { sofort?: boolean; userEmail?: string } = {}
): Promise<SubmitOutcome> {
  const az = report.aktenzeichen as string
  if (report.status !== 'entwurf') return { ok: false, status: 409, message: 'Die Anzeige ist bereits eingereicht.', redirect: `/anzeige/${az}` }
  const problems = await submitProblems(report, userId)
  if (problems.length) {
    const p = problems[0]
    const redirect = p.link
      || (p.kind === 'fields' || p.kind === 'variante' || p.kind === 'city' ? `/anzeige/${az}/bearbeiten`
        : p.kind === 'photos' || p.kind === 'dritte' ? '/anzeigen' : `/anzeige/${az}`)
    const message = p.kind === 'fields' ? p.message.replace(/^Es fehlt: /, 'Bitte zuerst alle Pflichtfelder ausfüllen (es fehlt: ').replace(/\.$/, ').') : p.message
    return { ok: false, status: 422, message, redirect }
  }

  // Eine frühere Ablehnung ist mit der Wiedervorlage erledigt; den Grund vorher
  // sichern – die Admin-Mail weist darauf hin.
  const vorherigeAblehnung = report.ablehnung_grund as string | null
  const [submitted] = await pool.execute<mysql.ResultSetHeader>(
    "UPDATE reports SET status='eingereicht', eingereicht_at=NOW(), ablehnung_grund=NULL WHERE id=? AND status='entwurf' AND versand_status IS NULL",
    [report.id]
  )
  if (!submitted.affectedRows) return { ok: false, status: 409, message: 'Die Anzeige wird bereits bearbeitet.', redirect: `/anzeige/${az}` }

  // Nachprüfung nach dem Statuswechsel (siehe oben): Fotos, die zwischen
  // Prüfung und Wechsel dazukamen, sind ungeprüft – dann zurück auf Entwurf.
  const unchecked = await countUncheckedImages(report.id)
  const dritte = unchecked ? null : await drittProblem(report)
  if (unchecked || dritte) {
    await pool.execute(
      "UPDATE reports SET status='entwurf', eingereicht_at=NULL, ablehnung_grund=? WHERE id=? AND status='eingereicht' AND versand_status IS NULL",
      [vorherigeAblehnung, report.id]
    )
    return { ok: false, status: 422, message: unchecked ? uncheckedMessage(unchecked) : dritte!, redirect: '/anzeigen' }
  }

  // Admins dürfen eigene Anzeigen direkt freigeben und versenden (sofort) –
  // dann entfällt die Prüf-Benachrichtigung. PDF + Versand laufen als Job
  // (routes/admin.ts, 'report.dispatch'); Portal-Städte versendet die
  // Live-Seite /versand (Lauf startet sofort, services/portalDispatch.ts).
  if (opts.sofort && getCity(report.city).portal) {
    // Lauf startet sofort im Hintergrund; ein Hinderungsgrund zeigt /versand an der Anzeige.
    await enqueuePortalStart(Number(report.id))
    return { ok: true, portal: `/versand?az=${encodeURIComponent(az)}` }
  }
  if (opts.sofort) {
    await enqueueJob('report.dispatch', { reportId: report.id, aktenzeichen: az }, { key: `report.dispatch:${report.id}`, maxAttempts: 1 })
    return { ok: true, queued: true }
  }
  // PDF auf den letzten Stand bringen (die Admin-Prüfung zeigt es an), danach
  // die Admins informieren – sonst kann eine Einreichung unbemerkt liegenbleiben.
  await enqueuePdf(report.id, userId)
  await enqueueJob('mail.submit-notification', {
    reportId: report.id, userId, userEmail: opts.userEmail || '', vorherigeAblehnung,
  })
  return { ok: true }
}

/** Was einer Einreichung noch im Weg steht – gemeinsame Prüfliste für die
 *  Einreichen-Vorschau und den Prüf-Modus (routes/review.ts). Muss zu den
 *  Prüfungen in POST /anzeige/:az/submit passen, sonst zeigt die Vorschau
 *  „einreichbar" und der Submit lehnt trotzdem ab. Seiteneffekt wie beim
 *  Submit: Weicht die aus dem Tatort ermittelte Stadt ab, wird sie
 *  festgeschrieben (report.city wird mit aktualisiert). */
/** Passt die Bestätigung (Häkchen „geprüft") zum aktuellen Kennzeichen? */
export function kennzeichenBestaetigt(report: mysql.RowDataPacket): boolean {
  return !!report.kennzeichen && report.kennzeichen_bestaetigt === `${report.kennzeichen_land || 'D'}|${report.kennzeichen}`
}

export async function submitProblems(
  report: mysql.RowDataPacket,
  userId: number
): Promise<{ message: string; link?: string; kind?: string }[]> {
  const problems: { message: string; link?: string; kind?: string }[] = []
  const missing = [
    !report.kennzeichen && 'Kennzeichen',
    !report.tattag && 'Tattag',
    !report.tatzeit_von && 'Uhrzeit',
    !report.tatort && 'Tatort',
    !report.verstoss_art && 'Verstoß',
  ].filter(Boolean)
  if (missing.length) problems.push({ kind: 'fields', message: `Es fehlt: ${missing.join(', ')}.` })
  if (report.kennzeichen && !kennzeichenBestaetigt(report)) {
    problems.push({ kind: 'kennzeichen', message: 'Bitte das Kennzeichen prüfen und als geprüft bestätigen.' })
  }
  const vjStatus = verjaehrung(report)
  if (vjStatus.verjaehrt) problems.push({ kind: 'verjaehrt', message: vjStatus.text })
  const unchecked = await countUncheckedImages(report.id)
  if (unchecked) problems.push({ kind: 'photos', message: uncheckedMessage(unchecked) })
  if (!(await isProfileComplete(userId))) {
    problems.push({ kind: 'profile', message: 'Dein Profil ist unvollständig (Name und Anschrift mit Hausnummer).', link: '/einstellungen' })
  }
  if (report.tatort) {
    const gate = resolveSendCity(report.tatort, report.city)
    if (!gate.ok) problems.push({ kind: 'city', message: gate.message })
    else if (gate.cityId !== report.city) {
      await pool.execute("UPDATE reports SET city=? WHERE id=? AND status='entwurf'", [gate.cityId, report.id])
      report.city = gate.cityId
    }
  }
  // Das Frankfurter Portal verlangt die Marke als Pflichtauswahl.
  if (getCity(report.city).portal === 'ekom21-ffm' && !String(report.fahrzeug_marke || '').trim()) {
    problems.push({ kind: 'fields', message: 'Es fehlt: Marke.' })
  }
  if (report.verstoss_art) {
    const p = await portalProblemFuer(report, report.city, userId)
    // Abgelaufene Annahmefrist meldet schon „verjaehrt" (gleicher Grund).
    if (p && !(vjStatus.verjaehrt && /zwei Monate/.test(p))) problems.push({ kind: 'variante', message: p })
  }
  const dritte = await drittProblem(report)
  if (dritte) problems.push({ kind: 'dritte', message: dritte })
  return problems
}

/** Was das Online-Portal der Stadt (falls vorhanden) noch braucht – Tatbestand,
 *  Variante, Fristen, Profilangaben (services/portale.ts). */
async function portalProblemFuer(report: mysql.RowDataPacket, cityId: string, userId: number): Promise<string | null> {
  const adapter = portalFuer(cityId)
  if (!adapter) return null
  if (report.verstoss_art && !adapter.versendbar(report.verstoss_art)) {
    return 'Diesen Tatbestand bietet das Portal der Stadt nicht an – bitte einen passenden Verstoß wählen.'
  }
  const [users] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM users WHERE id = ?', [userId])
  return adapter.problem(report, users[0] ?? null)
}

/** Datenschutz: Fotos mit fremden Kennzeichen oder Gesichtern, die weder
 *  geschwärzt noch als unbedenklich bestätigt sind (services/dritte.ts). */
export async function drittProblem(report: mysql.RowDataPacket): Promise<string | null> {
  const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT analyse_json, dritte_ok FROM report_images WHERE report_id = ? ORDER BY sort_order, id',
    [report.id]
  )
  const teile: string[] = []
  imgs.forEach((img, i) => {
    if (img.dritte_ok) return
    const funde = dritteFunde(img.analyse_json, report.kennzeichen)
    if (funde.length) teile.push(`Foto ${i + 1}: ${fundeText(funde)}`)
  })
  return teile.length ? `Daten Dritter erkennbar – ${teile.join('; ')}. Bitte schwärzen oder im Foto als unbedenklich bestätigen.` : null
}
