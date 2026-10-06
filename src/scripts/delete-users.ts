// Einmal-/Wartungsskript: Benutzerkonten vollständig löschen.
// Aufruf: npx tsx src/scripts/delete-users.ts <id> [<id> ...]
import { deleteUser } from '../services/userDelete'
import { pool } from '../db/connection'

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n) && n > 0)
  for (const id of ids) {
    try {
      const { email } = await deleteUser(id)
      console.log(`gelöscht: ${id} ${email}`)
    } catch (err) {
      console.error(`FEHLER bei ${id}: ${(err as Error).message}`)
    }
  }
  await pool.end()
}
main()
