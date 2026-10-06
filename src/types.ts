import '@fastify/session'

declare module '@fastify/session' {
  interface FastifySessionObject {
    userId?: number
    userEmail?: string
    userName?: string
    /** Sortierung der Anzeigen-Liste (routes/dashboard.ts), z.B. { key: 'ts', dir: 'desc' } */
    reportSort?: { key: string; dir: 'asc' | 'desc' }
  }
}
