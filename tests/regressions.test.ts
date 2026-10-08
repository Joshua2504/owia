import assert from 'node:assert/strict'
import { before, after, test, mock } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import ejs from 'ejs'
import { verjaehrung } from '../src/services/verjaehrung'
import { aggregiere } from '../src/services/statistik'
import { regelsatzEuro, VERSTOESSE } from '../src/config/verstoss'
import { portalTatbestand, verstossVarianten, langparkerVariante, tatDauerMinuten, photoRoles, portalProblem, buildPortalPayload, portalTatzeit, tatortText } from '../src/services/portalFfm'
import { portalMarke, fahrzeugBeschreibung } from '../src/config/fahrzeug'
import { wiTatbestand, wiProblem, buildWiPayload } from '../src/services/portalWi'
import { buildMzPayload, tatortTeile, mzProblem, mzFotos } from '../src/services/portalMz'
import { portalFuer, verstossGesperrt, verstossSperren } from '../src/services/portale'
import { getCityByName } from '../src/config/cities'
import { pool } from '../src/db/connection'
import { initDb } from '../src/db/init'
import { runMigrations } from '../src/db/migrate'
import { dispatchReport } from '../src/services/reportDispatch'
import { resumeWatchers } from '../src/services/portalDispatch'
import { consumeLoginCode, consumeMagicLink, MAX_LOGIN_ATTEMPTS } from '../src/services/loginTokens'
import { processInboundMail, repliesDir } from '../src/services/mailInbox'
import { MailService } from '../src/services/mail'
import adminRoutes from '../src/routes/admin'
import reportsRoutes from '../src/routes/reports'
import settingsRoutes from '../src/routes/settings'
import { trashDrafts, restoreDrafts, purgeTrash } from '../src/services/drafts'
import { groupPhotos } from '../src/services/intakeGrouping'
import { resolveSendCity } from '../src/services/districts'
import { assertProductionMailConfig } from '../src/config/mail'
import view from '@fastify/view'
import { PDFDocument } from 'pdf-lib'
import stickerRoutes from '../src/routes/sticker'
import {
  createBatch, linkCode, unlinkCode, voidOpenCodes, normalizeCode, parseLayout, renderBatchPdf,
  batchCodes, StickerLayout,
} from '../src/services/stickers'

// Harte Schranke: Diese Suite darf niemals auf einer vorhandenen DB laufen.
if (process.env.OWIA_TEST_ONLY !== '1' || process.env.DB_NAME !== 'owia_test' || process.env.DB_HOST !== 'db') {
  throw new Error('Tests ausschließlich über npm test in der isolierten Compose-Umgebung ausführen.')
}
const logger = Fastify({ logger: false }).log
let userId: number
let counter = 0
async function query(sql: string, values: (string | number | null)[] = []) {
  return (await pool.execute<mysql.RowDataPacket[]>(sql, values))[0]
}
async function report(ownerId = userId) {
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO reports(user_id, aktenzeichen, status, city, tatort, kennzeichen)
     VALUES (?, ?, 'eingereicht', 'badsoden', 'Kurpark, 63628 Bad Soden-Salmünster', 'M KK 123')`,
    [ownerId, `OWiA-${String(++counter).padStart(6, '0')}`]
  )
  return result.insertId
}
async function token() {
  const email = `login-${++counter}@example.invalid`
  const value = `test-token-${counter}`
  await pool.execute(
    `INSERT INTO login_tokens(email, code, token, expires_at) VALUES (?, '123456', ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))`,
    [email, value]
  )
  return { email, value }
}
function prepared(messageId: string, send: () => Promise<void>) {
  return { messageId, subject: 'Testanzeige', text: 'Nur Testdaten', from: 'owia@example.invalid', send }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

before(async () => {
  await initDb()
  // Wiederholter Boot darf weder Migrationen duplizieren noch scheitern.
  await runMigrations()
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO users(email, vorname, nachname, strasse, hausnummer, plz, ort)
     VALUES ('user@example.invalid', 'Test', 'Nutzer', 'Testweg', '1', '63628', 'Testort')`
  )
  userId = result.insertId
})
after(async () => { await pool.end() })

test('Migrationen sind vollständig und wiederholbar', async () => {
  const rows = await query('SELECT filename FROM schema_migrations ORDER BY filename')
  assert.equal(rows.at(-1)?.filename, '0043_kennzeichen_bestaetigt.sql')
  assert.equal(rows.length, 43)
})

test('Löschen verschiebt Entwürfe in den Papierkorb, Wiederherstellen und Ablauf funktionieren', async () => {
  const id = await report()
  await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
  const sent = await report() // eingereicht – darf nicht im Papierkorb landen
  assert.equal(await trashDrafts(userId, [id, sent]), 1)
  assert.equal((await query('SELECT status FROM reports WHERE id=?', [id]))[0].status, 'papierkorb')
  assert.equal(await restoreDrafts(userId, [id]), 1)
  assert.equal((await query('SELECT status, papierkorb_at FROM reports WHERE id=?', [id]))[0].papierkorb_at, null)
  await trashDrafts(userId, [id])
  assert.equal(await purgeTrash(), 0) // noch nicht abgelaufen
  await pool.execute('UPDATE reports SET papierkorb_at = DATE_SUB(NOW(), INTERVAL 31 DAY) WHERE id=?', [id])
  assert.equal(await purgeTrash(), 1)
  assert.equal((await query('SELECT COUNT(*) n FROM reports WHERE id=?', [id]))[0].n, 0)
})

test('Parallele Freigaben versenden genau einmal und speichern genau eine Nachricht', async () => {
  const id = await report()
  let sent = 0
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    dispatchReport(id, async messageId => prepared(messageId, async () => { sent++ }))
  ))
  assert.equal(sent, 1)
  assert.ok(results.includes('sent'))
  assert.equal((await query('SELECT status FROM reports WHERE id=?', [id]))[0].status, 'versendet')
  assert.equal((await query('SELECT COUNT(*) n FROM report_replies WHERE report_id=?', [id]))[0].n, 1)
})

test('Vorbereitungsfehler erlauben einen späteren sicheren Versuch', async () => {
  const id = await report()
  await assert.rejects(dispatchReport(id, async () => { throw new Error('PDF fehlt') }))
  assert.equal((await query('SELECT versand_status FROM reports WHERE id=?', [id]))[0].versand_status, null)
  assert.equal(await dispatchReport(id, async messageId => prepared(messageId, async () => {})), 'sent')
})

test('Unklarer SMTP-Ausgang bleibt gesperrt, auch bei erneuter Freigabe', async () => {
  const id = await report()
  let sent = 0
  const prepare = async (messageId: string) => prepared(messageId, async () => {
    sent++
    throw new Error('Verbindung nach DATA abgebrochen')
  })
  await assert.rejects(dispatchReport(id, prepare))
  assert.equal(await dispatchReport(id, prepare), 'uncertain')
  assert.equal(sent, 1)
  const row = (await query('SELECT * FROM reports WHERE id=?', [id]))[0]
  assert.equal(row.status, 'eingereicht')
  assert.ok(JSON.parse(row.versand_ergebnis).messageId)
})

test('SQL-Fehler nach SMTP wird ohne zweiten Versand atomar nachgeholt', async () => {
  const id = await report()
  let sent = 0
  await pool.query(`CREATE TRIGGER fail_outgoing BEFORE INSERT ON report_replies FOR EACH ROW
    BEGIN IF NEW.direction='out' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Testfehler nach SMTP'; END IF; END`)
  try {
    await assert.rejects(dispatchReport(id, async messageId => prepared(messageId, async () => { sent++ })))
    const row = (await query('SELECT status, versand_status FROM reports WHERE id=?', [id]))[0]
    assert.equal(row.status, 'eingereicht')
    assert.equal(row.versand_status, 'angenommen')
  } finally {
    await pool.query('DROP TRIGGER fail_outgoing')
  }
  const outcomes = await Promise.all([1, 2].map(() => dispatchReport(id, async () => {
    throw new Error('Darf nicht erneut vorbereitet/versendet werden')
  })))
  assert.deepEqual(outcomes, ['sent', 'sent'])
  assert.equal(sent, 1)
  assert.equal((await query('SELECT COUNT(*) n FROM report_replies WHERE report_id=?', [id]))[0].n, 1)
})

test('Prozessabbruch bei Vorbereitung führt nicht zu automatischer Wiederholung', async () => {
  const id = await report()
  await pool.execute("UPDATE reports SET versand_status='vorbereitung' WHERE id=?", [id])
  assert.equal(await dispatchReport(id, async () => { throw new Error('Nicht aufrufen') }), 'busy')
})

test('Portal-Start, den ein Neustart abbrach, beginnt komplett von vorn', async () => {
  const id = await report()
  const unklar = await report()
  await pool.execute("UPDATE reports SET versand_status='vorbereitung', versand_ergebnis=? WHERE id=?", [
    JSON.stringify({ portal: { pendingRunId: '00000000-0000-4000-8000-000000000000', startedAt: new Date().toISOString(), auto: true } }), id,
  ])
  // Nach dem Absenden-Klick verloren: bleibt unklar, kein zweiter Versand.
  await pool.execute("UPDATE reports SET versand_status='versand', versand_ergebnis=? WHERE id=?", [
    JSON.stringify({ portal: { runId: 'weg', submittedAt: new Date().toISOString(), error: 'Ergebnis unklar' } }), unklar,
  ])
  await resumeWatchers(logger)
  const [r] = await query('SELECT versand_status, versand_ergebnis FROM reports WHERE id=?', [id])
  assert.equal(r.versand_status, null)
  assert.equal(r.versand_ergebnis, null)
  const jobs = await query("SELECT payload FROM jobs WHERE type='portal.start' AND status='queued'")
  const payloads = jobs.map((j) => JSON.parse(j.payload))
  assert.deepEqual(payloads.filter((p) => p.reportId === id), [{ reportId: id, auto: true }])
  assert.equal(payloads.filter((p) => p.reportId === unklar).length, 0)
  assert.equal((await query('SELECT versand_status FROM reports WHERE id=?', [unklar]))[0].versand_status, 'versand')
  await pool.execute("DELETE FROM jobs WHERE type='portal.start'")
})

