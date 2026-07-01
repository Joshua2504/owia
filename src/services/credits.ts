// Geld-Logik des Guthaben-Kontos. Alle Beträge in Cent (INT). Jede Bewegung wird
// transaktional gebucht (mysql2 getConnection + beginTransaction) und im Hauptbuch
// account_transactions protokolliert. Belastungen/Erstattungen sperren die betroffene
// Nutzer-Zeile (SELECT ... FOR UPDATE), um Doppelbuchungen bei parallelen Anfragen zu
// verhindern.
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import {
  ANALYSIS_PRICE_CENTS,
  FREE_DAILY_CENTS,
  FREE_CAP_CENTS,
  SUBSCRIPTION_CENTS,
  SUBSCRIPTION_DAYS,
} from '../config/credits'

/** Wird geworfen, wenn Frei- + bezahltes Guthaben für eine Belastung nicht reichen. */
export class InsufficientFundsError extends Error {
  constructor(message = 'Nicht genug Guthaben') {
    super(message)
    this.name = 'InsufficientFundsError'
  }
}

export type Balance = { balanceCents: number; freeCents: number; totalCents: number }

function toBalance(balanceCents: number, freeCents: number): Balance {
  return { balanceCents, freeCents, totalCents: balanceCents + freeCents }
}

/**
 * Tägliche Gutschrift des Freiguthabens innerhalb einer bestehenden (sperrenden)
 * Transaktion. Für jeden seit der letzten Gutschrift vergangenen Tag +FREE_DAILY_CENTS,
 * gedeckelt bei FREE_CAP_CENTS. Erstkontakt (free_accrued_on IS NULL) stempelt nur das
 * Datum – das per DEFAULT vergebene heutige Freiguthaben gilt bereits.
 */
async function accrueFreeCreditTx(conn: mysql.PoolConnection, userId: number): Promise<void> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT free_cents, free_accrued_on, DATEDIFF(CURDATE(), free_accrued_on) AS days_missed
       FROM users WHERE id = ? FOR UPDATE`,
    [userId]
  )
  const u = rows[0]
  if (!u) throw new Error('Benutzer nicht gefunden')
  if (u.free_accrued_on == null) {
    await conn.execute('UPDATE users SET free_accrued_on = CURDATE() WHERE id = ?', [userId])
    return
  }
  const days = Number(u.days_missed)
  if (!Number.isFinite(days) || days <= 0) return
  const next = Math.min(FREE_CAP_CENTS, Number(u.free_cents) + days * FREE_DAILY_CENTS)
  await conn.execute('UPDATE users SET free_cents = ?, free_accrued_on = CURDATE() WHERE id = ?', [
    next,
    userId,
  ])
}

/**
 * Leichte, nicht sperrende Gutschrift für reine Lese-Sichten (z.B. Navbar). Nutzt ein
 * Compare-and-Set über free_accrued_on, damit parallele Aufrufe nicht doppelt gutschreiben.
 */
async function accrueFreeCreditLazy(userId: number): Promise<void> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT free_cents, free_accrued_on, DATEDIFF(CURDATE(), free_accrued_on) AS days_missed
       FROM users WHERE id = ?`,
    [userId]
  )
  const u = rows[0]
  if (!u) return
  if (u.free_accrued_on == null) {
    await pool.execute(
      'UPDATE users SET free_accrued_on = CURDATE() WHERE id = ? AND free_accrued_on IS NULL',
      [userId]
    )
    return
  }
  const days = Number(u.days_missed)
  if (!Number.isFinite(days) || days <= 0) return
  const next = Math.min(FREE_CAP_CENTS, Number(u.free_cents) + days * FREE_DAILY_CENTS)
  // <=> vergleicht NULL-sicher; schlägt fehl, falls parallel bereits akkumuliert wurde.
  await pool.execute(
    'UPDATE users SET free_cents = ?, free_accrued_on = CURDATE() WHERE id = ? AND free_accrued_on <=> ?',
    [next, userId, u.free_accrued_on]
  )
}

