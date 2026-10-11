import type { FastifyRequest } from 'fastify'
import crypto from 'crypto'

/**
 * Native Apps (Android/iOS, Capacitor-Hülle unter mobile/). Die Apps laden
 * dieselbe Website in einer WebView und hängen an den User-Agent
 * „OWiA-App/<plattform>“ an (mobile/capacitor.config.ts, appendUserAgent).
 * Daran erkennt der Server die App: layout.ejs setzt dann viewport-fit=cover
 * und die Klasse is-app (Abstände unter Statusleiste/Notch, app.css) und
 * bindet public/js/app-bridge.js ein.
 *
 * Alle Werte kommen aus der Umgebung und sind optional – ohne sie läuft die
 * Website unverändert. Neue Variablen auch in docker-compose.yml (environment)
 * und .env.example eintragen.
 */

const APP_UA_RE = /\bOWiA-App\/(android|ios)\b/i

export type AppPlatform = 'android' | 'ios'

/** Plattform, wenn die Anfrage aus der nativen App kommt, sonst null. */
export function appPlatform(request: FastifyRequest): AppPlatform | null {
  const m = APP_UA_RE.exec(String(request.headers['user-agent'] || ''))
  return m ? (m[1].toLowerCase() as AppPlatform) : null
}

/** Bundle-ID (iOS) bzw. Paketname (Android). Muss zu appId in
 *  mobile/capacitor.config.ts passen. */
export function appId(): string {
  return (process.env.APP_ID || 'net.owia.app').trim()
}

/** Apple-Team-ID (10 Zeichen, developer.apple.com → Membership). Ohne sie
 *  gibt es keine apple-app-site-association und keine Universal Links. */
export function iosTeamId(): string | null {
  const id = (process.env.APP_IOS_TEAM_ID || '').trim()
  return /^[A-Z0-9]{10}$/.test(id) ? id : null
}

/** SHA-256-Fingerprints der Android-Signaturschlüssel (Upload-Key UND der
 *  App-Signing-Key aus der Play Console), kommagetrennt, Format
 *  „AA:BB:…“ (32 Bytes). Ohne sie gibt es kein assetlinks.json. */
export function androidCertFingerprints(): string[] {
  return (process.env.APP_ANDROID_SHA256 || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s))
}

/**
 * Pfade, die als Universal Link / App Link direkt die App öffnen. Der
 * Anmeldelink aus der Login-Mail ist der wichtigste: Ohne ihn landet der Login
 * im System-Browser statt in der App (eigener Cookie-Speicher). Muss zu den
 * intent-filtern in mobile/android/app/src/main/AndroidManifest.xml passen.
 */
export const APP_LINK_PATHS = ['/login/link/*', '/kamera', '/anzeigen', '/anzeige/*', '/S/*']

// ---------------------------------------------------------------------------
// Demo-Konto für die Store-Prüfung. Apple und Google verlangen Zugangsdaten,
// mit denen die Prüfer sich ohne eigenes Postfach anmelden können. Für genau
// diese eine Adresse gilt ein fester Code aus der Umgebung statt eines
// Mail-Codes. Das Konto kann nichts einreichen (submitDraft), es erreicht also
// nie eine Behörde. Nach zu vielen Fehlversuchen ist der feste Code für eine
// Stunde gesperrt (zusätzlich zum Rate-Limit von /login/verify). Zeitlich
// begrenzt, weil der Zähler global ist (nicht je IP): Eine dauerhafte Sperre
// bis zum Neustart könnte jeder mit 20 Falscheingaben auslösen und damit die
// Store-Prüfung blockieren. 20 Versuche/h bei 10^6 Codes bleiben unergiebig.
// ---------------------------------------------------------------------------

const REVIEW_MAX_FAILURES = 20
const REVIEW_FAILURE_WINDOW_MS = 60 * 60 * 1000
// Festes Fenster: beginnt mit der ersten Prüfung nach Ablauf des vorigen, die
// Sperre hält also höchstens REVIEW_FAILURE_WINDOW_MS.
const reviewFailures = { count: 0, fensterStart: 0 }

function reviewFailureCount(now: number): number {
  if (now - reviewFailures.fensterStart >= REVIEW_FAILURE_WINDOW_MS) {
    reviewFailures.count = 0
    reviewFailures.fensterStart = now
  }
  return reviewFailures.count
}

/** Adresse des Demo-Kontos, nur wenn auch ein gültiger Code gesetzt ist. */
export function reviewEmail(): string | null {
  const email = (process.env.APP_REVIEW_EMAIL || '').trim().toLowerCase()
  const code = (process.env.APP_REVIEW_CODE || '').trim()
  // Das Code-Feld in verify.ejs nimmt genau 6 Ziffern.
  if (!email || !/^\d{6}$/.test(code)) return null
  return email
}

export function isReviewAccount(email: string | null | undefined): boolean {
  const review = reviewEmail()
  return !!review && !!email && email.trim().toLowerCase() === review
}

/** Prüft den festen Code des Demo-Kontos (zeitkonstant). */
export function reviewCodeMatches(email: string, code: string): boolean {
  const now = Date.now()
  if (!isReviewAccount(email) || reviewFailureCount(now) >= REVIEW_MAX_FAILURES) return false
  const expected = Buffer.from((process.env.APP_REVIEW_CODE || '').trim())
  const given = Buffer.from(String(code).trim())
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected)
  if (!ok) reviewFailures.count++
  return ok
}
