import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { getBalance, getSubscription, subscribeMonth, InsufficientFundsError } from '../services/credits'
import { prepareImage, writePreparedImage } from '../services/images'
import {
  formatEuro,
  MIN_TOPUP_CENTS,
  BANK,
  PAYPAL_ADDRESS,
  isAdminEmail,
  SUBSCRIPTION_CENTS,
  SUBSCRIPTION_DAYS,
} from '../config/credits'

const REFUND_DIR = path.join(process.cwd(), 'data', 'refunds')
const MAX_SCREENSHOTS = 5

// Verwendungszweck-Alphabet ohne leicht verwechselbare Zeichen (wie beim Aktenzeichen).
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateReference(): string {
  const bytes = crypto.randomBytes(6)
  let code = ''
  for (let i = 0; i < bytes.length; i++) code += REF_ALPHABET[bytes[i] % REF_ALPHABET.length]
  return `OWIA-${code}`
}

/** "5" / "5,00" / "5.00" -> Cent. Gibt NaN zurück, wenn ungültig. */
function parseAmountToCents(raw: string | undefined): number {
  if (!raw) return NaN
  const normalized = String(raw).trim().replace(/\s/g, '').replace(',', '.')
  const euro = Number(normalized)
  if (!Number.isFinite(euro) || euro <= 0) return NaN
  return Math.round(euro * 100)
}

function methodLabel(method: string): string {
  return method === 'paypal' ? 'PayPal' : 'Überweisung'
}

/** Kosten eines Jobs (Analyse) aus der Belastung: bezahlter + gratis gedeckter Anteil. */
function jobCostCents(row: mysql.RowDataPacket): number {
  return Math.max(0, -Number(row.amount_cents)) + Math.max(0, Number(row.free_used_cents))
}

