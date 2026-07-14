import { FastifyRequest, FastifyReply } from 'fastify'
import { isAdminEmail } from '../config/admin'

// Flash-Meldungen laufen über ein kurzlebiges Cookie statt über die Session:
// parallele Requests (Bilder, PDF-iframe, Karten-Tiles) können sonst eine
// veraltete Session-Kopie zurückschreiben und eine bereits angezeigte Meldung
// "wiederbeleben" – sie erschien dann bei jedem Seitenaufruf erneut. Das
// Cookie wird beim Rendern der nächsten HTML-Seite gelöscht (Hook in server.ts).
export type Flash = { type: 'success' | 'error'; message: string }

export function setFlash(reply: FastifyReply, type: Flash['type'], message: string): void {
  reply.setCookie('flash', Buffer.from(JSON.stringify({ type, message })).toString('base64url'), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60,
  })
}

export function readFlash(request: FastifyRequest): Flash | null {
  const raw = (request.cookies as Record<string, string | undefined>)?.flash
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    return parsed && parsed.message ? (parsed as Flash) : null
  } catch {
    return null
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.session.userId) {
    return reply.redirect('/login')
  }
}

/** Wie requireAuth, verlangt zusätzlich Admin-Rechte (ADMIN_EMAILS). */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!request.session.userId) {
    return reply.redirect('/login')
  }
  if (!isAdminEmail(request.session.userEmail)) {
    return reply.status(403).send('Kein Zugriff – diese Seite ist Administratoren vorbehalten.')
  }
}

export function viewData(
  request: FastifyRequest,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const flash = readFlash(request)
  return {
    currentUser: request.session.userId
      ? {
          id: request.session.userId,
          email: request.session.userEmail,
          name: request.session.userName,
        }
      : null,
    isAdmin: isAdminEmail(request.session.userEmail),
    flash,
    ...extra,
  }
}