/** Aktuelles Guthaben (schreibt vorher fälliges Freiguthaben gut). */
export async function getBalance(userId: number): Promise<Balance> {
  await accrueFreeCreditLazy(userId)
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT balance_cents, free_cents FROM users WHERE id = ?',
    [userId]
  )
  const u = rows[0]
  return toBalance(Number(u?.balance_cents ?? 0), Number(u?.free_cents ?? 0))
}

export type SubscriptionInfo = { activeUntil: Date | null; active: boolean }

/** Status der Analyse-Flatrate (aktiv, solange subscription_active_until in der Zukunft liegt). */
export async function getSubscription(userId: number): Promise<SubscriptionInfo> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT subscription_active_until,
            (subscription_active_until IS NOT NULL AND subscription_active_until > NOW()) AS active
       FROM users WHERE id = ?`,
    [userId]
  )
  const u = rows[0]
  return {
    activeUntil: u?.subscription_active_until ? new Date(u.subscription_active_until) : null,
    active: !!(u && Number(u.active) === 1),
  }
}

/** Schnellprüfung: hat der Nutzer eine aktive Analyse-Flatrate? */
export async function hasActiveSubscription(userId: number): Promise<boolean> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT (subscription_active_until IS NOT NULL AND subscription_active_until > NOW()) AS active
       FROM users WHERE id = ?`,
    [userId]
  )
  return !!(rows[0] && Number(rows[0].active) === 1)
}

/**
 * Bucht die Analyse-Flatrate für SUBSCRIPTION_DAYS Tage, bezahlt aus dem bezahlten Guthaben.
 * Verlängert eine noch laufende Flatrate (ab deren Ende), sonst ab jetzt. Wirft
 * InsufficientFundsError, wenn das Guthaben nicht reicht. Gibt das neue Ablaufdatum zurück.
 */
export async function subscribeMonth(userId: number): Promise<Date> {
  const price = SUBSCRIPTION_CENTS
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT balance_cents FROM users WHERE id = ? FOR UPDATE',
      [userId]
    )
    const u = rows[0]
    if (!u) throw new Error('Benutzer nicht gefunden')
    if (Number(u.balance_cents) < price) throw new InsufficientFundsError()

    await conn.execute(
      `UPDATE users
          SET balance_cents = balance_cents - ?,
              subscription_active_until =
                DATE_ADD(GREATEST(COALESCE(subscription_active_until, NOW()), NOW()), INTERVAL ? DAY)
        WHERE id = ?`,
      [price, SUBSCRIPTION_DAYS, userId]
    )
    await conn.execute(
      `INSERT INTO account_transactions (user_id, type, amount_cents, description)
       VALUES (?, 'subscription', ?, ?)`,
      [userId, -price, `Analyse-Flatrate (${SUBSCRIPTION_DAYS} Tage)`]
    )
    const [after] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT subscription_active_until FROM users WHERE id = ?',
      [userId]
    )
    await conn.commit()
    return new Date(after[0].subscription_active_until)
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Belastet den Preis einer Analyse: erst Freiguthaben, dann bezahltes Guthaben.
 * Wirft InsufficientFundsError, wenn beides zusammen nicht reicht.
 */