export default async function kontoRoutes(app: FastifyInstance) {
  // Guthaben-Zusammenfassung für die Navbar (kleiner JSON-Endpoint).
  app.get('/api/konto/summary', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const [bal, sub] = await Promise.all([getBalance(userId), getSubscription(userId)])
    return reply.send({
      balanceCents: bal.balanceCents,
      freeCents: bal.freeCents,
      totalCents: bal.totalCents,
      formatted: formatEuro(bal.totalCents),
      subscriptionActive: sub.active,
    })
  })

  // Kontoübersicht: Guthaben, Buchungen, Einzahlungen, Jobs (mit Erstattungs-Status).
  app.get('/konto', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const bal = await getBalance(userId)
    const subscription = await getSubscription(userId)

    const [ledger] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT type, amount_cents, free_used_cents, description, created_at
         FROM account_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      [userId]
    )
    const [deposits] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, amount_cents, method, reference, status, invoice_number, created_at
         FROM deposit_orders WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
      [userId]
    )
    // Jobs = Analyse-Belastungen; refundable, wenn kein Antrag und keine Erstattung existiert.
    const [jobs] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT t.id, t.amount_cents, t.free_used_cents, t.image_id, t.created_at,
              rr.id AS request_id, rr.status AS request_status,
              (SELECT COUNT(*) FROM account_transactions rf
                 WHERE rf.type = 'refund' AND t.image_id IS NOT NULL AND rf.image_id = t.image_id) AS refund_count
         FROM account_transactions t
         LEFT JOIN refund_requests rr ON rr.transaction_id = t.id
        WHERE t.user_id = ? AND t.type = 'analysis_charge'
        ORDER BY t.id DESC LIMIT 100`,
      [userId]
    )

    return reply.view('/konto/index.ejs', viewData(request, {
      title: 'Guthaben-Konto',
      balance: bal,
      subscription,
      subscriptionCents: SUBSCRIPTION_CENTS,
      subscriptionDays: SUBSCRIPTION_DAYS,
      ledger,
      deposits,
      jobs,
      minTopup: MIN_TOPUP_CENTS,
      fmt: formatEuro,
      methodLabel,
      jobCostCents,
    }))
  })

  // Analyse-Flatrate buchen (aus dem bezahlten Guthaben).
  app.post('/konto/abo', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    try {
      const until = await subscribeMonth(userId)
      request.session.flash = {
        type: 'success',
        message: `Analyse-Flatrate aktiviert – gültig bis ${until.toLocaleDateString('de-DE')}.`,
      }
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        request.session.flash = {
          type: 'error',
          message: `Nicht genug Guthaben für die Flatrate. Bitte zuerst mind. ${formatEuro(SUBSCRIPTION_CENTS)} aufladen.`,
        }
      } else {
        throw err
      }
    }
    await request.session.save()
    return reply.redirect('/konto')
  })

  // Einzahlungsauftrag anlegen -> Weiterleitung zur Zahlungsanweisung.
  app.post('/konto/einzahlung', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    const { amount, method } = (request.body || {}) as { amount?: string; method?: string }
    const cents = parseAmountToCents(amount)
    const m = method === 'paypal' ? 'paypal' : method === 'ueberweisung' ? 'ueberweisung' : ''

    if (!m) {
      request.session.flash = { type: 'error', message: 'Bitte eine Zahlungsart wählen.' }
      await request.session.save()
      return reply.redirect('/konto')
    }
    if (!Number.isFinite(cents) || cents < MIN_TOPUP_CENTS) {
      request.session.flash = {
        type: 'error',
        message: `Mindestbetrag für eine Aufladung: ${formatEuro(MIN_TOPUP_CENTS)}.`,
      }
      await request.session.save()
      return reply.redirect('/konto')
    }

    let depositId: number | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      const reference = generateReference()
      try {
        const [result] = await pool.execute<mysql.ResultSetHeader>(
          'INSERT INTO deposit_orders (user_id, amount_cents, method, reference) VALUES (?, ?, ?, ?)',
          [userId, cents, m, reference]
        )
        depositId = result.insertId
        break
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY' && attempt < 4) continue
        throw err
      }
    }
    return reply.redirect(`/konto/einzahlung/${depositId}`)
  })

  // Zahlungsanweisung (Kontodaten / PayPal + Verwendungszweck) für einen Auftrag.
  app.get('/konto/einzahlung/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.session.userId as number
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT * FROM deposit_orders WHERE id = ? AND user_id = ?',
      [id, userId]
    )
    const order = rows[0]
    if (!order) return reply.status(404).send('Einzahlungsauftrag nicht gefunden.')

    return reply.view('/konto/einzahlung.ejs', viewData(request, {
      title: 'Aufladung',
      order,
      bank: BANK,
      paypal: PAYPAL_ADDRESS,
      fmt: formatEuro,
      methodLabel,
    }))
  })

  // Formular: Erstattung für einen Job (Analyse-Belastung) beantragen.
  app.get('/konto/erstattung/:transactionId', { preHandler: requireAuth }, async (request, reply) => {
    const { transactionId } = request.params as { transactionId: string }
    const userId = request.session.userId as number
    const job = await loadRefundableJob(userId, transactionId)
    if (!job) {
      request.session.flash = { type: 'error', message: 'Für diesen Job ist keine Erstattung (mehr) möglich.' }
      await request.session.save()
      return reply.redirect('/konto')
    }
    return reply.view('/konto/erstattung.ejs', viewData(request, {
      title: 'Erstattung beantragen',
      job,
      maxScreenshots: MAX_SCREENSHOTS,
      fmt: formatEuro,
      jobCostCents,
    }))
  })

  // Erstattungsantrag samt optionaler Screenshots anlegen.
  app.post('/konto/erstattung/:transactionId', { preHandler: requireAuth }, async (request, reply) => {
    const { transactionId } = request.params as { transactionId: string }
    const userId = request.session.userId as number
    const job = await loadRefundableJob(userId, transactionId)
    if (!job) {
      request.session.flash = { type: 'error', message: 'Für diesen Job ist keine Erstattung (mehr) möglich.' }
      await request.session.save()
      return reply.redirect('/konto')
    }

    // Multipart einlesen: Grund (Textfeld) + Screenshots (Dateien) puffern.
    let reason = ''
    const files: { buffer: Buffer; filename: string; mimetype: string }[] = []
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'screenshots' || !part.filename) continue
          const buffer = await part.toBuffer()
          if (buffer.length === 0) continue
          if (files.length < MAX_SCREENSHOTS) files.push({ buffer, filename: part.filename, mimetype: part.mimetype || '' })
        } else if (part.fieldname === 'reason') {
          reason = String(part.value || '')
        }
      }
    } catch {
      request.session.flash = { type: 'error', message: 'Bild zu groß (max. 20 MB pro Screenshot).' }
      await request.session.save()
      return reply.redirect(`/konto/erstattung/${transactionId}`)
    }

    reason = reason.trim()
    if (!reason) {
      request.session.flash = { type: 'error', message: 'Bitte gib einen Grund für die Erstattung an.' }
      await request.session.save()
      return reply.redirect(`/konto/erstattung/${transactionId}`)
    }

    let requestId: number
    try {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        'INSERT INTO refund_requests (user_id, transaction_id, image_id, reason) VALUES (?, ?, ?, ?)',
        [userId, job.id, job.image_id ?? null, reason]
      )
      requestId = result.insertId
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        request.session.flash = { type: 'error', message: 'Für diesen Job existiert bereits ein Antrag.' }
        await request.session.save()
        return reply.redirect('/konto')
      }
      throw err
    }

    // Screenshots über die gemeinsame Bild-Pipeline speichern (HEIC->JPG etc.).
    const dir = path.join(REFUND_DIR, String(userId), String(requestId))
    for (const f of files) {
      try {
        const prepared = await prepareImage(f.buffer, f.filename, f.mimetype)
        const { filename, originalFilename } = await writePreparedImage(dir, prepared)
        await pool.execute(
          `INSERT INTO refund_request_images (request_id, filename, mimetype, original_filename, original_mimetype)
           VALUES (?, ?, ?, ?, ?)`,
          [requestId, filename, prepared.mimetype, originalFilename, prepared.originalMimetype]
        )
      } catch {
        /* nicht unterstützte Datei überspringen */
      }
    }

    request.session.flash = {
      type: 'success',
      message: 'Erstattungsantrag eingereicht. Wir prüfen ihn und melden uns.',
    }
    await request.session.save()
    return reply.redirect('/konto')
  })

  // Screenshot eines Erstattungsantrags ausliefern (nur Eigentümer oder Admin).
  app.get(
    '/konto/erstattung/:requestId/screenshot/:imgId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { requestId, imgId } = request.params as { requestId: string; imgId: string }
      const userId = request.session.userId as number
      const admin = isAdminEmail(request.session.userEmail)

      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT rri.filename, rri.mimetype, rr.user_id
           FROM refund_request_images rri
           JOIN refund_requests rr ON rr.id = rri.request_id
          WHERE rri.id = ? AND rri.request_id = ?`,
        [imgId, requestId]
      )
      const img = rows[0]
      if (!img) return reply.status(404).send('Screenshot nicht gefunden.')
      if (!admin && img.user_id !== userId) return reply.status(404).send('Screenshot nicht gefunden.')

      const filePath = path.join(REFUND_DIR, String(img.user_id), String(requestId), img.filename)
      try {
        const buffer = await fs.readFile(filePath)
        return reply.header('Content-Type', img.mimetype || 'application/octet-stream').send(buffer)
      } catch {
        return reply.status(404).send('Screenshot-Datei nicht gefunden.')
      }
    }
  )
}

/** Lädt eine erstattungsfähige Analyse-Belastung des Nutzers (oder undefined). */
async function loadRefundableJob(
  userId: number,
  transactionId: string
): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT t.id, t.amount_cents, t.free_used_cents, t.image_id, t.created_at,
            (SELECT COUNT(*) FROM refund_requests rr WHERE rr.transaction_id = t.id) AS request_count,
            (SELECT COUNT(*) FROM account_transactions rf
               WHERE rf.type = 'refund' AND t.image_id IS NOT NULL AND rf.image_id = t.image_id) AS refund_count
       FROM account_transactions t
      WHERE t.id = ? AND t.user_id = ? AND t.type = 'analysis_charge'`,
    [transactionId, userId]
  )
  const job = rows[0]
  if (!job) return undefined
  if (Number(job.request_count) > 0 || Number(job.refund_count) > 0) return undefined
  return job
}
