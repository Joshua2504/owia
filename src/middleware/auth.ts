import { FastifyRequest, FastifyReply } from 'fastify'
import { isAdminEmail } from '../config/credits'

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
  const flash = request.session.flash
  request.session.flash = undefined
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
