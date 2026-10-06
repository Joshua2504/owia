/** Tippfehler dürfen in Produktion nicht unbemerkt den Mailpit-Fallback wählen. */
export function assertProductionMailConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  if (env.MAIL_DRIVER !== 'smtp' || !env.MAIL_HOST?.trim() || !env.MAIL_FROM?.trim()) {
    throw new Error('Produktion benötigt MAIL_DRIVER=smtp sowie MAIL_HOST und MAIL_FROM.')
  }
}