test('Zurückziehen und Ablehnen sind während des Versands gesperrt', async () => {
  const id = await report()
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  const started = deferred(), proceed = deferred()
  const dispatch = dispatchReport(id, async messageId => {
    started.resolve()
    await proceed.promise
    return prepared(messageId, async () => {})
  })
  const app = Fastify()
  await app.register(cookie)
  await app.register(formbody)
  app.addHook('preHandler', async request => {
    request.session = { userId, userEmail: 'admin@example.invalid' } as typeof request.session
  })
  await app.register(adminRoutes)
  await app.register(reportsRoutes)
  try {
    await started.promise
    for (const url of [`/anzeige/${az}/withdraw`, `/admin/anzeigen/${id}/reject`]) {
      const response = await app.inject({ method: 'POST', url, payload: { grund: 'Test' } })
      assert.equal(response.statusCode, 302)
      assert.equal((await query('SELECT status FROM reports WHERE id=?', [id]))[0].status, 'eingereicht')
    }
  } finally {
    proceed.resolve()
    await dispatch
    await app.close()
  }
})

test('Magic-Link und Code konkurrieren um genau einen Login', async () => {
  const { email, value } = await token()
  const result = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    i % 2 ? consumeMagicLink(value) : consumeLoginCode(email, '123456').then(result => result.token)
  ))
  assert.equal(result.filter(Boolean).length, 1)
  assert.equal(await consumeMagicLink(value), null)
})

test('Falsche Codes überschreiten bei Parallelität das Versuchslimit nicht', async () => {
  const { email } = await token()
  await Promise.all(Array.from({ length: 10 }, () => consumeLoginCode(email, '000000')))
  const row = (await query('SELECT attempts FROM login_tokens WHERE email=?', [email]))[0]
  assert.equal(row.attempts, MAX_LOGIN_ATTEMPTS)
  assert.equal((await consumeLoginCode(email, '123456')).token, null)
})

test('Abgelaufene Tokens erlauben weder Code- noch Link-Anmeldung', async () => {
  const { email, value } = await token()
  await pool.execute('UPDATE login_tokens SET expires_at=DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE email=?', [email])
  assert.equal(await consumeMagicLink(value), null)
  assert.equal((await consumeLoginCode(email, '123456')).token, null)
})

function inboundMail(id: string) {
  return Buffer.from([
    'From: test@example.invalid', 'To: owia@example.invalid', `Message-ID: <${id}@example.invalid>`,
    'Subject: Testantwort', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test-boundary"', '',
    '--test-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Antworttext',
    '--test-boundary', 'Content-Type: text/plain; name="beleg.txt"',
    'Content-Disposition: attachment; filename="beleg.txt"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('Vollständiger Beleg').toString('base64'), '--test-boundary--', '',
  ].join('\r\n'))
}

test('Fehler beim Speichern eines Anhangs hinterlässt keine halbe Mail; Wiederholung gelingt', async () => {
  const raw = inboundMail('retry')
  await pool.query(`CREATE TRIGGER fail_attachment BEFORE INSERT ON report_reply_attachments
    FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Testfehler Anhang'`)
  try {
    await assert.rejects(processInboundMail(raw, logger))
    assert.equal((await query("SELECT COUNT(*) n FROM report_replies WHERE message_id='<retry@example.invalid>'"))[0].n, 0)
  } finally {
    await pool.query('DROP TRIGGER fail_attachment')
  }
  const result = await processInboundMail(raw, logger)
  assert.ok(result)
  const attachments = await query('SELECT filename FROM report_reply_attachments WHERE reply_id=?', [result.replyId])
  assert.equal(attachments.length, 1)
  assert.equal(await fs.readFile(path.join(repliesDir(result.replyId), attachments[0].filename), 'utf8'), 'Vollständiger Beleg')
  assert.equal(await processInboundMail(raw, logger), null)
})

test('Dateisystemfehler beim Anhang erlaubt vollständigen erneuten Import', async () => {
  const raw = inboundMail('disk-error')
  const original = fs.writeFile
  const failing = mock.method(fs, 'writeFile', async () => { throw new Error('Datenträger voll') })
  try { await assert.rejects(processInboundMail(raw, logger)) } finally { failing.mock.restore() }
  assert.equal(fs.writeFile, original)
  assert.ok(await processInboundMail(raw, logger))
})

test('Parallel importierte identische Mails haben genau eine Nachricht und einen Anhang', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => processInboundMail(inboundMail('parallel'), logger)))
  assert.equal(results.filter(Boolean).length, 1)
  const rows = await query(`SELECT COUNT(*) n FROM report_reply_attachments a JOIN report_replies r ON r.id=a.reply_id
    WHERE r.message_id='<parallel@example.invalid>'`)
  assert.equal(rows[0].n, 1)
})

test('Echter SMTP-Versand in Mailpit verwendet die persistierte Message-ID', async () => {
  const id = await report()
  const row = (await query('SELECT * FROM reports WHERE id=?', [id]))[0]
  const user = (await query('SELECT * FROM users WHERE id=?', [userId]))[0]
  assert.equal(await dispatchReport(id, messageId => MailService.prepareReport(row, user, messageId)), 'sent')
  const stored = (await query('SELECT sent_message_id FROM reports WHERE id=?', [id]))[0].sent_message_id
  const response = await fetch('http://mail:8025/api/v1/messages')
  const mailbox = await response.json() as { messages: { ID: string }[] }
  assert.ok(mailbox.messages.length > 0)
  const detail = await fetch(`http://mail:8025/api/v1/message/${mailbox.messages[0].ID}`)
  const mail = await detail.json() as { MessageID: string; To: { Address: string }[] }
  assert.equal(mail.MessageID.replace(/^<|>$/g, ''), stored.replace(/^<|>$/g, ''))
  assert.ok(mail.To.some(to => to.Address.includes('@')))
})

test('Foto-Gruppierung erhält Zeiträume über Mitternacht', () => {
  const result = groupPhotos([
    { id: 1, capturedAt: '2026-10-05 23:55:00', lat: 50.1, lon: 8.6 },
    { id: 2, capturedAt: '2026-10-06 00:05:00', lat: 50.1, lon: 8.6 },
  ])
  assert.equal(result.incidents.length, 1)
  assert.equal(result.incidents[0].dayTo, '2026-10-06')
})

test('Städte-Gate erkennt Hanau und blockiert nicht freigeschaltete Orte', () => {
  assert.deepEqual(resolveSendCity('Marktplatz, 63450 Hanau', 'frankfurt'), { ok: true, cityId: 'hanau' })
  assert.equal(resolveSendCity('10115 Berlin', 'frankfurt').ok, false)
})


test('Produktions-Mailkonfiguration kann nicht still auf Mailpit zurückfallen', () => {
  assert.throws(() => assertProductionMailConfig({ NODE_ENV: 'production', MAIL_DRIVER: 'smpt' }))
  assert.throws(() => assertProductionMailConfig({ NODE_ENV: 'production', MAIL_DRIVER: 'smtp' }))
  assert.doesNotThrow(() => assertProductionMailConfig({ NODE_ENV: 'development', MAIL_DRIVER: 'mailpit' }))
  assert.doesNotThrow(() => assertProductionMailConfig({ NODE_ENV: 'production', MAIL_DRIVER: 'smtp', MAIL_HOST: 'smtp.example.invalid', MAIL_FROM: 'owia@example.invalid' }))
})

test('Verlorene Speicherung der SMTP-Annahme löst keinen erneuten Versand aus', async () => {
  const id = await report()
  let sent = 0
  await pool.query(`CREATE TRIGGER fail_acceptance BEFORE UPDATE ON reports FOR EACH ROW
    BEGIN IF NEW.versand_status='angenommen' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Testfehler Annahme'; END IF; END`)
  try {
    await assert.rejects(dispatchReport(id, async messageId => prepared(messageId, async () => { sent++ })))
  } finally {
    await pool.query('DROP TRIGGER fail_acceptance')
  }
  assert.equal(await dispatchReport(id, async () => { throw new Error('Kein erneuter Versand') }), 'uncertain')
  assert.equal(sent, 1)
})

test('Fremde Anzeigen und ihre Fotos bleiben vor dem Nutzer verborgen', async () => {
  const id = await report()
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  const app = Fastify()
  app.addHook('preHandler', async request => {
    request.session = { userId: userId + 999, userEmail: 'other@example.invalid' } as typeof request.session
  })
  await app.register(reportsRoutes)
  try {
    for (const url of [`/anzeige/${az}`, `/anzeige/${az}/image/1`, `/anzeige/${az}/pdf`]) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404)
    }
  } finally { await app.close() }
})


test('Kontoschließung kann einen ungeklärten Versand nicht löschen', async () => {
  const [created] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(email) VALUES ('closing@example.invalid')")
  const owner = created.insertId
  const id = await report(owner)
  await pool.execute("UPDATE reports SET versand_status='versand', versand_ergebnis=? WHERE id=?", ['{"messageId":"pending@example.invalid"}', id])
  const app = Fastify()
  await app.register(cookie)
  await app.register(formbody)
  let destroyed = false
  app.addHook('preHandler', async request => {
    request.session = { userId: owner, userEmail: 'closing@example.invalid', destroy: async () => { destroyed = true } } as unknown as typeof request.session
  })
  await app.register(settingsRoutes)
  try {
    const response = await app.inject({ method: 'POST', url: '/einstellungen/loeschen', payload: { bestaetigung: 'LÖSCHEN' } })
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers.location, '/einstellungen')
    assert.equal(destroyed, false)
    assert.equal((await query('SELECT anonymized_at FROM users WHERE id=?', [owner]))[0].anonymized_at, null)
    assert.equal((await query('SELECT versand_status FROM reports WHERE id=?', [id]))[0].versand_status, 'versand')
    // Sobald sicher kein Versuch aktiv ist, funktioniert die bisherige
    // Kontoschließung weiterhin und widerruft die Sitzung.
    await pool.execute('UPDATE reports SET versand_status=NULL, versand_ergebnis=NULL WHERE id=?', [id])
    const closed = await app.inject({ method: 'POST', url: '/einstellungen/loeschen', payload: { bestaetigung: 'LÖSCHEN' } })
    assert.equal(closed.statusCode, 302)
    assert.equal(closed.headers.location, '/')
    assert.equal(destroyed, true)
    assert.ok((await query('SELECT anonymized_at FROM users WHERE id=?', [owner]))[0].anonymized_at)
  } finally { await app.close() }
})

