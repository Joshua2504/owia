// Daten Dritter (fremde Kennzeichen, Gesichter) auf den Fotos offener Anzeigen
// automatisch schwärzen – Nachholen für den Bestand, Regeln in
// services/dritteSchwaerzen.ts (Gesichter immer; fremde Kennzeichen nur, wenn
// das angezeigte Kennzeichen auf dem Foto erkannt wurde; der Rest bleibt für den
// Foto-Dialog offen). Originale bleiben erhalten.
// Aufruf: npx tsx src/scripts/dritte-schwaerzen.ts [--trocken] [--az OWiA-123456]
import { pool } from '../db/connection'
import { fundeText } from '../services/dritte'
import { offeneFotos, schwaerzeFoto } from '../services/dritteSchwaerzen'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const trocken = args.includes('--trocken')
  const azIdx = args.indexOf('--az')
  const az = azIdx >= 0 ? args[azIdx + 1] : undefined

  const fotos = await offeneFotos(az)
  const z = { geschwaerzt: 0, offen: 0, fehler: 0, boxen: 0 }
  const offenJe = new Map<string, string[]>()
  for (const f of fotos) {
    const r = await schwaerzeFoto(f, { trocken })
    if (r.stand === 'nichts') continue
    const akte = String((f as unknown as { aktenzeichen: string }).aktenzeichen)
    if (r.stand === 'geschwaerzt') {
      z.geschwaerzt++
      z.boxen += r.boxen
      console.log(`${trocken ? '[trocken] ' : ''}${akte} Foto ${f.id}: ${r.boxen} Stelle(n) geschwärzt${r.offen.length ? `, offen: ${fundeText(r.offen)}` : ''}`)
    } else if (r.stand === 'fehler') {
      z.fehler++
      console.log(`${akte} Foto ${f.id}: FEHLER ${r.grund}`)
    }
    if (r.offen.length) {
      z.offen++
      offenJe.set(akte, [...(offenJe.get(akte) || []), `Foto ${f.id}: ${fundeText(r.offen)}`])
    }
  }
  console.log(`\nFertig${trocken ? ' (trocken, nichts geändert)' : ''}: ${fotos.length} Fotos geprüft, ${z.geschwaerzt} geschwärzt (${z.boxen} Stellen), ${z.fehler} Fehler, ${z.offen} Fotos bleiben für den Foto-Dialog offen.`)
  if (offenJe.size) {
    console.log(`\nOffen (${offenJe.size} Anzeigen):`)
    for (const [akte, teile] of offenJe) console.log(`  ${akte}: ${teile.join('; ')}`)
  }
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