export async function chargeAnalysis(userId: number, imageId: number): Promise<Balance> {
  const price = ANALYSIS_PRICE_CENTS
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await accrueFreeCreditTx(conn, userId)
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT free_cents, balance_cents FROM users WHERE id = ? FOR UPDATE',
      [userId]
    )
    const u = rows[0]
    if (!u) throw new Error('Benutzer nicht gefunden')
    const free = Number(u.free_cents)
    const balance = Number(u.balance_cents)
    if (free + balance < price) throw new InsufficientFundsError()

    const fromFree = Math.min(free, price)
    const fromPaid = price - fromFree
    await conn.execute(
      'UPDATE users SET free_cents = free_cents - ?, balance_cents = balance_cents - ? WHERE id = ?',
      [fromFree, fromPaid, userId]
    )
    await conn.execute(
      `INSERT INTO account_transactions (user_id, type, amount_cents, free_used_cents, image_id, description)
       VALUES (?, 'analysis_charge', ?, ?, ?, 'KI-Foto-Analyse')`,
      [userId, -fromPaid, fromFree, imageId]
    )
    await conn.commit()
    return toBalance(balance - fromPaid, free - fromFree)
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/**
 * Automatische Storno-Gutschrift, wenn eine Analyse technisch fehlschlägt. Stellt den
 * ursprünglichen Free-/Paid-Anteil wieder her (Freiguthaben nur bis zur Obergrenze).
 * Idempotent je Bild: erstattet nur, wenn es eine noch nicht erstattete Belastung gibt.
 */