test('Adminansicht bietet bei unklarem Versand keinen Wiederholungsbutton an', async () => {
  for (const state of [null, 'vorbereitung', 'versand', 'angenommen']) {
    const html = await ejs.renderFile('src/views/admin/anzeigen.ejs', {
      pending: [{ id: 1, aktenzeichen: 'OWiA-123456', versand_status: state }], recent: [], unmatched: [], verjaehrung,
    })
    if (state === 'versand' || state === 'vorbereitung') {
      assert.ok(!html.includes('action="/admin/anzeigen/1/approve"'))
      assert.ok(!html.includes('action="/admin/anzeigen/1/reject"'))
    } else {
      assert.ok(html.includes('action="/admin/anzeigen/1/approve"'))
      if (state === 'angenommen') assert.ok(html.includes('Abschluss speichern (ohne erneuten Versand)'))
    }
  }
})

test('Sammelbearbeitung schützt vorhandene Angaben, fremde Nutzer, Status und veraltete Vorschauen', async () => {
  const { previewBulkEdit, applyBulkEdit } = await import('../src/services/bulkEdit')
  const { VERSTOSS_ARTEN } = await import('../src/config/verstoss')
  const emptyId = await report(), filledId = await report(), sentId = await report(), lockedId = await report()
  await pool.execute("UPDATE reports SET status='entwurf', verstoss_art=NULL WHERE id IN (?, ?, ?)", [emptyId, filledId, lockedId])
  await pool.execute('UPDATE reports SET verstoss_art=? WHERE id=?', [VERSTOSS_ARTEN[1], filledId])
  await pool.execute("UPDATE reports SET versand_status='ungewiss' WHERE id=?", [lockedId])
  const rows = await query('SELECT id, aktenzeichen FROM reports WHERE id IN (?, ?, ?, ?)', [emptyId, filledId, sentId, lockedId])
  const az = (id: number) => rows.find(r => r.id === id)!.aktenzeichen as string
  const body = { az: rows.map(r => r.aktenzeichen), offenseMode: 'set', offense: VERSTOSS_ARTEN[0], leftMode: 'keep', overwrite: false }
  const preview = await previewBulkEdit(userId, body)
  assert.equal(preview.count, 1)
  await assert.rejects(() => applyBulkEdit(userId + 999, preview.token))
  await assert.rejects(() => applyBulkEdit(userId, preview.token + 'x'))
  assert.equal((await previewBulkEdit(userId + 999, body)).count, 0)
  const results = await applyBulkEdit(userId, preview.token)
  assert.equal(results[0].ok, true)
  assert.equal((await query('SELECT verstoss_art FROM reports WHERE id=?', [filledId]))[0].verstoss_art, VERSTOSS_ARTEN[1])
  assert.equal((await query('SELECT verstoss_art FROM reports WHERE id=?', [lockedId]))[0].verstoss_art, null)
  assert.equal((await applyBulkEdit(userId, preview.token))[0].ok, false)
  const overwrite = await previewBulkEdit(userId, { ...body, az: [az(filledId)], overwrite: true })
  await pool.execute('UPDATE reports SET fahrzeug_verlassen=1 WHERE id=?', [filledId])
  assert.equal((await applyBulkEdit(userId, overwrite.token))[0].ok, false)
  const statusChange = await previewBulkEdit(userId, { ...body, az: [az(emptyId)], offense: VERSTOSS_ARTEN[1], overwrite: true })
  await pool.execute("UPDATE reports SET status='eingereicht' WHERE id=?", [emptyId])
  assert.equal((await applyBulkEdit(userId, statusChange.token))[0].ok, false)
  const clear = await previewBulkEdit(userId, { ...body, az: [az(filledId)], offenseMode: 'clear', leftMode: 'no', overwrite: true })
  assert.equal((await applyBulkEdit(userId, clear.token))[0].ok, true)
  const cleared = (await query('SELECT verstoss_art, fahrzeug_verlassen FROM reports WHERE id=?', [filledId]))[0]
  assert.equal(cleared.verstoss_art, null)
  assert.equal(cleared.fahrzeug_verlassen, 0)
  await assert.rejects(() => previewBulkEdit(userId, { ...body, offense: 'Unbekannter Verstoß' }))
  await assert.rejects(() => previewBulkEdit(userId, { ...body, az: Array(51).fill(az(filledId)) }))
})

test('Sammelbearbeitungs-API prüft Anmeldung, Katalog und Vorschau; Foto-Verschieben respektiert Versandsperren', async () => {
  const { VERSTOSS_ARTEN } = await import('../src/config/verstoss')
  const id = await report()
  await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  const app = Fastify()
  let authenticated = true
  app.addHook('preHandler', async request => {
    request.session = { userId: authenticated ? userId : undefined } as typeof request.session
  })
  await app.register(reportsRoutes)
  try {
    const payload = { az: [az], offenseMode: 'set', offense: VERSTOSS_ARTEN[0], leftMode: 'keep' }
    const invalid = await app.inject({ method: 'POST', url: '/anzeigen/sammelbearbeitung/vorschau', payload: { ...payload, offense: 'Ungültig' } })
    assert.equal(invalid.statusCode, 400)
    const preview = await app.inject({ method: 'POST', url: '/anzeigen/sammelbearbeitung/vorschau', payload })
    assert.equal(preview.statusCode, 200)
    assert.equal(preview.json().count, 1)
    const saved = await app.inject({ method: 'POST', url: '/anzeigen/sammelbearbeitung/speichern', payload: { token: preview.json().token } })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().results[0].ok, true)
    await pool.execute("UPDATE reports SET versand_status='ungewiss' WHERE id=?", [id])
    const move = await app.inject({ method: 'POST', url: `/anzeige/${az}/images/123/move`, payload: { newDraft: true } })
    assert.equal(move.statusCode, 409)
    authenticated = false
    const unauthorized = await app.inject({ method: 'POST', url: '/anzeigen/sammelbearbeitung/vorschau', payload })
    assert.equal(unauthorized.statusCode, 302)
    assert.equal(unauthorized.headers.location, '/login')
  } finally { await app.close() }
})

test('Import-Bildworker erhält Originalbytes, erstellt Vorschaubilder und blockiert den HTTP-Eventloop nicht', async () => {
  const { processIntakeImage, processIntakeThumbnail } = await import('../src/services/intakeImageProcessing')
  const jpeg = (await import('jpeg-js')).default
  const pixels = Buffer.alloc(1600 * 1200 * 4, 180)
  const original = jpeg.encode({ data: pixels, width: 1600, height: 1200 }, 85).data
  const dir = path.join(process.cwd(), 'data', 'worker-test')
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 5)
  try {
    const result = await processIntakeImage(original, 'synthetic.jpg', 'image/jpeg', dir)
    await processIntakeThumbnail(result.filename, result.mimetype, dir)
    assert.ok(ticks > 0, 'Server-Timer muss während der Bildverarbeitung weiterlaufen')
    assert.deepEqual(await fs.readFile(path.join(dir, result.originalFilename)), original)
    assert.equal(result.meta.capturedAt, null)
    assert.equal(result.meta.lat, null)
    const thumb = jpeg.decode(await fs.readFile(path.join(dir, result.filename + '.thumb.jpg')))
    assert.ok(thumb.width < 1600 && thumb.height < 1200)
    // Ein ungültiges Foto darf die nächste Worker-Aufgabe nicht blockieren.
    await assert.rejects(() => processIntakeImage(Buffer.from('invalid'), 'bad.txt', 'text/plain', dir))
    const second = await processIntakeImage(original, 'second.jpg', 'image/jpeg', dir)
    assert.equal(second.mimetype, 'image/jpeg')
  } finally { clearInterval(timer); await fs.rm(dir, { recursive: true, force: true }) }
})

test('Überlappende Importpakete speichern ein identisches Foto genau einmal', async () => {
  const intakeRoutes = (await import('../src/routes/intake')).default
  const jpeg = (await import('jpeg-js')).default
  const image = jpeg.encode({ data: Buffer.alloc(16 * 16 * 4, 127), width: 16, height: 16 }, 80).data
  const app = Fastify()
  const multipart = (await import('@fastify/multipart')).default
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 10 } })
  app.addHook('preHandler', async request => { request.session = { userId } as typeof request.session })
  await app.register(intakeRoutes)
  try {
    const created = await app.inject({ method: 'POST', url: '/import/batch' })
    const batchId = created.json().batchId
    const boundary = 'owia-test-boundary'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bilder"; filename="synthetic.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      image, Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const responses = await Promise.all(Array.from({ length: 2 }, () => app.inject({
      method: 'POST', url: `/import/${batchId}/photos`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
    })))
    assert.ok(responses.every(response => response.statusCode === 200))
    assert.equal(responses.reduce((count, response) => count + response.json().photos.length, 0), 1)
    assert.equal(responses.reduce((count, response) => count + response.json().skipped.length, 0), 1)
    assert.equal((await query('SELECT COUNT(*) n FROM intake_photos WHERE batch_id=?', [batchId]))[0].n, 1)
    const stored = (await query('SELECT filename FROM intake_photos WHERE batch_id=?', [batchId]))[0]
    const thumbPath = path.join(process.cwd(), 'data', 'uploads', String(userId), 'intake', String(batchId), stored.filename + '.thumb.jpg')
    await assert.rejects(() => fs.access(thumbPath), 'Upload darf nicht auf die Vorschauberechnung warten')
    const finished = await app.inject({ method: 'POST', url: `/import/${batchId}/finish` })
    assert.equal(finished.statusCode, 200)
    const lateUpload = await app.inject({ method: 'POST', url: `/import/${batchId}/photos`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
    assert.equal(lateUpload.statusCode, 409)
  } finally { await app.close() }
})

