import { FastifyInstance, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { viewData } from '../middleware/auth'
import { MailService } from '../services/mail'

const CODE_TTL_MINUTES = 15
const MAX_ATTEMPTS = 5
// „Angemeldet bleiben": Cookie-Lebensdauer, sonst gilt der Default aus server.ts.
const REMEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function baseUrl(request: FastifyRequest): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '')
  return `${request.protocol}://${request.headers.host}`
}

/** Findet den Nutzer (oder legt ihn an) und meldet die Session an. */
async function loginUserByEmail(
  request: FastifyRequest,
  email: string,
  remember = false
): Promise<void> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id, email, vorname, nachname FROM users WHERE email = ?',
    [email]
  )
  let user = rows[0]

  if (!user) {
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      'INSERT INTO users (email) VALUES (?)',
      [email]
    )
    const [created] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, email, vorname, nachname FROM users WHERE id = ?',
      [result.insertId]
    )
    user = created[0]
  }

  // Zustimmung zur Datenschutzerklärung dokumentieren. Der Login-Abschluss ist
  // nur über das checkbox-pflichtige POST /login erreichbar, daher ist die
  // Zustimmung an dieser Stelle stets erteilt (Nachweis nach Art. 7 DSGVO).
  await pool.execute(
    'UPDATE users SET datenschutz_akzeptiert_at = NOW() WHERE id = ?',
    [user.id]
  )

  request.session.userId = user.id
  request.session.userEmail = user.email
  request.session.userName =
    [user.vorname, user.nachname].filter(Boolean).join(' ') || user.email
  // „Angemeldet bleiben": Cookie (und damit DB-Session) auf 30 Tage verlängern.
  if (remember) {
    request.session.cookie.maxAge = REMEMBER_MAX_AGE_MS
    request.session.cookie.expires = new Date(Date.now() + REMEMBER_MAX_AGE_MS)
  }
  await request.session.save()
}

export default async function authRoutes(app: FastifyInstance) {
  // Schritt 1: E-Mail-Adresse eingeben
  app.get('/login', async (request, reply) => {
    if (request.session.userId) return reply.redirect('/anzeigen')
    return reply.view('/auth/login.ejs', viewData(request, { title: 'Anmelden' }))
  })

  app.post('/login', async (request, reply) => {
    const { email, datenschutz, remember } = request.body as {
      email?: string
      datenschutz?: string
      remember?: string
    }
    const rememberFlag = remember ? 1 : 0

    if (!email || !isValidEmail(email)) {
      return reply.view('/auth/login.ejs', viewData(request, {
        title: 'Anmelden',
        error: 'Bitte gib eine gültige E-Mail-Adresse ein.',
        email,
        remember: rememberFlag,
      }))
    }

    if (!datenschutz) {
      return reply.view('/auth/login.ejs', viewData(request, {
        title: 'Anmelden',
        error: 'Bitte stimme der Datenschutzerklärung zu.',
        email,
        remember: rememberFlag,
      }))
    }

    const normalizedEmail = normalizeEmail(email)
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const token = crypto.randomBytes(32).toString('hex')

    // Alte, noch offene Codes für diese Adresse entwerten
    await pool.execute(
      'UPDATE login_tokens SET used_at = NOW() WHERE email = ? AND used_at IS NULL',
      [normalizedEmail]
    )

    await pool.execute(
      `INSERT INTO login_tokens (email, code, token, remember, expires_at)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [normalizedEmail, code, token, rememberFlag, CODE_TTL_MINUTES]
    )

    const magicLink = `${baseUrl(request)}/login/link/${token}`
    try {
      await MailService.sendLoginCode(normalizedEmail, code, magicLink)
    } catch (err) {
      app.log.error(err)
      return reply.view('/auth/login.ejs', viewData(request, {
        title: 'Anmelden',
        error: 'E-Mail konnte nicht versendet werden. Bitte später erneut versuchen.',
        email,
        remember: rememberFlag,
      }))
    }

    return reply.view('/auth/verify.ejs', viewData(request, {
      title: 'Code eingeben',
      email: normalizedEmail,
    }))
  })

  // Schritt 2: Code eingeben
  app.post('/login/verify', async (request, reply) => {
    const { email, code } = request.body as { email?: string; code?: string }

    if (!email || !code) {
      return reply.redirect('/login')
    }
    const normalizedEmail = normalizeEmail(email)

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM login_tokens
       WHERE email = ? AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedEmail]
    )
    const tokenRow = rows[0]

    const renderError = (message: string) =>
      reply.view('/auth/verify.ejs', viewData(request, {
        title: 'Code eingeben',
        email: normalizedEmail,
        error: message,
      }))

    if (!tokenRow || tokenRow.attempts >= MAX_ATTEMPTS) {
      return renderError('Der Code ist abgelaufen. Bitte fordere einen neuen an.')
    }

    if (code.trim() !== tokenRow.code) {
      await pool.execute(
        'UPDATE login_tokens SET attempts = attempts + 1 WHERE id = ?',
        [tokenRow.id]
      )
      return renderError('Der Code ist nicht korrekt.')
    }

    await pool.execute('UPDATE login_tokens SET used_at = NOW() WHERE id = ?', [
      tokenRow.id,
    ])
    await loginUserByEmail(request, normalizedEmail, tokenRow.remember === 1)
    return reply.redirect('/anzeigen')
  })

  // Alternative: Anmeldung direkt über den Link in der E-Mail
  app.get('/login/link/:token', async (request, reply) => {
    const { token } = request.params as { token: string }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM login_tokens
       WHERE token = ? AND used_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [token]
    )
    const tokenRow = rows[0]

    if (!tokenRow) {
      return reply.view('/auth/login.ejs', viewData(request, {
        title: 'Anmelden',
        error: 'Der Anmeldelink ist ungültig oder abgelaufen. Bitte erneut anmelden.',
      }))
    }

    await pool.execute('UPDATE login_tokens SET used_at = NOW() WHERE id = ?', [
      tokenRow.id,
    ])
    await loginUserByEmail(request, tokenRow.email, tokenRow.remember === 1)
    return reply.redirect('/anzeigen')
  })

  app.get('/logout', async (request, reply) => {
    await request.session.destroy()
    return reply.redirect('/login')
  })
}
