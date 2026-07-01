import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAdmin, viewData } from '../middleware/auth'
import { confirmDeposit, cancelDeposit, decideRefundRequest } from '../services/credits'
import { MailService } from '../services/mail'
import { formatEuro } from '../config/credits'

/** Kosten eines Jobs (Analyse) aus der Belastung: bezahlter + gratis gedeckter Anteil. */
function jobCostCents(row: mysql.RowDataPacket): number {
  return Math.max(0, -Number(row.amount_cents)) + Math.max(0, Number(row.free_used_cents))
}

export default async function adminRoutes(app: FastifyInstance) {
  app.get('/admin', { preHandler: requireAdmin }, async (_request, reply) => {
    return reply.redirect('/admin/einzahlungen')
  })

  // Offene Einzahlungen bestätigen/stornieren.
  app.get('/admin/einzahlungen', { preHandler: requireAdmin }, async (request, reply) => {
    const [deposits] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT d.id, d.amount_cents, d.method, d.reference, d.created_at,
              u.email, u.vorname, u.nachname
         FROM deposit_orders d
         JOIN users u ON u.id = d.user_id
        WHERE d.status = 'pending'
        ORDER BY d.id ASC`
    )
    return reply.view('/admin/einzahlungen.ejs', viewData(request, {
      title: 'Admin · Einzahlungen',
      deposits,
      fmt: formatEuro,
    }))
  })

  app.post('/admin/einzahlungen/:id/bestaetigen', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const adminEmail = request.session.userEmail as string
    const { payment_reference } = (request.body || {}) as { payment_reference?: string }
    const paymentReference = (payment_reference || '').trim()

    if (!paymentReference) {
      request.session.flash = { type: 'error', message: 'Bitte eine Zahlungsreferenz angeben.' }
      await request.session.save()
      return reply.redirect('/admin/einzahlungen')
    }

    const result = await confirmDeposit(Number(id), adminEmail, paymentReference)
    if (result) {
      // Rechnung an den Nutzer schicken (Fehler dabei dürfen die Gutschrift nicht blockieren).
      try {
        const [uRows] = await pool.execute<mysql.RowDataPacket[]>(
          'SELECT id, email, vorname, nachname, strasse, plz, ort FROM users WHERE id = ?',
          [result.userId]
        )
        if (uRows[0]) {
          await MailService.sendDepositInvoice(uRows[0], {
            amountCents: result.amountCents,
            method: result.method,
            reference: result.reference,
            paymentReference: result.paymentReference,
            invoiceNumber: result.invoiceNumber,
          })
        }
        request.session.flash = {
          type: 'success',
          message: `Einzahlung gutgeschrieben, Rechnung ${result.invoiceNumber} versendet.`,
        }
      } catch (err) {
        app.log.error({ err }, 'Rechnungsversand fehlgeschlagen')
        request.session.flash = {
          type: 'success',
          message: `Einzahlung gutgeschrieben (Rechnung ${result.invoiceNumber}). Rechnungs-E-Mail konnte nicht versendet werden.`,
        }
      }
    } else {
      request.session.flash = { type: 'error', message: 'Einzahlung bereits bearbeitet oder nicht gefunden.' }
    }
    await request.session.save()
    return reply.redirect('/admin/einzahlungen')
  })

  app.post('/admin/einzahlungen/:id/stornieren', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const adminEmail = request.session.userEmail as string
    await cancelDeposit(Number(id), adminEmail)
    request.session.flash = { type: 'success', message: 'Einzahlung storniert.' }
    await request.session.save()
    return reply.redirect('/admin/einzahlungen')
  })

  // Offene Erstattungsanträge prüfen.
  app.get('/admin/erstattungen', { preHandler: requireAdmin }, async (request, reply) => {
    const [requests] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT r.id, r.reason, r.created_at, r.transaction_id, r.image_id,
              u.email, u.vorname, u.nachname,
              t.amount_cents, t.free_used_cents
         FROM refund_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN account_transactions t ON t.id = r.transaction_id
        WHERE r.status = 'pending'
        ORDER BY r.id ASC`
    )

    // Screenshots je Antrag laden und gruppieren.
    const screenshots: Record<number, number[]> = {}
    if (requests.length) {
      const ids = requests.map((r) => r.id)
      const placeholders = ids.map(() => '?').join(',')
      const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, request_id FROM refund_request_images WHERE request_id IN (${placeholders}) ORDER BY id`,
        ids
      )
      for (const img of imgs) {
        ;(screenshots[img.request_id] ||= []).push(img.id)
      }
    }

    return reply.view('/admin/erstattungen.ejs', viewData(request, {
      title: 'Admin · Erstattungen',
      requests,
      screenshots,
      fmt: formatEuro,
      jobCostCents,
    }))
  })

  app.post('/admin/erstattungen/:id/genehmigen', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const adminEmail = request.session.userEmail as string
    const { note } = (request.body || {}) as { note?: string }
    await decideRefundRequest(Number(id), true, adminEmail, (note || '').trim() || undefined)
    request.session.flash = { type: 'success', message: 'Erstattung genehmigt und gutgeschrieben.' }
    await request.session.save()
    return reply.redirect('/admin/erstattungen')
  })

  app.post('/admin/erstattungen/:id/ablehnen', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const adminEmail = request.session.userEmail as string
    const { note } = (request.body || {}) as { note?: string }
    await decideRefundRequest(Number(id), false, adminEmail, (note || '').trim() || undefined)
    request.session.flash = { type: 'success', message: 'Erstattungsantrag abgelehnt.' }
    await request.session.save()
    return reply.redirect('/admin/erstattungen')
  })
}