test('Kamera-Modus: Entwurf, Fotos mit Handy-Metadaten, Tatzeit, Sticker und Verwerfen', async () => {
  const kameraRoutes = (await import('../src/routes/kamera')).default
  const jpeg = (await import('jpeg-js')).default
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(email) VALUES ('kamera@example.invalid')")
  const owner = u.insertId
  const app = Fastify()
  const multipart = (await import('@fastify/multipart')).default
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 10 } })
  app.addHook('preHandler', async request => { request.session = { userId: owner } as typeof request.session })
  await app.register(kameraRoutes)
  const boundary = 'owia-kamera-boundary'
  const foto = (grau: number, felder: Record<string, string>) => Buffer.concat([
    ...Object.entries(felder).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bild"; filename="kamera.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg.encode({ data: Buffer.alloc(16 * 16 * 4, grau), width: 16, height: 16 }, 80).data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const upload = (az: string, payload: Buffer) => app.inject({
    method: 'POST', url: `/kamera/${az}/foto`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
  })
  try {
    const az = (await app.inject({ method: 'POST', url: '/kamera/entwurf' })).json().az
    assert.match(az, /^OWiA-\d{6}$/)
    const r1 = await upload(az, foto(90, { aufgenommen: '2026-10-07 23:58:10', lat: '50.1109', lon: '8.6821', genauigkeit: '12' }))
    assert.equal(r1.statusCode, 200)
    // Ungenauer Standort (Funkzelle) wird verworfen, die Zeit bleibt.
    const r2 = await upload(az, foto(140, { aufgenommen: '2026-10-08 00:01:30', lat: '50.2', lon: '8.7', genauigkeit: '900' }))
    assert.equal(r2.statusCode, 200)
    const doppelt = await upload(az, foto(90, {}))
    assert.equal(doppelt.statusCode, 409)
    assert.equal(doppelt.json().doppelt, true)
    const bilder = await query('SELECT DATE_FORMAT(captured_at, "%Y-%m-%d %H:%i:%s") t, gps_lat, gps_lon FROM report_images ri JOIN reports r ON r.id = ri.report_id WHERE r.aktenzeichen = ? ORDER BY ri.sort_order', [az])
    assert.deepEqual(bilder.map(b => b.t), ['2026-10-07 23:58:10', '2026-10-08 00:01:30'])
    assert.equal(Number(bilder[0].gps_lat), 50.1109)
    assert.equal(bilder[1].gps_lat, null)

    assert.equal((await app.inject({ method: 'POST', url: `/kamera/${az}/fertig` })).json().fotos, 2)
    const zeit = (await query(`SELECT DATE_FORMAT(tattag, '%Y-%m-%d') tag, DATE_FORMAT(tattag_bis, '%Y-%m-%d') bis,
      TIME_FORMAT(tatzeit_von, '%H:%i') von, TIME_FORMAT(tatzeit_bis, '%H:%i') zeit_bis FROM reports WHERE aktenzeichen = ?`, [az]))[0]
    assert.deepEqual({ ...zeit }, { tag: '2026-10-07', bis: '2026-10-08', von: '23:58', zeit_bis: '00:01' })

    const batch = await createBatch(owner, parseLayout({ vorlage: '70x37' }) as StickerLayout, 1)
    assert.ok('batchId' in batch)
    const [code] = await batchCodes(batch.batchId)
    assert.equal((await app.inject({ method: 'POST', url: `/kamera/${az}/sticker`, payload: { code: 'abc' } })).statusCode, 400)
    const linked = await app.inject({ method: 'POST', url: `/kamera/${az}/sticker`, payload: { code: code.toLowerCase() } })
    assert.equal(linked.statusCode, 200)
    assert.equal(linked.json().code, `${code.slice(0, 4)}-${code.slice(4)}`)
    assert.equal((await app.inject({ method: 'POST', url: `/kamera/${az}/sticker`, payload: { code } })).statusCode, 409)

    await app.inject({ method: 'POST', url: `/kamera/${az}/verwerfen` })
    assert.equal((await query('SELECT status FROM reports WHERE aktenzeichen = ?', [az]))[0].status, 'papierkorb')
    assert.equal((await upload(az, foto(200, {}))).statusCode, 404)
  } finally { await app.close() }
})

test('Inline-Bearbeitung ändert nur übergebene Felder, nur Katalog-Verstöße und nur Entwürfe', async () => {
  const id = await report()
  await pool.execute("UPDATE reports SET status='entwurf', tatort='Teststraße 1', fahrzeug_marke='VW', kennzeichen_land='NL' WHERE id=?", [id])
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  const app = Fastify()
  app.addHook('preHandler', async request => { request.session = { userId } as typeof request.session })
  await app.register(reportsRoutes)
  try {
    // Weltweite Schreibweisen (Roller-Versicherungskennzeichen) bleiben erhalten.
    const plate = await app.inject({ method: 'PATCH', url: `/anzeige/${az}/felder`, payload: { kennzeichen: ' 123  abc ' } })
    assert.equal(plate.statusCode, 200)
    const row = (await query('SELECT kennzeichen, tatort, fahrzeug_marke, kennzeichen_land FROM reports WHERE id=?', [id]))[0]
    assert.deepEqual([row.kennzeichen, row.tatort, row.fahrzeug_marke, row.kennzeichen_land], ['123 ABC', 'Teststraße 1', 'VW', 'NL'])
    const bad = await app.inject({ method: 'PATCH', url: `/anzeige/${az}/felder`, payload: { verstoss_art: 'Erfunden' } })
    assert.equal(bad.statusCode, 400)
    // Frankfurt: Tatbestände ohne Eintrag im Online-Portal sind nicht waehlbar.
    const ohnePortal = '112456 – Sie hielten/parkten nicht Platz sparend.'
    await pool.execute("UPDATE reports SET city='frankfurt' WHERE id=?", [id])
    const gesperrt = await app.inject({ method: 'PATCH', url: `/anzeige/${az}/felder`, payload: { verstoss_art: ohnePortal } })
    assert.equal(gesperrt.statusCode, 400)
    assert.match(gesperrt.json().error, /Online-Portal/)
    const anderswo = await app.inject({ method: 'PATCH', url: `/anzeige/${az}/felder`, payload: { verstoss_art: ohnePortal, city: 'wiesbaden' } })
    assert.equal(anderswo.statusCode, 200)
    // Autosave des Editors ohne Länderfeld lässt das gespeicherte Land stehen.
    await app.inject({ method: 'PATCH', url: `/anzeige/${az}`, payload: { kennzeichen: 'NL-12-AB', tatort: 'Teststraße 1' } })
    assert.equal((await query('SELECT kennzeichen_land FROM reports WHERE id=?', [id]))[0].kennzeichen_land, 'NL')
    await pool.execute("UPDATE reports SET status='eingereicht' WHERE id=?", [id])
    const locked = await app.inject({ method: 'PATCH', url: `/anzeige/${az}/felder`, payload: { kennzeichen: 'X' } })
    assert.equal(locked.statusCode, 409)
  } finally { await app.close() }
})

test('Einzelne Listenzeile lässt sich nachladen (Helfer wie verjaehrung stehen bereit)', async () => {
  const id = await report()
  await pool.execute("UPDATE reports SET status='entwurf', tattag=CURDATE() WHERE id=?", [id])
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  const app = Fastify()
  app.addHook('preHandler', async request => { request.session = { userId } as typeof request.session })
  await app.register(reportsRoutes)
  try {
    const row = await app.inject({ method: 'GET', url: `/anzeige/${az}/listenzeile` })
    assert.equal(row.statusCode, 200)
    assert.ok(row.body.includes(`data-az="${az}"`))
    // Fahrzeugfelder (Migration 0039) sind in der Zeile editierbar – der Typ
    // braucht die Auswahlliste im Render-Kontext (fahrzeugTypen).
    for (const f of ['fahrzeug_typ', 'fahrzeug_modell', 'fahrzeug_farbe']) assert.ok(row.body.includes(`data-inline-field="${f}"`), f)
    assert.ok(row.body.includes('<option value="LKW"'))
  } finally { await app.close() }
})

