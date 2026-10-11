// Missbrauchsbremsen, die über das Rate-Limit-Plugin hinausgehen: Schlüssel
// für @fastify/rate-limit (IPv6 je /64), Erkennung interner Aufrufer (Docker-
// Healthcheck, deploy.sh, Dev-Routen) und ein Limit je Ziel-E-Mail-Adresse für
// die mail-versendenden Formulare (Login-Code, E-Mail-Wechsel).
import net from 'net'

// ---------------------------------------------------------------------------
// IP-Adressen
// ---------------------------------------------------------------------------

/** 8 Hextets einer IPv6-Adresse (inkl. eingebetteter IPv4 am Ende), sonst null. */
function ipv6Hextets(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null
  let s = ip
  // Eingebettete IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) in zwei Hextets umrechnen.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number)
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const halves = s.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  let parts: string[]
  if (halves.length === 1) {
    parts = head
  } else {
    const tail = halves[1] ? halves[1].split(':') : []
    parts = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
  }
  if (parts.length !== 8) return null
  return parts.map((p) => parseInt(p, 16))
}

/**
 * Kanonische Form der Client-IP: Zonen-Suffix (%eth0) weg, IPv4-mapped IPv6
 * (::ffff:a.b.c.d bzw. ::ffff:7f00:1 – so meldet Node IPv4-Clients auf einem
 * Dual-Stack-Socket) als echte IPv4. Sonst wäre derselbe Client je nach
 * Socket-Art ein anderer Rate-Limit-Schlüssel bzw. nicht als intern erkannt.
 */
function canonicalIp(ip: string | undefined): { v4: string } | { v6: number[] } | null {
  const s = String(ip || '').trim().replace(/%.*$/, '')
  if (net.isIPv4(s)) return { v4: s }
  const h = ipv6Hextets(s)
  if (!h) return null
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return { v4: [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join('.') }
  }
  return { v6: h }
}

/**
 * Schlüssel fürs Rate-Limit: IPv4 unverändert, IPv6 auf das /64-Präfix
 * gekürzt. Ein einzelner IPv6-Anschluss bekommt typischerweise ein ganzes /64
 * (2^64 Adressen) – je Einzeladresse zu zählen hieße, dass ein Angreifer die
 * Login-/Mail-Limits durch bloßes Durchwechseln der Adresse aushebelt.
 */
export function rateLimitKey(ip: string | undefined): string {
  const c = canonicalIp(ip)
  if (!c) return String(ip || 'unbekannt')
  if ('v4' in c) return c.v4
  return c.v6.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64'
}

/**
 * Loopback oder privates Netz (10/8, 172.16/12, 192.168/16, fc00::/7) –
 * dieselben Netze, denen server.ts per trustProxy ('loopback','uniquelocal')
 * vertraut. request.ip ist hinter Caddy bereits die echte Client-IP (Caddy
 * überschreibt X-Forwarded-For, trustProxy wertet es nur von diesen Netzen
 * aus), ein Aufrufer aus dem Internet landet hier also nie als „intern“.
 * Intern sind: Docker-Healthcheck (localhost), deploy.sh (127.0.0.1 → Docker-
 * Bridge), curl auf dem Host.
 */
export function isInternalIp(ip: string | undefined): boolean {
  const c = canonicalIp(ip)
  if (!c) return false
  if ('v4' in c) {
    const [a, b] = c.v4.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const h = c.v6
  const loopback = h.slice(0, 7).every((x) => x === 0) && h[7] === 1
  return loopback || (h[0] & 0xfe00) === 0xfc00
}

// ---------------------------------------------------------------------------
// Limit je Ziel-E-Mail-Adresse
// ---------------------------------------------------------------------------

// Das IP-Limit (5 / 15 min auf POST /login bzw. /einstellungen/email) bremst
// einen einzelnen Absender; wer IPs rotiert (Botnetz, IPv6-Präfixe), könnte
// ein fremdes Postfach trotzdem mit Login-Codes fluten. Daher zusätzlich je
// Zieladresse – gemeinsam für beide Formulare, denn das Opfer ist dasselbe.
const MAIL_TARGET_MAX = 5
const MAIL_TARGET_WINDOW_MS = 60 * 60 * 1000
const mailTargets = new Map<string, number[]>()

/** Zähl-Schlüssel: Kleinschreibung und „+tag“ im Lokalteil entfernt – fast alle
 *  Anbieter stellen user+x@ und user+y@ ins selbe Postfach zu. */
function mailTargetKey(email: string): string {
  const e = email.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at <= 0) return e
  return e.slice(0, at).replace(/\+.*$/, '') + e.slice(at)
}

function pruneMailTargets(now: number): void {
  for (const [key, times] of mailTargets) {
    if (!times.some((t) => now - t < MAIL_TARGET_WINDOW_MS)) mailTargets.delete(key)
  }
}

/**
 * Darf an diese Adresse jetzt eine weitere Mail gehen? Zählt den Versuch
 * gleich mit (true ⇒ Mail versenden). In-Memory genügt: ein Neustart setzt
 * die Zähler zurück, das IP-Limit greift weiterhin. Die Antwort an den Client
 * entscheidet der Aufrufer – beim Login bewusst neutral (keine Konto-
 * Enumeration, das Limit gilt ohnehin für jede Adresse, ob registriert oder nicht).
 */
export function allowMailTo(email: string): boolean {
  const now = Date.now()
  if (mailTargets.size > 5000) pruneMailTargets(now)
  const key = mailTargetKey(email)
  const recent = (mailTargets.get(key) || []).filter((t) => now - t < MAIL_TARGET_WINDOW_MS)
  if (recent.length >= MAIL_TARGET_MAX) {
    mailTargets.set(key, recent)
    return false
  }
  recent.push(now)
  mailTargets.set(key, recent)
  return true
}
