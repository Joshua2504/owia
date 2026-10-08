import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { viewData } from '../middleware/auth'
import { MailService } from '../services/mail'
import { verifyCaptcha } from '../services/captcha'
import { consumeMagicLink, consumeLoginCode } from '../services/loginTokens'

const CODE_TTL_MINUTES = 15
// „Angemeldet bleiben": Cookie-Lebensdauer, sonst gilt der Default aus server.ts.
const REMEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function baseUrl(request: FastifyRequest): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '')
  return `${request.protocol}://${request.headers.host}`
}

// Rücksprung nach dem Login: Wer einen eigenen, noch offenen Sticker mit der
// Handy-Kamera scannt, landet ausgeloggt auf /S/<code> (iOS: die installierte
// PWA hat einen eigenen Cookie-Speicher). Nur Sticker-Pfade sind erlaubt –
// kein Open Redirect. Cookie statt Session, weil der Login die Session neu
// erzeugt (Session-Fixation-Schutz).
const WEITER_RE = /^\/S\/[0-9A-Z]{8}$/

function afterLogin(request: FastifyRequest, reply: FastifyReply): string {
  const weiter = (request.cookies as Record<string, string | undefined>)?.weiter
  if (!weiter) return '/anzeigen'
  reply.clearCookie('weiter', { path: '/' })
  return WEITER_RE.test(weiter) ? weiter : '/anzeigen'
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
  // Nur den ERSTEN Zeitpunkt festhalten – der ursprüngliche Nachweis darf
  // durch spätere Logins nicht überschrieben werden.
  await pool.execute(
    'UPDATE users SET datenschutz_akzeptiert_at = NOW() WHERE id = ? AND datenschutz_akzeptiert_at IS NULL',
    [user.id]
  )

  // Gegen Session-Fixation: vor dem Setzen der Identität eine frische
  // Session-ID erzeugen (eine evtl. vorher untergeschobene ID wird ungültig).
  await request.session.regenerate()

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
    const weiter = String((request.query as { weiter?: string }).weiter || '')
    if (WEITER_RE.test(weiter)) {
      if (request.session.userId) return reply.redirect(weiter)
      // Gültig so lange wie der Login-Code (CODE_TTL_MINUTES) plus Puffer.
      reply.setCookie('weiter', weiter, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30 * 60 })
    }
    if (request.session.userId) return reply.redirect('/anzeigen')
    return reply.view('/auth/login.ejs', viewData(request, { title: 'Anmelden' }))
  })

  // Streng limitiert: jeder Aufruf versendet eine E-Mail (Mail-Bombing-Schutz).
  app.post('/login', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { email, datenschutz, remember, altcha } = request.body as {
      email?: string
      datenschutz?: string
      remember?: string
      altcha?: string
    }
    const rememberFlag = remember ? 1 : 0

    // Proof-of-Work-Captcha (services/captcha.ts): bremst automatisiertes
    // Mail-Bombing/User-Enumeration zusätzlich zum Rate-Limit.
    if (!verifyCaptcha(altcha)) {
      return reply.view('/auth/login.ejs', viewData(request, {
        title: 'Anmelden',
        error: 'Bitte die Sicherheitsprüfung abschließen und erneut absenden.',
        email,
        remember: rememberFlag,
      }))
    }

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

  // Schritt 2: Code eingeben. Eigenes Rate-Limit gegen Brute-Force auf den
  // 6-stelligen Code (großzügiger als MAX_LOGIN_ATTEMPTS, damit Tippfehler nicht
  // doppelt bestraft werden – parallele Fluten aber nicht durchkommen).
  app.post('/login/verify', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { email, code } = request.body as { email?: string; code?: string }

    if (!email || !code) {
      return reply.redirect('/login')
    }
    const normalizedEmail = normalizeEmail(email)

    const result = await consumeLoginCode(normalizedEmail, code)
    if (!result.token) {
      return reply.view('/auth/verify.ejs', viewData(request, {
        title: 'Code eingeben', email: normalizedEmail, error: result.error,
      }))
    }
    const tokenRow = result.token
    await loginUserByEmail(request, normalizedEmail, tokenRow.remember === 1)
    return reply.redirect(afterLogin(request, reply))
  })

  // Alternative: Anmeldung direkt über den Link in der E-Mail. Der GET zeigt
  // nur eine Bestätigungsseite – Mail-Gateways und Link-Vorschauen (Outlook
  // Safe Links, Messenger) rufen Links vorab ab und hätten den Einmal-Token
  // sonst verbraucht, bevor der Nutzer klickt. Erst der POST meldet an.
  app.get('/login/link/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (!/^[0-9a-f]{64}$/.test(token)) {
      return reply.view('/auth/login.ejs', viewData(request, {
        title: 'Anmelden',
        error: 'Der Anmeldelink ist ungültig oder abgelaufen. Bitte erneut anmelden.',
      }))
    }
    if (request.session.userId) return reply.redirect(afterLogin(request, reply))
    return reply.view('/auth/link.ejs', viewData(request, { title: 'Anmelden', token }))
  })

  app.post('/login/link/:token', async (request, reply) => {
    const { token } = request.params as { token: string }

    const tokenRow = await consumeMagicLink(token)

    if (!tokenRow) {
      return reply.view('/auth/login.ejs', viewData(request, {
        title: 'Anmelden',
        error: 'Der Anmeldelink ist ungültig oder abgelaufen. Bitte erneut anmelden.',
      }))
    }

    await loginUserByEmail(request, tokenRow.email, tokenRow.remember === 1)
    return reply.redirect(afterLogin(request, reply))
  })

  // Abmelden nur per POST: Ein GET wäre zustandsändernd und ließe sich von
  // fremden Seiten per <img src> auslösen (sameSite=lax schützt Top-Level-
  // Navigationen nicht). Der alte GET-Pfad landet harmlos auf der Startseite.
  app.post('/logout', async (request, reply) => {
    await request.session.destroy()
    return reply.redirect('/login')
  })
  app.get('/logout', async (_request, reply) => reply.redirect('/'))
}