test('Sticker: Kontingent, Verknüpfen, Lösen und Code-Normalisierung', async () => {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(email) VALUES ('sticker@example.invalid')")
  const owner = u.insertId
  const layout = parseLayout({ vorlage: '70x37' }) as StickerLayout
  assert.equal(typeof layout, 'object')
  assert.match(String(parseLayout({ vorlage: 'eigen', cols: 3, rows: 8, labelW: 90, labelH: 37 })), /größer als A4/)

  const first = await createBatch(owner, layout, 2)
  assert.ok('batchId' in first)
  const codes = await batchCodes(first.batchId)
  assert.equal(codes.length, 48)
  assert.equal(new Set(codes).size, 48)
  assert.ok(codes.every(c => normalizeCode(c) === c))
  // Höchstens 20 Bögen mit offenen Codes gleichzeitig (über alle Batches):
  // 2 offen → 18 gehen noch, 19 nicht. Fall-Sticker je Verstoß parallel.
  assert.ok('error' in await createBatch(owner, layout, 19))
  assert.ok('error' in await createBatch(owner, layout, 21))
  const gehweg = parseLayout({ vorlage: '70x37', tbnr: '112454', aufdruck: 'Auf dem Gehweg 🚗 geparkt.' }) as StickerLayout
  assert.equal(gehweg.tbnr, '112454')
  assert.equal(gehweg.aufdruck, 'Auf dem Gehweg geparkt.') // Emoji kann die PDF-Schrift nicht
  assert.equal((parseLayout({ vorlage: '105x57', tbnr: '112454' }) as StickerLayout).aufdruck, 'Sie parkten verbotswidrig auf dem Gehweg.')
  assert.match(String(parseLayout({ vorlage: '105x57', tbnr: '999999' })), /Katalog/)
  assert.match(String(parseLayout({ vorlage: 'eigen', tbnr: '112454', cols: 4, rows: 12, labelW: 48.5, labelH: 25.4, marginLeft: 8, marginTop: 10 })), /60 × 33/)
  const fallBatch = await createBatch(owner, gehweg, 18)
  assert.ok('batchId' in fallBatch)
  assert.ok('error' in await createBatch(owner, layout, 1))
  const fallPdf = await PDFDocument.load(await renderBatchPdf((await batchCodes(fallBatch.batchId)).slice(0, 24), gehweg, 'https://owia.example'))
  assert.equal(fallPdf.getPageCount(), 1)
  assert.equal(await voidOpenCodes(owner, fallBatch.batchId), 18 * 24)

  const id = await report(owner)
  assert.equal(await linkCode(owner, codes[0], id), 'ok')
  assert.equal(await linkCode(owner, codes[0], id), 'vergeben')
  assert.equal(await linkCode(userId, codes[1], await report()), 'fremd')
  assert.equal(await linkCode(owner, 'ZZZZZZZZ', id), 'unbekannt')
  await pool.execute("UPDATE reports SET status='papierkorb' WHERE id=?", [id])
  assert.equal(await linkCode(owner, codes[1], id), 'anzeige')
  await pool.execute("UPDATE reports SET status='eingereicht' WHERE id=?", [id])

  // Lösen nur kurz nach dem Verknüpfen.
  assert.equal(await unlinkCode(owner, codes[0]), true)
  assert.equal(await linkCode(owner, codes[0], id), 'ok')
  await pool.execute('UPDATE sticker_codes SET linked_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE code=?', [codes[0]])
  assert.equal(await unlinkCode(owner, codes[0]), false)

  assert.equal(await voidOpenCodes(owner, first.batchId), 47)
  assert.equal(await linkCode(owner, codes[2], id), 'entwertet')
  assert.ok('batchId' in await createBatch(owner, layout, 1))

  assert.equal(normalizeCode('https://owia.example/S/7kq2-xm9p'), '7KQ2XM9P')
  assert.equal(normalizeCode('7KQ2-XM9P'), '7KQ2XM9P')
  assert.equal(normalizeCode('oil2 3456'), '0112' + '3456')
  assert.equal(normalizeCode('MUSTER00'), null) // U gibt es im Alphabet nicht
  assert.equal(normalizeCode('kurz'), null)

  const pdf = await PDFDocument.load(await renderBatchPdf(codes, layout, 'https://owia.example'))
  assert.equal(pdf.getPageCount(), 2)
})

test('Sticker-Seite zeigt Fremden nur öffentliche Angaben und zählt nur deren Aufrufe', async () => {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(email) VALUES ('sticker-seite@example.invalid')")
  const owner = u.insertId
  const created = await createBatch(owner, parseLayout({ vorlage: '105x57' }) as StickerLayout, 1)
  assert.ok('batchId' in created)
  const [code, offen] = await batchCodes(created.batchId)
  const id = await report(owner)
  await pool.execute(
    "UPDATE reports SET verstoss_art='112454 – Sie parkten auf dem Gehweg.', tattag='2026-10-01', tatzeit_von='14:35', eingereicht_at=NOW() WHERE id=?",
    [id]
  )
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  assert.equal(await linkCode(owner, code, id), 'ok')

  let viewer: number | undefined
  const app = Fastify()
  await app.register(cookie)
  await app.register(formbody)
  await app.register(view, {
    engine: { ejs },
    root: path.join(process.cwd(), 'src', 'views'),
    layout: '/layout.ejs',
    defaultContext: { isAdmin: false, verjaehrung },
  })
  app.addHook('preHandler', async request => { request.session = { userId: viewer } as typeof request.session })
  await app.register(stickerRoutes)
  try {
    const page = await app.inject({ method: 'GET', url: `/S/${code}` })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Sie parkten auf dem Gehweg/)
    assert.match(page.body, /01\.10\.2026/)
    for (const geheim of ['M KK 123', az, 'Kurpark', '14:35', 'sticker-seite@example.invalid']) {
      assert.ok(!page.body.includes(geheim), `Sticker-Seite verrät ${geheim}`)
    }
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow')
    assert.equal((await query('SELECT scan_count FROM sticker_codes WHERE code=?', [code]))[0].scan_count, 1)

    // Entwürfe: nur „wird vorbereitet", keine Details.
    await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
    const draft = await app.inject({ method: 'GET', url: `/S/${code}` })
    assert.match(draft.body, /wird gerade vorbereitet/)
    assert.ok(!draft.body.includes('Gehweg'))
    assert.ok(!draft.body.includes('01.10.2026'))
    // Papierkorb: gar keine Angaben.
    await pool.execute("UPDATE reports SET status='papierkorb' WHERE id=?", [id])
    const trash = await app.inject({ method: 'GET', url: `/S/${code}` })
    assert.match(trash.body, /keine öffentlichen Angaben/)
    await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])

    // Besitzer: Banner, Verknüpfungsformular für offene Codes, kein Zähler.
    viewer = owner
    const own = await app.inject({ method: 'GET', url: `/S/${code}` })
    assert.ok(own.body.includes(az))
    assert.equal((await query('SELECT scan_count FROM sticker_codes WHERE code=?', [code]))[0].scan_count, 3)
    const form = await app.inject({ method: 'GET', url: `/S/${offen}` })
    assert.match(form.body, /Sticker verknüpfen/)
    const linked = await app.inject({ method: 'POST', url: `/S/${offen}/verknuepfen`, payload: { report: String(id) } })
    assert.equal(linked.statusCode, 302)
    assert.equal((await query('SELECT report_id FROM sticker_codes WHERE code=?', [offen]))[0].report_id, id)

    // Fremde können offene Codes nicht verknüpfen; Kleinschreibung leitet um.
    viewer = userId
    const third = (await batchCodes(created.batchId))[2]
    await app.inject({ method: 'POST', url: `/S/${third}/verknuepfen`, payload: { report: String(await report()) } })
    assert.equal((await query('SELECT report_id FROM sticker_codes WHERE code=?', [third]))[0].report_id, null)
    const lower = await app.inject({ method: 'GET', url: `/s/${code.toLowerCase()}` })
    assert.equal(lower.statusCode, 301)
  } finally { await app.close() }
})

test('Statistik summiert Regelsätze je TBNR, Freitext zählt ohne Betrag', () => {
  // Stichproben aus dem KBA-Katalog (resources/bussgelder.csv).
  assert.equal(regelsatzEuro('112454'), 55)
  assert.equal(regelsatzEuro('141312'), 25)
  assert.equal(regelsatzEuro('000000'), null)
  const s = aggregiere([
    { verstoss_art: '112454 – Sie parkten verbotswidrig auf dem Gehweg.', monat: '2026-09', city: 'frankfurt' },
    { verstoss_art: '112454 – Sie parkten verbotswidrig auf dem Gehweg.', monat: '2026-10', city: 'frankfurt' },
    { verstoss_art: '141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).', monat: '2026-10', city: 'frankfurt' },
    { verstoss_art: 'Sonstige Vergehen', monat: '2026-10', city: 'frankfurt' },
  ])
  assert.equal(s.anzahl, 4)
  assert.equal(s.mitRegelsatz, 3)
  assert.equal(s.euro, 135)
  assert.deepEqual(s.tatbestaende.map((t) => [t.key, t.anzahl, t.euro]), [['112454', 2, 110], ['141312', 1, 25], ['sonstige', 1, 0]])
  assert.deepEqual(s.monate.map((m) => [m.label, m.anzahl, m.euro]), [['September 2026', 1, 55], ['Oktober 2026', 3, 80]])
})

test('Hintergrund-Jobs: gleicher Schlüssel wird nur einmal eingereiht', async () => {
  const { enqueueJob } = await import('../src/services/jobs')
  await enqueueJob('test.noop', { a: 1 }, { key: 'test.noop:1' })
  await enqueueJob('test.noop', { a: 1 }, { key: 'test.noop:1' })
  const rows = await query("SELECT COUNT(*) AS n FROM jobs WHERE pending_key = 'test.noop:1'")
  assert.equal(Number(rows[0].n), 1)
  await pool.execute("DELETE FROM jobs WHERE type = 'test.noop'")
})

test('Frankfurt-Portal: Tatbestand-Pfade, Varianten und Langparker', () => {
  const pick = (l: string, v?: string) => portalTatbestand(l, v)
  assert.deepEqual(pick('141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).'), {
    gruppe: 'Haltverbot/gesperrter Bereich/Sonderparkplätze',
    pfad: [{ pick: ['im Haltverbot'] }, { pick: ['im absoluten Haltverbot (Zeichen 283)'] }, { pick: ['Parken'] }],
    rettung: false,
    parken: true,
  })
  // Fahrzeug verlassen = Parken, auch bei „Sie hielten …"; der Schutzstreifen
  // kennt im Portal nur Halten.
  const lbl = (tbnr: string) => { const x = VERSTOESSE.find((y) => y.tbnr === tbnr)!; return `${x.tbnr} – ${x.text}` }
  assert.deepEqual(portalTatbestand(lbl('141070'), null, false)!.pfad[0], { pick: ['Halten'] })
  assert.equal(portalTatbestand(lbl('141070'), null, false)!.parken, false)
  assert.deepEqual(portalTatbestand(lbl('141070'), null, true)!.pfad[0], { pick: ['Parken'] })
  assert.equal(portalTatbestand(lbl('141070'), null, true)!.parken, true)
  assert.deepEqual(portalTatbestand(lbl('142170'), null, true)!.pfad[0], { pick: ['Halten'] })
  assert.equal(portalTatbestand(lbl('142170'), null, true)!.parken, false)
  // Bordsteinabsenkung u. Ä.: kein Halten/Parken im Pfad → Zusatz bleibt nötig.
  assert.equal(portalTatbestand(lbl('112372'), null, true)!.parken, false)
  // Mehrdeutig ohne Variante → Live-Auswahl; mit Variante eindeutig.
  const kreuzung = '112262 – Sie parkten weniger als 5 Meter vor der Kreuzung/Einmündung.'
  assert.deepEqual(verstossVarianten(kreuzung).map((x) => x.value), ['Kreuzung', 'Einmündung'])
  assert.ok(pick(kreuzung)!.pfad[0].ask)
  assert.deepEqual(pick(kreuzung, 'Einmündung')!.pfad, [{ pick: ['weniger als 5 Meter VOR einer Einmündung'] }])
  // „länger als 1 Stunde" mit Rückfall auf „Parken"
  assert.deepEqual(pick('112656 – Sie parkten länger als 1 Stunde verbotswidrig auf dem Gehweg.')!.pfad[0], { pick: ['Parken länger als 1 Stunde', 'Parken'] })
  assert.equal(pick('112612 – Sie parkten vor oder in einer amtlich gekennzeichneten Feuerwehrzufahrt und behinderten dadurch ein Rettungsfahrzeug im Einsatz.')!.rettung, true)
  // Nicht im Portal
  assert.equal(pick('112456 – Sie hielten/parkten nicht Platz sparend.'), null)
  assert.equal(langparkerVariante('112454 – Sie parkten verbotswidrig auf dem Gehweg.'), '112656 – Sie parkten länger als 1 Stunde verbotswidrig auf dem Gehweg.')
  assert.equal(tatDauerMinuten({ tatzeit_von: '10:15:00', tatzeit_bis: '11:30:00' }), 75)
  assert.equal(portalProblem({ verstoss_art: kreuzung }), 'Bitte beim Verstoß genauer angeben: Kreuzung oder Einmündung.')
  assert.equal(portalProblem({ verstoss_art: kreuzung, verstoss_variante: 'Kreuzung', kennzeichen_land: 'D' }), null)
})

