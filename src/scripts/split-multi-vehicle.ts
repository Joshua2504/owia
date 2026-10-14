// Altlasten aufräumen: Entwürfe, deren Fotos mehrere Fahrzeuge zeigen (z.B.
// Importe vor 7d705f1, als die Gruppierung nur Ort/Zeit kannte), in je eine
// Anzeige pro Fahrzeug aufteilen – nach derselben Regel wie der Import
// (splitByVehicle in services/intakeGrouping.ts).
//
// Im Entwurf bleibt das Fahrzeug aus dem Kennzeichen-Feld (sonst das des ersten
// Fotos); die anderen wandern über moveImages in neue Entwürfe (Dateien,
// Sortierung, GPS, Kennzeichen-Vorbefüllung wie beim Drag & Drop). Danach
// bekommen beide Seiten Tattag/Tatzeit aus IHREN Fotos. Einzige Ausnahme: ein
// von Hand verlängertes „bis“ des Ursprungs (keine Fotozeit, später als dessen
// letztes Foto) bleibt stehen. Ein automatisch gesetztes Kennzeichen des
// Ursprungs wird nachgezogen.
//
// Aufruf: npx tsx src/scripts/split-multi-vehicle.ts            (nur Vorschau)
//         npx tsx src/scripts/split-multi-vehicle.ts --apply    (ausführen)
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { ALPR_MIN_CONFIDENCE } from '../services/alpr'
import { splitByVehicle, toIncident, IntakePhoto, Incident } from '../services/intakeGrouping'
import { moveImages } from '../routes/reports'

const apply = process.argv.includes('--apply')

const zeitSpalten = `DATE_FORMAT(tattag, '%Y-%m-%d') AS tattag, DATE_FORMAT(tattag_bis, '%Y-%m-%d') AS tattag_bis,
  TIME_FORMAT(tatzeit_von, '%H:%i:%s') AS tatzeit_von, TIME_FORMAT(tatzeit_bis, '%H:%i:%s') AS tatzeit_bis`

/** Von Hand eingetragenes „bis“, das über die verbleibenden Fotos hinausgeht
 *  (Auto stand nachweislich länger) – nicht aus einer Fotozeit entstanden. */
function bisVonHand(r: mysql.RowDataPacket, alle: IntakePhoto[], rest: Incident): boolean {
  if (!r.tatzeit_bis || r.tattag_bis || rest.dayTo || r.tattag !== rest.day) return false
  if (alle.some((p) => p.capturedAt?.slice(11, 19) === r.tatzeit_bis)) return false
  const letzte = rest.timeTo ?? rest.timeFrom
  return !!letzte && r.tatzeit_bis > letzte
}

async function zeitenSetzen(reportId: number, inc: Incident): Promise<void> {
  await pool.execute(
    "UPDATE reports SET tattag=?, tattag_bis=?, tatzeit_von=?, tatzeit_bis=? WHERE id=? AND status='entwurf'",
    [inc.day, inc.dayTo, inc.timeFrom, inc.timeTo, reportId]
  )
}

async function fotos(reportId: number): Promise<IntakePhoto[]> {
  const [imgs] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s') AS captured_at, gps_lat, gps_lon,
            detected_plate, plate_confidence
       FROM report_images WHERE report_id=? ORDER BY sort_order, id`,
    [reportId]
  )
  return imgs.map((i) => ({
    id: Number(i.id),
    capturedAt: i.captured_at,
    lat: i.gps_lat !== null ? Number(i.gps_lat) : null,
    lon: i.gps_lon !== null ? Number(i.gps_lon) : null,
    plate: i.detected_plate,
    plateConfidence: i.plate_confidence !== null ? Number(i.plate_confidence) : null,
  }))
}

/** Häufigste sichere Lesung einer Fotogruppe (Anzeige-Text). */
function fahrzeug(photos: IntakePhoto[]): string {
  const n = new Map<string, number>()
  for (const p of photos) {
    if (p.plate && (p.plateConfidence ?? 0) >= ALPR_MIN_CONFIDENCE) n.set(p.plate, (n.get(p.plate) || 0) + 1)
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?'
}

async function main(): Promise<void> {
  const [reports] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, user_id, aktenzeichen, kennzeichen, ${zeitSpalten} FROM reports
      WHERE status='entwurf' AND versand_status IS NULL ORDER BY id`
  )
  let split = 0
  let created = 0
  for (const r of reports) {
    const photos = await fotos(r.id)
    const groups = splitByVehicle(photos, ALPR_MIN_CONFIDENCE)
    if (groups.length < 2) continue

    const current = String(r.kennzeichen || '').trim()
    const plates = groups.map(fahrzeug)
    const keepIdx = Math.max(0, plates.indexOf(current))
    const keep = plates[keepIdx]

    split++
    const desc = groups
      .map((g, i) => (i === keepIdx ? null : `${plates[i]} (${g.length} Fotos)`))
      .filter(Boolean)
      .join(', ')
    console.log(`${r.aktenzeichen} [${current || 'leer'}]: behält ${keep} (${groups[keepIdx].length} Fotos); neu: ${desc}`)
    if (!apply) continue

    for (let i = 0; i < groups.length; i++) {
      if (i === keepIdx) continue
      const res = await moveImages(r.user_id, r.aktenzeichen, groups[i].map((p) => p.id), { newDraft: true })
      if (res.status !== 200) {
        console.log(`  FEHLER bei ${plates[i]}: ${JSON.stringify(res.body)}`)
        continue
      }
      created++
      const [neu] = await pool.execute<mysql.RowDataPacket[]>('SELECT id FROM reports WHERE aktenzeichen=?', [String(res.body.targetAz)])
      if (neu[0]) await zeitenSetzen(Number(neu[0].id), toIncident(groups[i]))
      console.log(`  -> ${res.body.targetAz} (${plates[i]})`)
    }
    const rest = await fotos(r.id)
    if (rest.length) {
      const inc = toIncident(rest)
      if (bisVonHand(r, photos, inc)) inc.timeTo = r.tatzeit_bis
      await zeitenSetzen(r.id, inc)
      console.log(`  Zeiten: ${inc.day} ${inc.timeFrom}–${inc.timeTo ?? ''}`)
    }
    // Automatisch gesetztes Kennzeichen (gleich einer Foto-Lesung) auf das
    // verbliebene Fahrzeug ziehen; leer bzw. von Hand eingetragen bleibt.
    const lesungen = new Set(photos.map((p) => p.plate).filter(Boolean))
    if ((current && current !== keep && lesungen.has(current)) || !current) {
      await pool.execute("UPDATE reports SET kennzeichen=? WHERE id=? AND status='entwurf' AND IFNULL(kennzeichen,'')=?", [
        keep,
        r.id,
        current,
      ])
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
