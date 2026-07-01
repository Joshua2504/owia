// Zentrale Konfiguration + Helfer rund um das Guthaben-Konto. Eigenes Modul (wie
// src/config/verstoss.ts), damit Routen, Views und Services die Werte teilen, ohne
// einen Import-Zyklus Route↔Service zu erzeugen. Alle Beträge in Cent (INT).

/** Preis einer KI-Foto-Analyse (pro Bild). */
export const ANALYSIS_PRICE_CENTS = intFromEnv('ANALYSIS_PRICE_CENTS', 10)
/** Kostenloses Tagesguthaben, das jedem Nutzer pro Tag gutgeschrieben wird. */
export const FREE_DAILY_CENTS = intFromEnv('FREE_DAILY_CENTS', 20)
/** Obergrenze des ansparbaren Freiguthabens (Übertrag vom Vortag inklusive). */
export const FREE_CAP_CENTS = intFromEnv('FREE_CAP_CENTS', 40)
/** Mindestbetrag einer Aufladung. */
export const MIN_TOPUP_CENTS = intFromEnv('MIN_TOPUP_CENTS', 500)

/** Preis der Analyse-Flatrate (pro Laufzeit) und deren Laufzeit in Tagen. */
export const SUBSCRIPTION_CENTS = intFromEnv('SUBSCRIPTION_CENTS', 500)
export const SUBSCRIPTION_DAYS = intFromEnv('SUBSCRIPTION_DAYS', 30)

/** PayPal-Empfänger für Aufladungen. */
export const PAYPAL_ADDRESS = process.env.PAYPAL_ADDRESS || 'pp@treudler.net'

/** Bankverbindung für Aufladungen per Überweisung (aus der Umgebung). */
export const BANK = {
  holder: process.env.BANK_ACCOUNT_HOLDER || '',
  iban: process.env.BANK_IBAN || '',
  bic: process.env.BANK_BIC || '',
  name: process.env.BANK_NAME || '',
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** Admin-Adressen aus ADMIN_EMAILS (kommagetrennt), klein geschrieben. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || 'joshua@treudler.net')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/** Ob die angemeldete E-Mail-Adresse Admin-Rechte hat. */
export function isAdminEmail(email?: string | null): boolean {
  return !!email && adminEmails().includes(email.toLowerCase())
}

/** Cent -> "0,10 €" (deutsche Schreibweise, vorzeichensicher). */
export function formatEuro(cents: number): string {
  const n = Math.round(Number(cents) || 0)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')} €`
}
