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
import { regelsatzEuro } from '../src/config/verstoss'
import { pool } from '../src/db/connection'
import { initDb } from '../src/db/init'
import { runMigrations } from '../src/db/migrate'
import { dispatchReport } from '../src/services/reportDispatch'
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
    `INSERT INTO users(email, vorname, nachname, strasse, plz, ort)
     VALUES ('user@example.invalid', 'Test', 'Nutzer', 'Testweg 1', '63628', 'Testort')`
  )
  userId = result.insertId
})
after(async () => { await pool.end() })

test('Migrationen sind vollständig und wiederholbar', async () => {
  const rows = await query('SELECT filename FROM schema_migrations ORDER BY filename')
  assert.equal(rows.at(-1)?.filename, '0037_sticker.sql')
  assert.equal(rows.length, 37)
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
  // Solange Codes offen sind, gibt es keine neuen Bögen.
  assert.ok('error' in await createBatch(owner, layout, 1))
  assert.ok('error' in await createBatch(owner, layout, 21))

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

    // Entwürfe sind nicht öffentlich.
    await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
    const draft = await app.inject({ method: 'GET', url: `/S/${code}` })
    assert.match(draft.body, /keine öffentlichen Angaben/)
    assert.ok(!draft.body.includes('Gehweg'))

    // Besitzer: Banner, Verknüpfungsformular für offene Codes, kein Zähler.
    viewer = owner
    const own = await app.inject({ method: 'GET', url: `/S/${code}` })
    assert.ok(own.body.includes(az))
    assert.equal((await query('SELECT scan_count FROM sticker_codes WHERE code=?', [code]))[0].scan_count, 2)
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
