import { FastifyRequest, FastifyReply } from 'fastify'

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.session.userId) {
    return reply.redirect('/login')
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
    flash,
    ...extra,
  }
}