test('Frankfurt-Portal: jeder waehlbare Verstoß führt im Portal-Baum zu einem Eintrag', async () => {
  // tests/fixtures/ekom21-ffm-baum.json: alle Pfade des Online-Formulars (Stand
  // 10/2026, durchgespielt mit /root/owia/work/ekom21-frankfurt/dfs.js).
  const baum = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures/ekom21-ffm-baum.json'), 'utf8')) as Record<string, string[][]>
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()
  const passt = (opt: string, c: string) => norm(opt).startsWith(norm(c))
  // Spielt den Pfad wie choosePathElement (docker/portal/lib.mjs) durch.
  const fehler = (gruppe: string, pfad: { pick?: string[]; ask?: string[]; optional?: boolean }[]) => {
    let blaetter = baum[gruppe] ?? []
    let tiefe = 0
    for (const el of pfad) {
      const opts = [...new Set(blaetter.filter((p) => p.length > tiefe).map((p) => p[tiefe]))]
      const cands = el.pick ?? el.ask ?? []
      const treffer = el.pick
        ? cands.map((c) => opts.find((o) => passt(o, c))).find(Boolean)
        : (() => { const f = opts.filter((o) => cands.some((c) => passt(o, c))); return f.length === 1 ? f[0] : undefined })()
      if (!treffer) {
        if (el.optional) continue
        return `keine Option für ${cands.join(' / ')} (da: ${opts.join(' / ')})`
      }
      blaetter = blaetter.filter((p) => p[tiefe] === treffer)
      tiefe++
    }
    return blaetter.some((p) => p.length === tiefe) ? null : 'Pfad endet vor einem Eintrag'
  }
  const probleme: string[] = []
  let waehlbar = 0
  for (const x of VERSTOESSE) {
    const label = `${x.tbnr} – ${x.text}`
    if (verstossGesperrt('frankfurt', label)) continue
    waehlbar++
    const vs = verstossVarianten(label)
    for (const v of vs.length ? vs.map((y) => y.value) : [null]) {
      for (const verlassen of [false, true]) {
        const tb = portalTatbestand(label, v, verlassen)!
        const f = fehler(tb.gruppe, tb.pfad)
        if (f) probleme.push(`${x.tbnr} [${v ?? '-'}${verlassen ? ', verlassen' : ''}]: ${f}`)
      }
    }
  }
  assert.deepEqual(probleme, [])
  assert.ok(waehlbar >= 180, `nur ${waehlbar} waehlbar`)
  // Halten gibt es im Portal nicht überall: absolutes Haltverbot nur „Parken".
  assert.equal(verstossGesperrt('frankfurt', '141310 – Sie hielten im absoluten Haltverbot (Zeichen 283).'), true)
  assert.equal(verstossGesperrt('frankfurt', '141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).'), false)
  // Andere Städte sperren nichts.
  assert.equal(verstossGesperrt('wiesbaden', '141310 – Sie hielten im absoluten Haltverbot (Zeichen 283).'), false)
  const sp = verstossSperren(VERSTOESSE.map((x) => `${x.tbnr} – ${x.text}`))
  assert.deepEqual(Object.keys(sp.gesperrt), ['frankfurt'])
  assert.equal(sp.gesperrt.frankfurt.idx.length, VERSTOESSE.length - waehlbar)
})

