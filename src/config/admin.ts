// Admin-Zugänge: kommagetrennte E-Mail-Liste in ADMIN_EMAILS. Admins sehen
// /admin/anzeigen und geben eingereichte Anzeigen frei (Versand ans Ordnungsamt).

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

export function isAdminEmail(email: string | undefined): boolean {
  return !!email && adminEmails().includes(email.toLowerCase())
}
