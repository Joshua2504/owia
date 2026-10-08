// App-Logger für Module ohne Request-/App-Kontext (Services, Hintergrund-
// Arbeit). server.ts setzt beim Boot den Fastify/Pino-Logger ein; bis dahin
// (und in Einmal-Scripts) landet alles auf der Konsole. Ersetzt verstreute
// console.error-Aufrufe, die unstrukturiert und ohne Zeitstempel im Log standen.
import type { FastifyBaseLogger } from 'fastify'

type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
let current: Log = {
  info: (...a: unknown[]) => console.log(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
} as unknown as Log

export function setLogger(log: FastifyBaseLogger): void {
  current = log
}

export const logger: Log = {
  info: (...a: unknown[]) => (current.info as (...x: unknown[]) => void)(...a),
  warn: (...a: unknown[]) => (current.warn as (...x: unknown[]) => void)(...a),
  error: (...a: unknown[]) => (current.error as (...x: unknown[]) => void)(...a),
}
