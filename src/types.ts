import '@fastify/session'

declare module '@fastify/session' {
  interface FastifySessionObject {
    userId?: number
    userEmail?: string
    userName?: string
  }
}
