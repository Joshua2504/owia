// Altlasten aufräumen: Entwürfe, deren Fotos mehrere Fahrzeuge zeigen (z.B.
// grob gruppierte Importe), in je eine Anzeige pro Fahrzeug aufteilen.
//
// Fahrzeug = Kennzeichen, das auf mindestens ZWEI Fotos des Entwurfs sicher
// erkannt wurde (ab ALPR_MIN_CONFIDENCE). Einzelne Lesungen sind oft Autos im
// Hintergrund und begründen keine eigene Anzeige. Fotos ohne eigenes Fahrzeug
// (Übersichtsbilder, Einzellesungen) bleiben beim Fahrzeug des vorherigen Fotos
// – Fotos derselben Tat werden nacheinander aufgenommen.
//
// Im Entwurf bleibt das Fahrzeug aus dem Kennzeichen-Feld (sonst das des ersten
// Fotos); die anderen wandern über moveImages in neue Entwürfe (Dateien,
// Sortierung, Tatzeit/GPS aus EXIF, Kennzeichen-Vorbefüllung wie beim Drag &
// Drop). Ein automatisch gesetztes Kennzeichen des Ursprungs wird nachgezogen.
//
// Aufruf: npx tsx src/scripts/split-multi-vehicle.ts            (nur Vorschau)
//         npx tsx src/scripts/split-multi-vehicle.ts --apply    (ausführen)
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { ALPR_MIN_CONFIDENCE } from '../services/alpr'
import { moveImages } from '../routes/reports'

const apply = process.argv.includes('--apply')

async function main(): Promise<void> {
  const [reports] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, user_id, aktenzeichen, kennzeichen FROM reports
      WHERE status='entwurf' AND versand_status IS NULL ORDER BY id`
  )
  let split = 0
  let created = 0
  for (const r of reports) {
    const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id, detected_plate, plate_confidence FROM report_images WHERE report_id=? ORDER BY sort_order, id',
      [r.id]
    )
    const plates = imgs.map((i) =>
      i.detected_plate && Number(i.plate_confidence) >= ALPR_MIN_CONFIDENCE ? String(i.detected_plate) : null
    )
    const counts = new Map<string, number>()
    for (const p of plates) if (p) counts.set(p, (counts.get(p) || 0) + 1)
    const vehicles = new Set([...counts].filter(([, n]) => n >= 2).map(([p]) => p))
    if (vehicles.size < 2) continue

    // Zuordnung: eigenes Fahrzeug, sonst das des vorherigen (am Anfang: nächsten) Fotos.
    const assigned: (string | null)[] = plates.map((p) => (p && vehicles.has(p) ? p : null))
    for (let i = 1; i < assigned.length; i++) if (!assigned[i]) assigned[i] = assigned[i - 1]
    for (let i = assigned.length - 2; i >= 0; i--) if (!assigned[i]) assigned[i] = assigned[i + 1]

    const current = (r.kennzeichen || '').trim()
    const keep = vehicles.has(current) ? current : (assigned[0] as string)
    const groups = new Map<string, number[]>()
    imgs.forEach((img, i) => {
      const v = assigned[i] as string
      if (v !== keep) groups.set(v, [...(groups.get(v) || []), Number(img.id)])
    })

    split++
    const desc = [...groups].map(([p, ids]) => `${p} (${ids.length} Fotos)`).join(', ')
    console.log(`${r.aktenzeichen} [${current || 'leer'}]: behält ${keep}; neu: ${desc}`)
    if (!apply) continue

    for (const [plate, ids] of groups) {
      const res = await moveImages(r.user_id, r.aktenzeichen, ids, { newDraft: true })
      if (res.status !== 200) {
        console.log(`  FEHLER bei ${plate}: ${JSON.stringify(res.body)}`)
        continue
      }
      created++
      console.log(`  -> ${res.body.targetAz} (${plate})`)
    }
    // Automatisch gesetztes Kennzeichen (gleich einer Foto-Lesung) auf das
    // verbliebene Fahrzeug ziehen; leer bzw. von Hand eingetragen bleibt.
    const plateSet = new Set(plates.filter(Boolean))
    if (current && current !== keep && plateSet.has(current)) {
      await pool.execute("UPDATE reports SET kennzeichen=? WHERE id=? AND status='entwurf' AND kennzeichen=?", [
        keep,
        r.id,
        r.kennzeichen,
      ])
    } else if (!current) {
      await pool.execute(
        "UPDATE reports SET kennzeichen=? WHERE id=? AND status='entwurf' AND (kennzeichen IS NULL OR kennzeichen='')",
        [keep, r.id]
      )
    }
  }
  console.log(
    apply
      ? `Fertig: ${split} Entwürfe aufgeteilt, ${created} neue Anzeigen.`
      : `Vorschau: ${split} Entwürfe würden aufgeteilt. Ausführen mit --apply.`
  )
  // Hintergrund-PDFs aus moveImages fertig laufen lassen, dann beenden.
  await new Promise((resolve) => setTimeout(resolve, apply ? 60000 : 0))
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
