// Self-hosted Proof-of-Work-Captcha (Altcha-Protokoll, https://altcha.org) für
// die mail-versendenden öffentlichen Formulare (Login-Code, Newsletter) – kein
// externer Dienst, das Widget ist lokal gevendort (public/vendor/altcha.min.js).
// Bewusst ohne npm-Dependency: Challenge/Verify sind wenige Zeilen node:crypto.
//
// Ablauf: GET /captcha liefert eine signierte Challenge; das Widget sucht per
// Brute-Force die Geheimzahl (SHA-256) und legt die Lösung base64-kodiert ins
// Formularfeld "altcha"; verifyCaptcha() prüft Signatur, Hash, Ablauf und
// Einmaligkeit.
import crypto from 'crypto'

// Key nur für die Challenge-Signatur; bei Boot zufällig erzeugt. Ein Neustart
// invalidiert offene Challenges – bei kurzer TTL unkritisch (Widget holt sich
// beim nächsten Absenden eine frische).
const HMAC_KEY = crypto.randomBytes(32).toString('hex')

const CHALLENGE_TTL_MS = 10 * 60 * 1000
// Obergrenze der Geheimzahl = Worst-Case-Rechenaufwand im Browser. 100.000
// löst auch ein älteres Handy in <1 s, kostet einen Bot aber pro Versuch.
const MAX_NUMBER = 100_000

export type CaptchaChallenge = {
  algorithm: 'SHA-256'
  challenge: string
  maxnumber: number
  salt: string
  signature: string
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function hmacHex(input: string): string {
  return crypto.createHmac('sha256', HMAC_KEY).update(input).digest('hex')
}

/** Frische Challenge fürs Widget (Attribut challengeurl). */
export function createChallenge(): CaptchaChallenge {
  const expires = Date.now() + CHALLENGE_TTL_MS
  // Ablauf steckt als Query-Param im Salt und ist damit HMAC-signiert.
  const salt = `${crypto.randomBytes(12).toString('hex')}?expires=${Math.floor(expires / 1000)}`
  const secretNumber = crypto.randomInt(0, MAX_NUMBER)
  const challenge = sha256Hex(salt + secretNumber)
  return {
    algorithm: 'SHA-256',
    challenge,
    maxnumber: MAX_NUMBER,
    salt,
    signature: hmacHex(challenge),
  }
}

// Replay-Schutz: bereits eingelöste Salts bis zu ihrem Ablauf merken (danach
// scheitert die Ablaufprüfung ohnehin). In-Memory reicht – ein Neustart
// invalidiert die Challenges gleich mit.
const usedSalts = new Map<string, number>()

function pruneUsedSalts(): void {
  const now = Date.now()
  for (const [salt, expiry] of usedSalts) {
    if (expiry <= now) usedSalts.delete(salt)
  }
}

/** Gelöste Challenge (base64-JSON aus dem Formularfeld "altcha") prüfen. */
export function verifyCaptcha(payload: unknown): boolean {
  if (typeof payload !== 'string' || !payload || payload.length > 4096) return false
  let data: { algorithm?: string; challenge?: string; number?: number; salt?: string; signature?: string }
  try {
    data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  } catch {
    return false
  }
  if (
    data.algorithm !== 'SHA-256' ||
    typeof data.challenge !== 'string' ||
    typeof data.salt !== 'string' ||
    typeof data.signature !== 'string' ||
    typeof data.number !== 'number' ||
    !Number.isInteger(data.number)
  ) {
    return false
  }

  // Ablauf aus dem (signierten) Salt lesen.
  const expiresParam = /[?&]expires=(\d+)/.exec(data.salt)?.[1]
  const expiresMs = expiresParam ? Number(expiresParam) * 1000 : 0
  if (!expiresMs || expiresMs <= Date.now()) return false

  // Signatur (Challenge stammt wirklich von uns) und Lösung prüfen –
  // timingSafeEqual, auch wenn ein Timing-Angriff hier wenig hergibt.
  const expectedSignature = hmacHex(data.challenge)
  const sigA = Buffer.from(data.signature)
  const sigB = Buffer.from(expectedSignature)
  if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) return false
  if (sha256Hex(data.salt + data.number) !== data.challenge) return false

  // Einmaligkeit: jede Challenge nur ein einziges Mal einlösbar.
  pruneUsedSalts()
  if (usedSalts.has(data.salt)) return false
  usedSalts.set(data.salt, expiresMs)
  return true
}