export async function refundAnalysis(userId: number, imageId: number): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [charges] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM account_transactions
        WHERE user_id = ? AND image_id = ? AND type = 'analysis_charge'`,
      [userId, imageId]
    )
    const [refunds] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM account_transactions
        WHERE user_id = ? AND image_id = ? AND type = 'refund'`,
      [userId, imageId]
    )
    if (Number(refunds[0].c) >= Number(charges[0].c)) {
      await conn.commit()
      return // nichts (mehr) zu erstatten
    }
    const [last] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT amount_cents, free_used_cents FROM account_transactions
        WHERE user_id = ? AND image_id = ? AND type = 'analysis_charge'
        ORDER BY id DESC LIMIT 1`,
      [userId, imageId]
    )
    const charge = last[0]
    if (!charge) {
      await conn.commit()
      return
    }
    const paidUsed = Math.max(0, -Number(charge.amount_cents))
    const freeUsed = Math.max(0, Number(charge.free_used_cents))

    const [uRows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT free_cents FROM users WHERE id = ? FOR UPDATE',
      [userId]
    )
    const freeNow = Number(uRows[0]?.free_cents ?? 0)
    const freeBack = Math.max(0, Math.min(freeUsed, FREE_CAP_CENTS - freeNow))

    await conn.execute(
      'UPDATE users SET free_cents = free_cents + ?, balance_cents = balance_cents + ? WHERE id = ?',
      [freeBack, paidUsed, userId]
    )
    await conn.execute(
      `INSERT INTO account_transactions (user_id, type, amount_cents, free_used_cents, image_id, description)
       VALUES (?, 'refund', ?, ?, ?, 'Analyse fehlgeschlagen – Erstattung')`,
      [userId, paidUsed, -freeBack, imageId]
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Daten einer soeben gutgeschriebenen Einzahlung – Grundlage für die Rechnungs-E-Mail. */
export type DepositConfirmation = {
  userId: number
  amountCents: number
  method: string
  reference: string
  paymentReference: string
  invoiceNumber: string
}

/**
 * Admin bestätigt eine Einzahlung: schreibt den Betrag dem bezahlten Guthaben gut, hält die
 * vom Admin angegebene Zahlungsreferenz fest und vergibt eine Rechnungsnummer. Gibt die
 * Rechnungsdaten zurück, wenn jetzt gutgeschrieben wurde – sonst null (nicht gefunden oder
 * bereits bestätigt/storniert), damit keine doppelte Rechnung verschickt wird.
 */
export async function confirmDeposit(
  depositId: number,
  adminEmail: string,
  paymentReference: string
): Promise<DepositConfirmation | null> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id, user_id, amount_cents, method, reference, status FROM deposit_orders WHERE id = ? FOR UPDATE',
      [depositId]
    )
    const order = rows[0]
    if (!order || order.status !== 'pending') {
      await conn.commit() // idempotent: bereits bestätigt/storniert
      return null
    }
    const invoiceNumber = `RE-${new Date().getFullYear()}-${String(depositId).padStart(5, '0')}`
    await conn.execute(
      `UPDATE deposit_orders
          SET status = 'confirmed', confirmed_by = ?, confirmed_at = NOW(),
              payment_reference = ?, invoice_number = ?
        WHERE id = ?`,
      [adminEmail, paymentReference || null, invoiceNumber, depositId]
    )
    await conn.execute('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [
      order.amount_cents,
      order.user_id,
    ])
    await conn.execute(
      `INSERT INTO account_transactions (user_id, type, amount_cents, deposit_id, description)
       VALUES (?, 'topup', ?, ?, ?)`,
      [
        order.user_id,
        order.amount_cents,
        depositId,
        `Einzahlung bestätigt (${order.method}) – Rechnung ${invoiceNumber}`,
      ]
    )
    await conn.commit()
    return {
      userId: order.user_id,
      amountCents: order.amount_cents,
      method: order.method,
      reference: order.reference,
      paymentReference: paymentReference || '',
      invoiceNumber,
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

/** Admin storniert eine offene Einzahlung (keine Geldbewegung). */
export async function cancelDeposit(depositId: number, adminEmail: string): Promise<void> {
  await pool.execute(
    "UPDATE deposit_orders SET status = 'cancelled', confirmed_by = ?, confirmed_at = NOW() WHERE id = ? AND status = 'pending'",
    [adminEmail, depositId]
  )
}

/**
 * Admin entscheidet über einen nutzerinitiierten Erstattungsantrag. Genehmigung schreibt
 * die ursprünglichen Job-Kosten dem BEZAHLTEN Guthaben gut (Goodwill, unabhängig vom
 * damaligen Free/Paid-Split). Transaktional, idempotent (nur solange 'pending'). Wurde der
 * Job bereits automatisch erstattet, wird der Antrag ohne erneute Gutschrift abgelehnt.
 */
export async function decideRefundRequest(
  requestId: number,
  approve: boolean,
  adminEmail: string,
  note?: string
): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT id, user_id, transaction_id, image_id, status FROM refund_requests WHERE id = ? FOR UPDATE',
      [requestId]
    )
    const req = rows[0]
    if (!req || req.status !== 'pending') {
      await conn.commit() // idempotent
      return
    }

    if (!approve) {
      await conn.execute(
        "UPDATE refund_requests SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?",
        [adminEmail, note || null, requestId]
      )
      await conn.commit()
      return
    }

    // Schutz gegen Doppel-Erstattung (z.B. wenn der Job bereits automatisch erstattet wurde).
    let alreadyRefunded = false
    if (req.image_id != null) {
      const [dup] = await conn.execute<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS c FROM account_transactions WHERE type = 'refund' AND image_id = ?",
        [req.image_id]
      )
      alreadyRefunded = Number(dup[0].c) > 0
    }
    if (alreadyRefunded) {
      await conn.execute(
        "UPDATE refund_requests SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?",
        [adminEmail, 'Bereits erstattet', requestId]
      )
      await conn.commit()
      return
    }

    // Ursprüngliche Job-Kosten aus der Belastung ableiten (robust bei Preisänderungen).
    const [chRows] = await conn.execute<mysql.RowDataPacket[]>(
      "SELECT amount_cents, free_used_cents FROM account_transactions WHERE id = ? AND user_id = ? AND type = 'analysis_charge'",
      [req.transaction_id, req.user_id]
    )
    const charge = chRows[0]
    const originalCost = charge
      ? Math.max(0, -Number(charge.amount_cents)) + Math.max(0, Number(charge.free_used_cents))
      : ANALYSIS_PRICE_CENTS

    await conn.execute('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [
      originalCost,
      req.user_id,
    ])
    await conn.execute(
      `INSERT INTO account_transactions (user_id, type, amount_cents, free_used_cents, image_id, description)
       VALUES (?, 'refund', ?, 0, ?, ?)`,
      [req.user_id, originalCost, req.image_id ?? null, `Erstattung genehmigt (Antrag #${requestId})`]
    )
    await conn.execute(
      "UPDATE refund_requests SET status = 'approved', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?",
      [adminEmail, note || null, requestId]
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}