test('Frankfurt-Portal: Fahrzeug, Fotos und Payload', () => {
  const lbl2 = (tbnr: string) => { const x = VERSTOESSE.find((y) => y.tbnr === tbnr)!; return `${x.tbnr} – ${x.text}` }
  assert.equal(portalMarke('VW'), 'Volkswagen')
  assert.equal(portalMarke('Mercedes'), 'Mercedes-Benz')
  assert.equal(portalMarke('vw golf'), 'Volkswagen')
  assert.equal(portalMarke('Lada'), null)
  assert.equal(fahrzeugBeschreibung({ fahrzeug_marke: 'VW', fahrzeug_modell: 'Golf', fahrzeug_farbe: 'schwarz' }), 'VW Golf, schwarz')
  // Die Reihenfolge entscheidet: Foto 1 = Übersicht, der Rest (≤ 5) = Fahrzeug.
  const roles = photoRoles([1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual([roles.uebersicht, roles.fahrzeug], [[1], [2, 3, 4, 5, 6]])
  const one = photoRoles([{ id: 7, detected_plate: null }])
  assert.deepEqual([one.uebersicht.map((i) => i.id), one.fahrzeug.map((i) => i.id)], [[7], [7]])
  const p = buildPortalPayload(
    { verstoss_art: '141174 – Sie parkten auf einem Radweg/Radfahrstreifen (Zeichen 237).', kennzeichen: 'F-AB 1', kennzeichen_land: 'D',
      fahrzeug_marke: 'VW', fahrzeug_farbe: 'rot', tattag: '2026-10-07', tatzeit_von: '22:30:00', tatzeit_bis: '01:00:00', tattag_bis: '2026-10-08',
      tatort: 'Römerberg 1, 60311 Frankfurt am Main', beschreibung: 'Vor dem Café', behinderung: 0 } as any,
    { anrede: 'frau', vorname: 'Erika', nachname: 'Muster', strasse: 'Weg', hausnummer: '2', plz: '60311', ort: 'Frankfurt', email: 'e@x' } as any
  )
  assert.equal(p.person.anrede, 'Frau')
  assert.equal(p.fahrzeug.marke, 'Volkswagen')
  assert.equal(p.fahrzeug.typ, 'PKW')
  assert.deepEqual(p.tat, { ort: 'Römerberg 1 (Tatzeitraum bis 08.10.2026 01:00 Uhr; Vor dem Café)', tattag: '07.10.2026', von: '22:30', bis: '23:59' })
  assert.equal(p.gruppe, 'Radweg/Radfahrstreifen')
  // Ende fehlt: letztes Foto desselben Tages; sonst Beginn = Ende.
  assert.deepEqual(portalTatzeit({ tattag: '2026-09-11', tatzeit_von: '02:13:33' }, '2026-09-11 02:19'), { von: '02:13', bis: '02:19', zusatz: null })
  assert.deepEqual(portalTatzeit({ tattag: '2026-09-11', tatzeit_von: '02:13:33' }, null), { von: '02:13', bis: '02:13', zusatz: null })
  assert.equal(tatortText({ tatort: 'Franz-Simon-Straße 29, 65934 Frankfurt am Main', fahrzeug_verlassen: 1 }), 'Franz-Simon-Straße 29 (Fahrzeug war verlassen)')
  assert.equal(tatortText({ tatort: 'Franz-Simon-Straße 29, 65934 Frankfurt am Main', fahrzeug_verlassen: 1 }, [], true), 'Franz-Simon-Straße 29')
  // Payload: Parken im Pfad → kein Zusatz; Halten-Tatbestand + verlassen → Parken.
  const basis = { kennzeichen: 'F-AB 1', kennzeichen_land: 'D', tattag: '2026-10-07', tatzeit_von: '10:00:00', tatzeit_bis: '10:30:00',
    tatort: 'Römerberg 1, 60311 Frankfurt am Main', behinderung: 0, fahrzeug_verlassen: 1 }
  const nutzer = { anrede: 'herr', vorname: 'M', nachname: 'M', strasse: 'Weg', hausnummer: '1', plz: '60311', ort: 'Frankfurt', email: 'm@x' } as any
  const geparkt = buildPortalPayload({ ...basis, verstoss_art: '141174 – Sie parkten auf einem Radweg/Radfahrstreifen (Zeichen 237).' } as any, nutzer)
  assert.equal(geparkt.tat.ort, 'Römerberg 1')
  const gehalten = buildPortalPayload({ ...basis, verstoss_art: lbl2('141070') } as any, nutzer)
  assert.deepEqual(gehalten.pfad[0], { pick: ['Parken'] })
  assert.equal(gehalten.tat.ort, 'Römerberg 1')
  const schutz = buildPortalPayload({ ...basis, verstoss_art: lbl2('142170') } as any, nutzer)
  assert.equal(schutz.tat.ort, 'Römerberg 1 (Fahrzeug war verlassen)')
  const bordstein = buildPortalPayload({ ...basis, verstoss_art: lbl2('112372') } as any, nutzer)
  assert.equal(bordstein.tat.ort, 'Römerberg 1 (Fahrzeug war verlassen)')
})

test('Wiesbaden- und Mainz-Portal: Zuordnung, Prüfungen, Payload', () => {
  // Wiesbaden: eine Ebene, Halten → Sonstiges
  assert.deepEqual(wiTatbestand('141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).'), { gruppe: 'Haltverbot', satz: ['Das Fahrzeug parkte im absoluten Haltverbot (Zeichen 283)'] })
  assert.equal(wiTatbestand('141310 – Sie hielten im absoluten Haltverbot (Zeichen 283).'), null)
  assert.equal(wiTatbestand('141245 – Sie benutzten die Sperrfläche (Zeichen 298) zum Parken.')!.satz[0], 'Das Fahrzeugt parkte auf einer Sperrfläche')
  const u = { anrede: 'herr', vorname: 'Max', nachname: 'M', strasse: 'Weg', hausnummer: '1', plz: '65183', ort: 'Wiesbaden', email: 'm@x', telefon: '0611 1' } as any
  const wi = buildWiPayload({ verstoss_art: '112456 – Sie hielten/parkten nicht Platz sparend.', kennzeichen_land: 'D', tattag: '2026-10-07', tatzeit_von: '10:00:00', tatort: 'Wilhelmstraße 10, 65183 Wiesbaden', behinderung: 0, fahrzeug_verlassen: 1 } as any, u)
  assert.equal(wi.gruppe, 'Sonstiges')
  assert.deepEqual(wi.pfad, [])
  assert.match(wi.tatvorwurf, /nicht Platz sparend/)
  assert.equal(wi.tat.ort, 'Wilhelmstraße 10')
  assert.match(wi.ergaenzend, /verlassen/)
  assert.equal(wiProblem({ tattag: '2020-01-01' }), 'Wiesbaden nimmt nur Taten der letzten zwei Monate an.')
  // Mainz: Art × Rubrik, Tatort zerlegt, Telefon Pflicht
  assert.deepEqual(tatortTeile('Große Bleiche 12a, 55116 Mainz'), { strasse: 'Große Bleiche', hausnummer: '12a', plz: '55116', ort: 'Mainz' })
  assert.equal(tatortTeile('Rheinufer, 55116 Mainz')!.hausnummer, null)
  const mz = buildMzPayload({ verstoss_art: '112262 – Sie parkten weniger als 5 Meter vor der Kreuzung/Einmündung.', verstoss_variante: 'Einmündung', kennzeichen: 'MZ-A 1', kennzeichen_land: 'D', fahrzeug_marke: 'Skoda', fahrzeug_typ: 'Elektrokleinstfahrzeug', tattag: '2026-10-07', tatzeit_von: '10:00:00', tatort: 'Große Bleiche 12, 55116 Mainz', behinderung: 1, behinderung_text: 'Kinderwagen' } as any, u)
  assert.deepEqual(mz.mz.art, 'Parken')
  assert.equal(mz.mz.rubrik, 'Das Fahrzeug stand im 5-Meter Kreuzungsbereich')
  assert.match(mz.mz.freitext, /genauer: Einmündung.*Behinderung: Kinderwagen/)
  assert.equal(mz.fahrzeug.marke, 'Škoda')
  assert.equal(mz.fahrzeug.typ, 'Elektrokleinstrad')
  assert.equal(mzProblem({ tatort: 'Große Bleiche 12, 55116 Mainz' }, { telefon: '' }), 'Mainz verlangt eine Telefonnummer – bitte im Profil ergänzen.')
  assert.deepEqual(mzFotos({ uebersicht: [1, 2, 3], fahrzeug: [4, 5] }), [4, 1, 5])
  // Registry + Ortsteile
  assert.equal(portalFuer('mainz')!.id, 'civento-mz')
  assert.equal(portalFuer('hanau'), null)
  assert.equal(getCityByName('Mainz-Kastel')!.id, 'wiesbaden')
})

test('Öffentliches Kartenbild: mit Kennzeichen-Analyse geschwärzt in 160 px, sonst grob verpixelt', async () => {
  const { pixelate } = await import('../src/services/pixelate')
  const jpeg = (await import('jpeg-js')).default
  const original = Buffer.from(jpeg.encode({ data: Buffer.alloc(1600 * 1200 * 4, 255), width: 1600, height: 1200 }, 90).data)
  const analyse = { w: 800, h: 600, plates: [{ text: 'F AB 123', confidence: 0.9, bbox: [300, 400, 500, 450] }], faces: [] }
  const geschwaerzt = jpeg.decode(pixelate(original, 'image/jpeg', 1, analyse))
  assert.deepEqual([geschwaerzt.width, geschwaerzt.height], [160, 120])
  assert.ok(geschwaerzt.data[(85 * 160 + 80) * 4] < 30, 'Kennzeichenbox muss schwarz sein')
  assert.ok(geschwaerzt.data[(10 * 160 + 10) * 4] > 225, 'Rest des Bildes bleibt erhalten')
  // Ohne Analyse oder ohne erkanntes Kennzeichen: keine Schwärzung möglich → 32 px.
  for (const a of [null, { ...analyse, plates: [] }]) {
    const grob = jpeg.decode(pixelate(original, 'image/jpeg', 1, a))
    assert.deepEqual([grob.width, grob.height], [32, 24])
  }
})

test('Portal-Städte: kein PDF-Formular (Frankfurt seit 10/2026 nur ekom21-Portal)', async () => {
  const { getCity, hasPdfForm } = await import('../src/config/cities')
  assert.equal(hasPdfForm(getCity('frankfurt')), false, 'Frankfurt läuft übers Portal – kein PDF mehr')
  assert.equal(hasPdfForm(getCity('wiesbaden')), false)
  assert.equal(hasPdfForm(getCity('mainz')), false)
  assert.equal(hasPdfForm({ pdfForm: 'formular.pdf' } as any), true, 'Formular-Stadt ohne Portal bekommt weiter ein PDF')
})

test('Automatisches Schwärzen: Gesichter immer, fremde Kennzeichen nur neben dem erkannten eigenen', async () => {
  const { schwaerzPlan, schwaerzeBoxen } = await import('../src/services/dritteSchwaerzen')
  const jpeg = (await import('jpeg-js')).default
  const fremd = { text: 'F XY 999', confidence: 0.9, bbox: [50, 50, 100, 75] }
  const gesicht = { score: 0.95, bbox: [150, 20, 170, 45] }
  const mit = { w: 200, h: 150, plates: [{ text: 'F AB 123', confidence: 0.9, bbox: [10, 100, 60, 120] }, fremd], faces: [gesicht] }
  const plan = schwaerzPlan(mit, 'F-AB 123')
  assert.deepEqual(plan.boxen.map((b) => b.art), ['kennzeichen', 'gesicht'])
  assert.equal(plan.offen.length, 0)
  // Eigenes Kennzeichen nicht erkannt: die „fremde" Lesung könnte das angezeigte
  // Fahrzeug sein – Kennzeichen bleibt offen, Gesicht wird trotzdem geschwärzt.
  const ohne = schwaerzPlan({ ...mit, plates: [fremd] }, 'F-AB 123')
  assert.deepEqual(ohne.boxen.map((b) => b.art), ['gesicht'])
  assert.deepEqual(ohne.offen.map((b) => b.art), ['kennzeichen'])
  // Boxen landen (mit Rand, aufs Vollbild skaliert) schwarz im Bild, der Rest bleibt.
  const original = Buffer.from(jpeg.encode({ data: Buffer.alloc(400 * 300 * 4, 255), width: 400, height: 300 }, 90).data)
  const out = jpeg.decode(schwaerzeBoxen(original, 'image/jpeg', 1, mit as any, plan.boxen))
  assert.deepEqual([out.width, out.height], [400, 300])
  assert.ok(out.data[(125 * 400 + 150) * 4] < 30, 'fremdes Kennzeichen schwarz')
  assert.ok(out.data[(65 * 400 + 320) * 4] < 30, 'Gesicht schwarz')
  assert.ok(out.data[(220 * 400 + 70) * 4] > 225, 'eigenes Kennzeichen bleibt lesbar')
  assert.ok(out.data[(10 * 400 + 10) * 4] > 225, 'Rest unverändert')
  assert.throws(() => schwaerzeBoxen(original, 'image/jpeg', 1, { ...mit, w: 150, h: 200 } as any, plan.boxen), /Bildausrichtung/)
})

// ---------------------------------------------------------------------------
// Härtung 08.10.2026: Bildtyp aus Bytes, Dekodier-Deckel, Posteingang-
// Authentizität, Magic-Link ohne Vorab-Verbrauch, Autosave-Validierung,
// öffentliche API ohne punktgenaue Koordinaten, Einreichen-Kernfunktion.
// ---------------------------------------------------------------------------

test('Bildtyp kommt aus den Bytes, nicht aus dem Client-Mimetype; Riesenbilder werden nicht dekodiert', async () => {
  const { sniffImageType, prepareImage } = await import('../src/services/images')
  const { headerDimensions, decode } = await import('../src/services/pixelate')
  const jpeg = (await import('jpeg-js')).default
  const foto = Buffer.from(jpeg.encode({ data: Buffer.alloc(40 * 30 * 4, 200), width: 40, height: 30 }, 80).data)
  assert.equal(sniffImageType(foto), 'image/jpeg')
  assert.deepEqual(headerDimensions(foto, 'image/jpeg'), { width: 40, height: 30 })
  const html = Buffer.from('<html><script>alert(1)</script></html>')
  assert.equal(sniffImageType(html), null)
  await assert.rejects(() => prepareImage(html, 'bild.jpg', 'image/jpeg'), /unsupported/, 'HTML mit Bild-Mimetype ist kein Bild')
  // Gemeldeter Mimetype PNG, Bytes JPEG ⇒ als JPEG behandelt.
  const prepared = await prepareImage(foto, 'bild.png', 'image/png')
  assert.equal(prepared.mimetype, 'image/jpeg')
  // PNG-Header mit 40000×40000 px (Dekompressionsbombe) wird vor dem Dekodieren abgewiesen.
  const bombe = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
  bombe.writeUInt32BE(13, 8); bombe.write('IHDR', 12); bombe.writeUInt32BE(40000, 16); bombe.writeUInt32BE(40000, 20)
  assert.equal(sniffImageType(Buffer.concat([bombe, Buffer.alloc(8)])), 'image/png')
  assert.throws(() => decode(bombe, 'image/png'), /zu groß/)
})

test('Posteingang: Authentication-Results mit DMARC/SPF-Fehlschlag entzieht dem Absender das Vertrauen', async () => {
  const { authenticationFailed } = await import('../src/services/mailInbox')
  const mail = (ar: string | null) => ({ headers: new Map(ar === null ? [] : [['authentication-results', ar]]) }) as any
  assert.equal(authenticationFailed(mail(null)), false, 'ohne Prüfer bleibt es beim bisherigen Verhalten')
  assert.equal(authenticationFailed(mail('mx.example; dmarc=pass header.from=stadt-frankfurt.de')), false)
  assert.equal(authenticationFailed(mail('mx.example; spf=fail smtp.mailfrom=x; dmarc=fail header.from=stadt-frankfurt.de')), true)
  assert.equal(authenticationFailed(mail('mx.example; spf=softfail; dkim=none')), true)
  assert.equal(authenticationFailed(mail('mx.example; spf=fail; dkim=pass')), false, 'gültige DKIM-Signatur reicht')
})

test('Magic-Link: GET verbraucht den Token nicht, erst der POST meldet an', async () => {
  const authRoutes = (await import('../src/routes/auth')).default
  const t = await token()
  const hex = 'a'.repeat(64)
  await pool.execute('UPDATE login_tokens SET token=? WHERE token=?', [hex, t.value])
  const app = Fastify()
  await app.register(cookie)
  await app.register(formbody)
  await app.register(view, { engine: { ejs }, root: path.join(process.cwd(), 'src', 'views'), layout: '/layout.ejs', defaultContext: { isAdmin: false, verjaehrung } })
  const session: Record<string, unknown> = {
    regenerate: async () => {}, save: async () => {}, destroy: async () => {}, cookie: {},
  }
  app.addHook('preHandler', async request => { request.session = session as unknown as typeof request.session })
  await app.register(authRoutes)
  try {
    const preview = await app.inject({ method: 'GET', url: `/login/link/${hex}` })
    assert.equal(preview.statusCode, 200)
    assert.match(preview.body, /Jetzt anmelden/)
    assert.equal((await query('SELECT used_at FROM login_tokens WHERE token=?', [hex]))[0].used_at, null, 'Vorschau-Abruf darf nicht verbrauchen')
    const bad = await app.inject({ method: 'GET', url: '/login/link/nicht-hex' })
    assert.match(bad.body, /ungültig oder abgelaufen/)
    const login = await app.inject({ method: 'POST', url: `/login/link/${hex}` })
    assert.equal(login.statusCode, 302)
    assert.equal(session.userEmail, t.email)
    assert.notEqual((await query('SELECT used_at FROM login_tokens WHERE token=?', [hex]))[0].used_at, null)
    const again = await app.inject({ method: 'POST', url: `/login/link/${hex}` })
    assert.equal(again.statusCode, 200, 'zweiter POST: Token verbraucht ⇒ Login-Seite mit Fehler')
    // Abmelden nur per POST; der alte GET ist ein harmloser Redirect.
    assert.equal((await app.inject({ method: 'GET', url: '/logout' })).headers.location, '/')
    assert.equal((await app.inject({ method: 'POST', url: '/logout' })).headers.location, '/login')
  } finally { await app.close() }
})

test('Autosave validiert Datum, Uhrzeit und Katalog wie die Inline-Bearbeitung', async () => {
  const { VERSTOSS_ARTEN } = await import('../src/config/verstoss')
  const id = await report()
  await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  const app = Fastify()
  app.addHook('preHandler', async request => { request.session = { userId } as typeof request.session })
  await app.register(reportsRoutes)
  try {
    const res = await app.inject({ method: 'PATCH', url: `/anzeige/${az}`, payload: {
      kennzeichen: 'f ab 123', tattag: 'foo', tatzeit_von: '25:99', verstoss_art: 'Erfundener Verstoß', tatort: 'x'.repeat(600), beschreibung: 'ok',
    } })
    assert.equal(res.statusCode, 200, 'ungültige Werte ergeben keinen DB-Fehler')
    let row = (await query('SELECT kennzeichen, tattag, tatzeit_von, verstoss_art, LENGTH(tatort) l FROM reports WHERE id=?', [id]))[0]
    assert.equal(row.kennzeichen, 'F AB 123')
    assert.equal(row.tattag, null)
    assert.equal(row.tatzeit_von, null)
    assert.equal(row.verstoss_art, null)
    assert.equal(row.l, 500)
    await app.inject({ method: 'PATCH', url: `/anzeige/${az}`, payload: { tattag: '2026-10-01', tatzeit_von: '10:15', verstoss_art: VERSTOSS_ARTEN[0] } })
    row = (await query("SELECT DATE_FORMAT(tattag, '%Y-%m-%d') t, tatzeit_von, verstoss_art FROM reports WHERE id=?", [id]))[0]
    assert.deepEqual([row.t, String(row.tatzeit_von).slice(0, 5), row.verstoss_art], ['2026-10-01', '10:15', VERSTOSS_ARTEN[0]])
  } finally { await app.close() }
})

test('Öffentliche Karten-API liefert Koordinaten nur auf ~100 m genau und keine Kennungen', async () => {
  const publicRoutes = (await import('../src/routes/public')).default
  const id = await report()
  await pool.execute("UPDATE reports SET status='versendet', tatort_lat=50.1234567, tatort_lon=8.7654321, tattag='2026-09-01' WHERE id=?", [id])
  const app = Fastify()
  await app.register(cookie)
  await app.register(view, { engine: { ejs }, root: path.join(process.cwd(), 'src', 'views'), layout: '/layout.ejs', defaultContext: { isAdmin: false, verjaehrung } })
  app.addHook('preHandler', async request => { request.session = {} as typeof request.session })
  await app.register(publicRoutes)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/public/reports' })
    assert.equal(res.statusCode, 200)
    const eintrag = (res.json().reports as any[]).find((r) => Math.abs(r.lat - 50.123) < 1e-9)
    assert.ok(eintrag, 'Anzeige erscheint mit gerundeter Breite')
    assert.equal(eintrag.lon, 8.765)
    assert.deepEqual(Object.keys(eintrag).sort(), ['imageUrl', 'imageUrls', 'lat', 'lon', 'tattag', 'verstossArt'], 'keine zusätzlichen Felder (Aktenzeichen, Kennzeichen, Nutzer)')
  } finally { await app.close() }
})

test('submitDraft: Hinderungsgründe sperren, vollständiger Entwurf wird eingereicht und reiht Folgejobs ein', async () => {
  const { submitDraft } = await import('../src/routes/reports')
  const { VERSTOSS_ARTEN } = await import('../src/config/verstoss')
  const id = await report()
  await pool.execute(
    `UPDATE reports SET status='entwurf', tattag=DATE_SUB(CURDATE(), INTERVAL 3 DAY), tatzeit_von='10:00:00',
       tatort='Kurpark 1, 63628 Bad Soden-Salmünster', verstoss_art=?,
       kennzeichen_bestaetigt=CONCAT(COALESCE(kennzeichen_land,'D'),'|',kennzeichen) WHERE id=?`, [VERSTOSS_ARTEN[0], id])
  let row = (await query('SELECT * FROM reports WHERE id=?', [id]))[0]
  // Ungeprüftes Foto ⇒ nicht einreichbar, Status bleibt Entwurf.
  await pool.execute(
    `INSERT INTO report_images (report_id, filename, mimetype, original_filename, original_mimetype, sort_order)
     VALUES (?, 'bild-x.jpg', 'image/jpeg', 'bild-x.jpg', 'image/jpeg', 1)`, [id])
  let out = await submitDraft(row, userId)
  assert.equal(out.ok, false)
  assert.equal((out as any).status, 422)
  assert.equal((await query('SELECT status FROM reports WHERE id=?', [id]))[0].status, 'entwurf')
  await pool.execute('UPDATE report_images SET geprueft_at=NOW() WHERE report_id=?', [id])
  row = (await query('SELECT * FROM reports WHERE id=?', [id]))[0]
  out = await submitDraft(row, userId, { userEmail: 'user@example.invalid' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal((await query('SELECT status FROM reports WHERE id=?', [id]))[0].status, 'eingereicht')
  const jobs = await query("SELECT type FROM jobs WHERE type='mail.submit-notification' AND payload LIKE ? ORDER BY id DESC LIMIT 1", [`%"reportId":${id}%`])
  assert.equal(jobs.length, 1, 'Admin-Benachrichtigung als Job eingereiht')
  // Zweiter Versuch: kein Entwurf mehr ⇒ 409.
  row = (await query('SELECT * FROM reports WHERE id=?', [id]))[0]
  out = await submitDraft(row, userId)
  assert.equal((out as any).status, 409)
})

test('Foto duplizieren kopiert Datei und Zeile, Kopie steht ungeprüft am Ende', async () => {
  const fsp = await import('node:fs/promises')
  const { reportDir } = await import('../src/services/drafts')
  const id = await report()
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
  const dir = reportDir(userId, id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'bild-dup.jpg'), 'JPEGDATA')
  const [ins] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images (report_id, filename, mimetype, original_filename, original_mimetype, sort_order, geprueft_at, detected_plate, kennzeichen_box)
     VALUES (?, 'bild-dup.jpg', 'image/jpeg', 'bild-dup.jpg', 'image/jpeg', 3, NOW(), 'F-AB 1', '[0.1,0.1,0.2,0.2]')`, [id])
  const app = Fastify()
  app.addHook('preHandler', async request => {
    request.session = { userId, userEmail: 'dup@example.invalid' } as typeof request.session
  })
  await app.register(reportsRoutes)
  try {
    const res = await app.inject({ method: 'POST', url: `/anzeige/${az}/images/${ins.insertId}/duplizieren` })
    assert.equal(res.statusCode, 200, res.body)
    const neu = (await query('SELECT * FROM report_images WHERE id=?', [res.json().image.id]))[0]
    assert.notEqual(neu.filename, 'bild-dup.jpg')
    assert.equal(neu.original_filename, neu.filename)
    assert.equal(neu.sort_order, 4)
    assert.equal(neu.geprueft_at, null)
    assert.equal(neu.detected_plate, 'F-AB 1')
    assert.equal(neu.kennzeichen_box, '[0.1,0.1,0.2,0.2]')
    assert.equal(await fsp.readFile(path.join(dir, neu.filename), 'utf8'), 'JPEGDATA')
  } finally { await app.close() }
})
