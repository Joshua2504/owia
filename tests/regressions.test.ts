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
import { pool } from '../src/db/connection'
import { initDb } from '../src/db/init'
import { runMigrations } from '../src/db/migrate'
import { dispatchReport } from '../src/services/reportDispatch'
import { versandPlatzBelegen, versandPlatzFreigeben, versandMerken, VERSAND_ABSTAND_SEK } from '../src/services/versandTakt'
import { resumeWatchers } from '../src/services/portalDispatch'
import { consumeLoginCode, consumeMagicLink, MAX_LOGIN_ATTEMPTS } from '../src/services/loginTokens'
import { processInboundMail, repliesDir } from '../src/services/mailInbox'
import { MailService } from '../src/services/mail'
import adminRoutes from '../src/routes/admin'
import reportsRoutes from '../src/routes/reports'
import settingsRoutes from '../src/routes/settings'
import { trashDrafts, restoreDrafts, purgeTrash } from '../src/services/drafts'
import view from '@fastify/view'
import { PDFDocument } from 'pdf-lib'
import stickerRoutes from '../src/routes/sticker'
import stickerTestRoutes from '../src/routes/stickerTest'
import { viewHelpers } from '../src/views/helpers'
import { zaehleAufruf, ladeAufrufe } from '../src/services/aufrufe'
import {
  createBatch, linkCode, unlinkCode, voidOpenCodes, normalizeCode, parseLayout, renderBatchPdf, batchCodes, StickerLayout, STICKER_MAX_SEITEN, STICKER_VORLAGEN, vorschauSvg,
} from '../src/services/stickers'
import { ENTWUERFE } from '../src/services/stickerEntwuerfe'
import { setze, satzFonts } from '../src/services/stickerSatz'
import mobileAppRoutes from '../src/routes/mobileApp'
import { appPlatform, isReviewAccount, reviewCodeMatches } from '../src/config/mobileApp'
import { submitDraft } from '../src/routes/reports/submit'

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
  assert.equal(rows.at(-1)?.filename, '0051_auto_schwaerzen.sql')
  assert.equal(rows.length, 51)
})

