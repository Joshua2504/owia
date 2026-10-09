import type { FastifyRequest } from 'fastify'

/**
 * Öffentliche Basis-URL der App ohne abschließenden Slash (für Links in Mails,
 * Canonical/OG-Tags, QR-Codes). In Produktion ist APP_URL Pflicht (server.ts
 * verweigert sonst den Start).
 *
 * Ohne APP_URL: mit Request wird die URL aus Protokoll + Host-Header gebaut
 * (Magic-Link, Sticker-PDF – sonst zeigten die Links in Dev auf den falschen
 * Port), ohne Request (Mails aus Hintergrund-Jobs, Seiten-Meta) greift der
 * feste Dev-Fallback http://localhost:3000.
 */
export function appUrl(request?: FastifyRequest): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '')
  if (request) return `${request.protocol}://${request.headers.host}`
  return 'http://localhost:3000'
}