test('Versand-Takt: höchstens ein Versand je VERSAND_ABSTAND_SEK, Freigabe gibt den Platz zurück', async () => {
  await pool.execute("UPDATE versand_takt SET letzter='2000-01-01', vorher='2000-01-01' WHERE id=1")
  const [a, b] = await Promise.all([versandPlatzBelegen(), versandPlatzBelegen()])
  assert.deepEqual([a, b].filter((x) => x === null).length, 1)
  const warten = a ?? b
  assert.ok(warten! > VERSAND_ABSTAND_SEK - 10 && warten! <= VERSAND_ABSTAND_SEK)
  await versandPlatzFreigeben()
  assert.equal(await versandPlatzBelegen(), null)
  await pool.execute("UPDATE versand_takt SET letzter='2000-01-01', vorher='2000-01-01' WHERE id=1")
  await versandMerken()
  assert.notEqual(await versandPlatzBelegen(), null)
  await pool.execute("UPDATE versand_takt SET letzter='2000-01-01', vorher='2000-01-01' WHERE id=1")
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
  // Der Neustart trägt die Freigabe-Marke der Anzeige mit (Migration 0050).
  const [marke] = await query('SELECT freigabe_token FROM reports WHERE id=?', [id])
  assert.ok(marke.freigabe_token)
  assert.deepEqual(payloads.filter((p) => p.reportId === id), [{ reportId: id, auto: true, neustart: true, freigabe: marke.freigabe_token }])
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
      pending: [{ id: 1, aktenzeichen: 'OWiA-123456', versand_status: state }], recent: [], unmatched: [], verjaehrung, h: viewHelpers,
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
  // Höchstens STICKER_MAX_SEITEN Bögen mit offenen Codes gleichzeitig (über
  // alle Batches): 2 offen → MAX-2 gehen noch, MAX-1 nicht. Fall-Sticker je
  // Verstoß parallel.
  assert.equal(STICKER_MAX_SEITEN, 1000)
  assert.ok('error' in await createBatch(owner, layout, STICKER_MAX_SEITEN - 1))
  assert.ok('error' in await createBatch(owner, layout, STICKER_MAX_SEITEN + 1))
  const gehweg = parseLayout({ vorlage: '70x37', tbnr: '112454', aufdruck: 'Auf dem Gehweg 🚗 geparkt.' }) as StickerLayout
  assert.equal(gehweg.tbnr, '112454')
  assert.equal(gehweg.aufdruck, 'Auf dem Gehweg geparkt.') // Emoji kann die PDF-Schrift nicht
  assert.equal((parseLayout({ vorlage: '105x57', tbnr: '112454' }) as StickerLayout).aufdruck, 'Sie parkten verbotswidrig auf dem Gehweg.')
  assert.match(String(parseLayout({ vorlage: '105x57', tbnr: '999999' })), /Katalog/)
  assert.match(String(parseLayout({ vorlage: 'eigen', tbnr: '112454', cols: 4, rows: 12, labelW: 48.5, labelH: 25.4, marginLeft: 8, marginTop: 10 })), /60 × 33/)
  const fallBatch = await createBatch(owner, gehweg, STICKER_MAX_SEITEN - 2)
  assert.ok('batchId' in fallBatch)
  assert.ok('error' in await createBatch(owner, layout, 1))
  const fallPdf = await PDFDocument.load(await renderBatchPdf((await batchCodes(fallBatch.batchId)).slice(0, 24), gehweg, 'https://owia.example'))
  assert.equal(fallPdf.getPageCount(), 1)
  assert.equal(await voidOpenCodes(owner, fallBatch.batchId), (STICKER_MAX_SEITEN - 2) * 24)

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

test('Sticker-Textvorlagen: passen in jedes Format, Tatbestand und PDF', async () => {
  // Stabile Schlüssel: Favoriten und Batches speichern den Slug.
  assert.equal(new Set(ENTWUERFE.map(e => e.slug)).size, ENTWUERFE.length)
  assert.equal(ENTWUERFE.length, 50)
  const fonts = await satzFonts()
  for (const e of ENTWUERFE) {
    for (const v of STICKER_VORLAGEN) {
      const satz = setze(e, v.labelW, v.labelH, { betrag: '55\u00a0€', codeLabel: 'owia.net/S/XXXX-XXXX', fonts })
      assert.ok(satz.passt, `${e.slug} passt nicht auf ${v.id}`)
      assert.ok(satz.qr.size >= 15, `${e.slug}: QR auf ${v.id} kleiner als 15 mm`)
    }
  }
  assert.match(String(parseLayout({ vorlage: '105x57', entwurf: 'sachlich-ordnungsamt' })), /Betrag/)
  assert.match(String(parseLayout({ vorlage: '105x57', entwurf: 'gibt-es-nicht' })), /gibt es nicht/)
  assert.match(String(parseLayout({ vorlage: 'eigen', entwurf: 'minimal', cols: 4, rows: 12, labelW: 48.5, labelH: 25.4, marginLeft: 8, marginTop: 10 })), /60 × 33/)
  // Vorlage ohne Betrag braucht keinen Verstoß; Vorlage mit festem Tatbestand
  // überstimmt die Auswahl, ein Aufdruck gilt nur für den klassischen Text.
  assert.equal((parseLayout({ vorlage: '70x37', entwurf: 'minimal' }) as StickerLayout).tbnr, null)
  const radweg = parseLayout({ vorlage: '105x57', entwurf: 'radweg', tbnr: '141312', aufdruck: 'x' }) as StickerLayout
  assert.equal(radweg.entwurf, 'radweg')
  assert.equal(radweg.tbnr, '112474')
  assert.equal(radweg.aufdruck, null)
  const pdf = await PDFDocument.load(await renderBatchPdf(['7KQ27KQ2', '8XM98XM9'], radweg, 'https://owia.example'))
  assert.equal(pdf.getPageCount(), 1)
  assert.match(String(await vorschauSvg(radweg, 'https://owia.example')), /^<svg[^>]*viewBox="0 0 105 57"/)
  assert.equal(await vorschauSvg(parseLayout({ vorlage: '105x57' }) as StickerLayout, 'https://owia.example'), null)
})

test('Sticker-Entwürfe: Favoriten nur angemeldet, je Nutzer, stehen oben', async () => {
  const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO users(email) VALUES ('sticker-favorit@example.invalid')")
  let viewer: number | undefined = u.insertId
  const app = Fastify()
  await app.register(cookie)
  await app.register(formbody)
  await app.register(view, {
    engine: { ejs },
    root: path.join(process.cwd(), 'src', 'views'),
    layout: '/layout.ejs',
    defaultContext: { isAdmin: false, h: viewHelpers, verjaehrung },
  })
  app.addHook('preHandler', async request => { request.session = { userId: viewer } as typeof request.session })
  await app.register(stickerTestRoutes)
  const favorit = (slug: string) => app.inject({
    method: 'POST', url: '/sticker-test/favorit', payload: `slug=${slug}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  const kartenIds = (html: string) => [...html.matchAll(/class="card h-100[^"]*" id="([^"]+)"/g)].map(m => m[1])
  try {
    const leer = await app.inject({ method: 'GET', url: '/sticker-test' })
    assert.equal(leer.statusCode, 200)
    assert.equal(kartenIds(leer.body).length, 50)
    assert.equal(kartenIds(leer.body)[0], 'sachlich-ordnungsamt')

    assert.equal((await favorit('zeitung')).headers.location, '/sticker-test#zeitung')
    await favorit('minimal')
    const mit = await app.inject({ method: 'GET', url: '/sticker-test' })
    assert.deepEqual(kartenIds(mit.body).slice(0, 2), ['minimal', 'zeitung'])
    assert.equal(kartenIds(mit.body).length, 50)

    await favorit('zeitung') // zweiter Klick nimmt den Favoriten zurück
    assert.deepEqual((await query('SELECT slug FROM sticker_entwurf_favoriten WHERE user_id=?', [u.insertId])).map(r => r.slug), ['minimal'])
    assert.equal((await favorit('gibt-es-nicht')).statusCode, 400)

    viewer = undefined
    const anonym = await favorit('minimal')
    assert.equal(anonym.headers.location, '/login?weiter=/sticker-test')
    const seite = await app.inject({ method: 'GET', url: '/sticker-test' })
    assert.equal(kartenIds(seite.body)[0], 'sachlich-ordnungsamt', 'Favoriten anderer Nutzer bleiben privat')
    assert.ok(!seite.body.includes('/sticker-test/favorit'))
  } finally {
    await app.close()
  }
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
    defaultContext: { isAdmin: false, h: viewHelpers, verjaehrung },
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

test('Marke: VW wird zu Volkswagen', async () => {
  const { markeNormalisieren } = await import('../src/config/fahrzeug')
  assert.equal(markeNormalisieren('VW'), 'Volkswagen')
  assert.equal(markeNormalisieren('vw'), 'Volkswagen')
  assert.equal(markeNormalisieren('VW Caddy'), 'Volkswagen Caddy')
  assert.equal(markeNormalisieren('Volkswagen'), 'Volkswagen')
  assert.equal(markeNormalisieren('Volvo'), 'Volvo')
  assert.equal(markeNormalisieren('VWX'), 'VWX')
})

test('Hintergrund-Jobs: gleicher Schlüssel wird nur einmal eingereiht', async () => {
  const { enqueueJob } = await import('../src/services/jobs')
  await enqueueJob('test.noop', { a: 1 }, { key: 'test.noop:1' })
  await enqueueJob('test.noop', { a: 1 }, { key: 'test.noop:1' })
  const rows = await query("SELECT COUNT(*) AS n FROM jobs WHERE pending_key = 'test.noop:1'")
  assert.equal(Number(rows[0].n), 1)
  await pool.execute("DELETE FROM jobs WHERE type = 'test.noop'")
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
  assert.equal(hasPdfForm(getCity('hamburg')), false)
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

test('Posteingang: Aktenzeichen-Matching nur mit positivem Ergebnis im obersten Authentication-Results unseres MTA', async () => {
  const { senderAuthenticated } = await import('../src/services/mailInbox')
  const vorher = process.env.MAIL_AUTHSERV_ID
  process.env.MAIL_AUTHSERV_ID = 'mx.example'
  try {
    const from = 'owi-anzeigen@stadt-frankfurt.de'
    const mail = (...ars: string[]) => ({ headerLines: ars.map((v) => ({ key: 'authentication-results', line: `Authentication-Results: ${v}` })) }) as any
    assert.equal(senderAuthenticated(mail(), from), false, 'ohne Prüfer kein Aktenzeichen-Matching')
    assert.equal(senderAuthenticated(mail('mx.example;\r\n\tdmarc=pass (policy=none) header.from=stadt-frankfurt.de'), from), true)
    assert.equal(senderAuthenticated(mail('mx.example; dkim=pass header.d=stadt-frankfurt.de header.s=main'), from), true)
    assert.equal(senderAuthenticated(mail('mx.example; spf=pass (mx.example: domain of x designates 1.2.3.4) smtp.mailfrom=owi-anzeigen@stadt-frankfurt.de'), from), true)
    assert.equal(senderAuthenticated(mail('mx.example; dkim=pass header.d=evil.example'), from), false, 'DKIM einer fremden Domain zählt nicht')
    assert.equal(senderAuthenticated(mail('mx.example; spf=fail smtp.mailfrom=x; dmarc=fail header.from=stadt-frankfurt.de'), from), false)
    assert.equal(senderAuthenticated(mail('mx.example; spf=softfail; dkim=none'), from), false, 'kein fail reicht nicht – es braucht ein pass')
    // Angriff: eigener MTA meldet spf=fail, der Absender hat darunter einen
    // „dmarc=pass“-Header mitgeschickt – nur der oberste zählt.
    assert.equal(senderAuthenticated(mail('mx.example; spf=fail smtp.mailfrom=stadt-frankfurt.de', 'mx.example; dmarc=pass header.from=stadt-frankfurt.de'), from), false)
    // Fremde authserv-id oben (unser MTA hat nicht geprüft) ⇒ kein Vertrauen.
    assert.equal(senderAuthenticated(mail('evil.example; dmarc=pass header.from=stadt-frankfurt.de'), from), false)
  } finally {
    if (vorher === undefined) delete process.env.MAIL_AUTHSERV_ID
    else process.env.MAIL_AUTHSERV_ID = vorher
  }
})

test('Antwort-Anhänge: Content-Type nur aus Whitelist', async () => {
  const { normalizeAttachmentType } = await import('../src/services/mailInbox')
  assert.equal(normalizeAttachmentType('application/pdf'), 'application/pdf')
  assert.equal(normalizeAttachmentType('IMAGE/JPG; name=x'), 'image/jpeg')
  assert.equal(normalizeAttachmentType('text/html'), 'application/octet-stream')
  assert.equal(normalizeAttachmentType('image/svg+xml'), 'application/octet-stream')
  assert.equal(normalizeAttachmentType(null), 'application/octet-stream')
})

test('Magic-Link: GET verbraucht den Token nicht, erst der POST meldet an', async () => {
  const authRoutes = (await import('../src/routes/auth')).default
  const t = await token()
  const hex = 'a'.repeat(64)
  await pool.execute('UPDATE login_tokens SET token=? WHERE token=?', [hex, t.value])
  const app = Fastify()
  await app.register(cookie)
  await app.register(formbody)
  await app.register(view, { engine: { ejs }, root: path.join(process.cwd(), 'src', 'views'), layout: '/layout.ejs', defaultContext: { isAdmin: false, h: viewHelpers, verjaehrung } })
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

test('Öffentliche Karten-API liefert genaue Koordinaten (~1 m) und keine Kennungen', async () => {
  const publicRoutes = (await import('../src/routes/public')).default
  const id = await report()
  await pool.execute("UPDATE reports SET status='versendet', tatort_lat=50.1234567, tatort_lon=8.7654321, tattag='2026-09-01' WHERE id=?", [id])
  const app = Fastify()
  await app.register(cookie)
  await app.register(view, { engine: { ejs }, root: path.join(process.cwd(), 'src', 'views'), layout: '/layout.ejs', defaultContext: { isAdmin: false, h: viewHelpers, verjaehrung } })
  app.addHook('preHandler', async request => { request.session = {} as typeof request.session })
  await app.register(publicRoutes)
  try {
    const res = await app.inject({ method: 'GET', url: '/api/public/reports' })
    assert.equal(res.statusCode, 200)
    const eintrag = (res.json().reports as any[]).find((r) => Math.abs(r.lat - 50.12346) < 1e-9)
    assert.ok(eintrag, 'Anzeige erscheint mit genauer Breite')
    assert.equal(eintrag.lon, 8.76543)
    assert.deepEqual(Object.keys(eintrag).sort(), ['betrag', 'imageUrl', 'imageUrls', 'lat', 'lon', 'tattag', 'verstossArt'], 'keine zusätzlichen Felder (Aktenzeichen, Kennzeichen, Nutzer) – betrag = BKat-Regelsatz (0495cac)')
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

test('Original wiederherstellen verwirft die bearbeitete Fassung, nur bei Entwürfen', async () => {
  const fsp = await import('node:fs/promises')
  const jpeg = (await import('jpeg-js')).default
  const { reportDir } = await import('../src/services/drafts')
  const id = await report()
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
  const dir = reportDir(userId, id)
  await fsp.mkdir(dir, { recursive: true })
  const bild = jpeg.encode({ data: Buffer.alloc(4 * 4 * 4, 200), width: 4, height: 4 }, 90).data
  await fsp.writeFile(path.join(dir, 'bild-orig.jpg'), bild)
  await fsp.writeFile(path.join(dir, 'bild-schwarz.jpg'), bild)
  await fsp.writeFile(path.join(dir, 'bild-schwarz.jpg.thumb.jpg'), 'T')
  const [ins] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images (report_id, filename, mimetype, original_filename, original_mimetype, sort_order, geprueft_at, dritte_ok, analyse_json, kennzeichen_box)
     VALUES (?, 'bild-schwarz.jpg', 'image/jpeg', 'bild-orig.jpg', 'image/jpeg', 1, NOW(), 1, '{"w":4,"h":4,"plates":[],"faces":[]}', '[0.1,0.1,0.2,0.2]')`, [id])
  const app = Fastify()
  app.addHook('preHandler', async request => {
    request.session = { userId, userEmail: 'orig@example.invalid' } as typeof request.session
  })
  await app.register(reportsRoutes)
  try {
    const res = await app.inject({ method: 'POST', url: `/anzeige/${az}/images/${ins.insertId}/original` })
    assert.equal(res.statusCode, 200, res.body)
    const row = (await query('SELECT * FROM report_images WHERE id=?', [ins.insertId]))[0]
    assert.equal(row.filename, 'bild-orig.jpg')
    assert.equal(row.geprueft_at, null)
    assert.equal(row.dritte_ok, 0)
    assert.equal(row.kennzeichen_box, null)
    await assert.rejects(fsp.access(path.join(dir, 'bild-schwarz.jpg')))
    await assert.rejects(fsp.access(path.join(dir, 'bild-schwarz.jpg.thumb.jpg')))
    await fsp.access(path.join(dir, 'bild-orig.jpg'))
    // Nichts mehr zu tun: unverändert, Original bleibt.
    const nochmal = await app.inject({ method: 'POST', url: `/anzeige/${az}/images/${ins.insertId}/original` })
    assert.equal(nochmal.json().unveraendert, true)
    // Eingereichte Anzeigen bleiben unangetastet.
    await pool.execute("UPDATE report_images SET filename='bild-x.jpg' WHERE id=?", [ins.insertId])
    await pool.execute("UPDATE reports SET status='eingereicht' WHERE id=?", [id])
    const gesperrt = await app.inject({ method: 'POST', url: `/anzeige/${az}/images/${ins.insertId}/original` })
    assert.equal(gesperrt.statusCode, 409)
  } finally { await app.close() }
})

test('Automatisches Schwärzen: Entwurf wird geschwärzt, „Schwärzung aufheben" stellt das Original her und sperrt weitere', async () => {
  const fsp = await import('node:fs/promises')
  const jpeg = (await import('jpeg-js')).default
  const { reportDir } = await import('../src/services/drafts')
  const { schwaerzeAnzeige, schwaerzenNachholen } = await import('../src/services/dritteSchwaerzen')
  const id = await report()
  const az = (await query('SELECT aktenzeichen FROM reports WHERE id=?', [id]))[0].aktenzeichen
  await pool.execute("UPDATE reports SET status='entwurf', kennzeichen='F-AB 123', versand_status=NULL WHERE id=?", [id])
  const dir = reportDir(userId, id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'auto.jpg'), jpeg.encode({ data: Buffer.alloc(400 * 300 * 4, 255), width: 400, height: 300 }, 90).data)
  const analyse = JSON.stringify({ w: 200, h: 150, faces: [], plates: [
    { text: 'F AB 123', confidence: 0.9, bbox: [10, 100, 60, 120] },
    { text: 'F XY 999', confidence: 0.9, bbox: [50, 50, 100, 75] },
  ] })
  const [ins] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO report_images (report_id, filename, mimetype, original_filename, original_mimetype, sort_order, analyse_json, analysis_status)
     VALUES (?, 'auto.jpg', 'image/jpeg', 'auto.jpg', 'image/jpeg', 1, ?, 'done')`, [id, analyse])
  assert.ok((await schwaerzenNachholen()) >= 1, 'Bestand wird erkannt')
  assert.equal(await schwaerzeAnzeige(id), 1)
  let row = (await query('SELECT * FROM report_images WHERE id=?', [ins.insertId]))[0]
  assert.notEqual(row.filename, 'auto.jpg')
  assert.equal(row.original_filename, 'auto.jpg')
  assert.equal(row.auto_geschwaerzt, 1)
  const out = jpeg.decode(await fsp.readFile(path.join(dir, row.filename)))
  assert.ok(out.data[(125 * 400 + 150) * 4] < 30, 'fremdes Kennzeichen schwarz')
  assert.ok(out.data[(220 * 400 + 70) * 4] > 225, 'eigenes Kennzeichen lesbar')
  // Je Fassung nur einmal – auch wenn die Analyse (hier: ALPR aus) noch Funde hätte.
  await pool.execute('UPDATE report_images SET analyse_json=? WHERE id=?', [analyse, ins.insertId])
  assert.equal(await schwaerzeAnzeige(id), 0)

  const app = Fastify()
  app.addHook('preHandler', async request => {
    request.session = { userId, userEmail: 'auto@example.invalid' } as typeof request.session
  })
  await app.register(reportsRoutes)
  try {
    const res = await app.inject({ method: 'POST', url: `/anzeige/${az}/images/${ins.insertId}/original` })
    assert.equal(res.statusCode, 200, res.body)
  } finally { await app.close() }
  row = (await query('SELECT * FROM report_images WHERE id=?', [ins.insertId]))[0]
  assert.equal(row.filename, 'auto.jpg')
  assert.equal(row.auto_geschwaerzt, 0)
  assert.equal(row.auto_schwaerzen_aus, 1)
  // Nutzer hat aufgehoben: kein erneutes automatisches Schwärzen.
  await pool.execute('UPDATE report_images SET analyse_json=? WHERE id=?', [analyse, ins.insertId])
  assert.equal(await schwaerzeAnzeige(id), 0)
  assert.equal((await query('SELECT filename FROM report_images WHERE id=?', [ins.insertId]))[0].filename, 'auto.jpg')
})

test('Aufrufe: nur Navigationen, Routen-Muster statt URL, Herkunft ohne Personenbezug', async () => {
  const app = Fastify()
  app.addHook('onResponse', async (request, reply) => zaehleAufruf(app, request, reply))
  const html = (_req: unknown, reply: import('fastify').FastifyReply) => reply.type('text/html').send('<p>ok</p>')
  app.get('/', html)
  app.get('/anzeige/:az', html)
  app.get('/login', html)
  app.get('/daten', async () => ({ ok: true }))
  const nav = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', host: 'owia.test' }
  const holen = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...nav, ...headers } })
  try {
    await pool.execute('DELETE FROM seitenaufrufe')
    await holen('/')                                                        // direkt
    await holen('/', { referer: 'https://www.google.com/search?q=owia' })   // extern, nur Host
    await holen('/anzeige/OWiA-000042?x=1', { referer: 'https://owia.test/' })
    await holen('/anzeige/OWiA-000043', { referer: 'https://owia.test/' })
    await holen('/login', { referer: 'https://owia.test/anzeige/OWiA-000042' })
    // Nicht gezählt: fetch, iframe, Prefetch, JSON, 404, Bot ohne Fetch-Metadata.
    await holen('/', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })
    await holen('/', { 'sec-fetch-dest': 'iframe' })
    await holen('/', { 'sec-purpose': 'prefetch' })
    await holen('/daten')
    await holen('/gibt-es-nicht')
    await app.inject({ method: 'GET', url: '/' })
    await new Promise((r) => setTimeout(r, 100)) // Zählung ist fire-and-forget
    const rows = await query('SELECT pfad, von, anzahl FROM seitenaufrufe ORDER BY pfad, von')
    assert.deepEqual(rows.map((r) => [r.pfad, r.von, Number(r.anzahl)]), [
      ['/', 'direkt', 1],
      ['/', 'extern:google.com', 1],
      ['/anzeige/:az', '/', 2],
      ['/login', '/anzeige/:az', 1],
    ])
    const a = await ladeAufrufe(7, '/anzeige/:az')
    assert.equal(a.gesamt, 5)
    assert.equal(a.proTag.length, 7)
    assert.equal(a.proTag.at(-1)?.anzahl, 5)
    assert.deepEqual(a.wege.map((w) => [w.von, w.pfad, w.anzahl]), [['/', '/anzeige/:az', 2], ['/anzeige/:az', '/login', 1]])
    assert.equal(a.extern, 1)
    assert.deepEqual(a.detail?.wohin, [{ name: '/login', anzahl: 1 }])
    const seite = await ejs.renderFile(path.join(process.cwd(), 'src/views/admin/aufrufe.ejs'), { a, zeitraeume: [7, 30], h: viewHelpers })
    assert.match(seite, /google\.com/)
    assert.doesNotMatch(seite, /OWiA-0000/)
  } finally { await app.close() }
})

// Setzt Umgebungsvariablen für die Dauer eines Tests und stellt sie danach wieder her.
function envSichern(keys: string[]): () => void {
  const alt = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  return () => { for (const k of keys) { if (alt[k] === undefined) delete process.env[k]; else process.env[k] = alt[k] } }
}

test('Native App: Erkennung am User-Agent, Domain-Verknüpfung nur mit Konfiguration', async () => {
  const req = (ua: string) => ({ headers: { 'user-agent': ua } }) as unknown as Parameters<typeof appPlatform>[0]
  assert.equal(appPlatform(req('Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile Safari/537.36 OWiA-App/android')), 'android')
  assert.equal(appPlatform(req('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 OWiA-App/ios')), 'ios')
  assert.equal(appPlatform(req('Mozilla/5.0 (iPhone) Safari/604.1')), null)

  const restore = envSichern(['APP_IOS_TEAM_ID', 'APP_ANDROID_SHA256'])
  const app = Fastify()
  await app.register(mobileAppRoutes)
  try {
    delete process.env.APP_IOS_TEAM_ID
    delete process.env.APP_ANDROID_SHA256
    assert.equal((await app.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' })).statusCode, 404)

    process.env.APP_IOS_TEAM_ID = 'ABCDE12345'
    const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')
    // Ungültige Einträge fallen still heraus, gültige bleiben.
    process.env.APP_ANDROID_SHA256 = `kaputt, ${fp.toLowerCase()}`
    const aasa = await app.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' })
    assert.equal(aasa.statusCode, 200)
    assert.match(String(aasa.headers['content-type']), /application\/json/)
    const details = aasa.json().applinks.details[0]
    assert.deepEqual(details.appIDs, ['ABCDE12345.net.owia.app'])
    assert.ok(details.components.some((c: { '/': string }) => c['/'] === '/login/link/*'))
    const links = (await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' })).json()
    assert.equal(links[0].target.package_name, 'net.owia.app')
    assert.deepEqual(links[0].target.sha256_cert_fingerprints, [fp])
  } finally {
    restore()
    await app.close()
  }
})

test('Demo-Konto der Store-Prüfung: fester Code, Einreichen gesperrt', async () => {
  const restore = envSichern(['APP_REVIEW_EMAIL', 'APP_REVIEW_CODE'])
  try {
    process.env.APP_REVIEW_EMAIL = 'Review@Example.invalid'
    process.env.APP_REVIEW_CODE = '12345' // zu kurz ⇒ aus
    assert.equal(isReviewAccount('review@example.invalid'), false)
    process.env.APP_REVIEW_CODE = '424242'
    assert.equal(isReviewAccount(' review@example.invalid '), true)
    assert.equal(isReviewAccount('user@example.invalid'), false)
    assert.equal(reviewCodeMatches('review@example.invalid', '000000'), false)
    assert.equal(reviewCodeMatches('user@example.invalid', '424242'), false)
    assert.equal(reviewCodeMatches('review@example.invalid', '424242'), true)

    const [created] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO users(email, vorname, nachname, strasse, hausnummer, plz, ort)
       VALUES ('review@example.invalid', 'App', 'Review', 'Testweg', '1', '63628', 'Testort')`
    )
    const id = await report(created.insertId)
    await pool.execute("UPDATE reports SET status='entwurf' WHERE id=?", [id])
    const row = (await query('SELECT * FROM reports WHERE id=?', [id]))[0]
    const outcome = await submitDraft(row, created.insertId, { sofort: true })
    assert.equal(outcome.ok, false)
    assert.equal((await query('SELECT status FROM reports WHERE id=?', [id]))[0].status, 'entwurf')
  } finally {
    restore()
  }
})
