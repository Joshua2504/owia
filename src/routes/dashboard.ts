import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { requireAuth, viewData } from '../middleware/auth'
import { photoStatColumns, thumbStrips } from './reports/shared'
import { findDuplicateGroups } from '../services/duplicates'
import { versandWartezeiten } from '../services/versandWarte'

// Sortierbare Spalten der Anzeigen-Liste → SQL. Leere Werte stehen in beiden
// Richtungen unten (erster ORDER-BY-Teil, '' = Spalte ist nie leer), danach das eigentliche Kriterium;
// created_at als stabiler Gleichstand-Brecher. Nur diese Schlüssel sind
// erlaubt – die Richtung wird ebenfalls gegen eine feste Liste geprüft.
const SORTS: Record<string, { empty: string; expr: string }> = {
  ts: { empty: 'tattag IS NULL', expr: 'tattag {dir}, tatzeit_von {dir}' },
  az: { empty: '', expr: 'aktenzeichen {dir}' },
  plate: { empty: "COALESCE(kennzeichen, '') = ''", expr: 'kennzeichen {dir}' },
  place: { empty: "COALESCE(tatort, '') = ''", expr: 'tatort {dir}' },
  offense: { empty: "COALESCE(verstoss_art, '') = ''", expr: 'verstoss_art {dir}' },
  status: { empty: '', expr: "(CASE WHEN status = 'entwurf' AND bereit_at IS NULL THEN 1 WHEN status = 'entwurf' THEN 2 WHEN status = 'eingereicht' THEN 3 ELSE 4 END) {dir}" },
  photos: { empty: '', expr: '(SELECT COUNT(*) FROM report_images pc WHERE pc.report_id = reports.id) {dir}' },
}
const DEFAULT_SORT = { key: 'ts', dir: 'desc' as const }

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get('/anzeigen', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.session.userId as number
    // Sortierung per ?sort=…&dir=… (Spaltenköpfe in report-table.ejs); die
    // Wahl bleibt in der Sitzung, damit die Liste beim nächsten Aufruf gleich
    // sortiert ist. Standard: Tatzeit, neueste zuerst.
    const q = request.query as { sort?: string; dir?: string }
    if (q.sort && SORTS[q.sort]) {
      request.session.reportSort = { key: q.sort, dir: q.dir === 'asc' ? 'asc' : 'desc' }
    }
    const sort = request.session.reportSort && SORTS[request.session.reportSort.key]
      ? request.session.reportSort
      : DEFAULT_SORT
    const s = SORTS[sort.key]
    // Achtung: Ein nacktes Literal wie „0" wäre in ORDER BY eine Spaltenposition.
    const orderBy = `${s.empty ? s.empty + ', ' : ''}${s.expr.replace(/\{dir\}/g, sort.dir === 'asc' ? 'ASC' : 'DESC')}, created_at DESC`
    const [reports] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, aktenzeichen, kennzeichen, kennzeichen_land, tattag, tattag_bis, tatzeit_von, tatzeit_bis,
              tatort, tatort_lat, tatort_lon, verstoss_art, status, versand_status, bereit_at, created_at, city,
              fahrzeug_marke, fahrzeug_typ, fahrzeug_modell, fahrzeug_farbe, verstoss_variante,
              beschreibung, fahrzeug_verlassen, behinderung, behinderung_text,
              ${photoStatColumns('reports')},
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = reports.id AND rr.direction = 'in') AS reply_count,
              (SELECT COUNT(*) FROM report_replies rr WHERE rr.report_id = reports.id AND rr.direction = 'in' AND rr.read_at IS NULL) AS unread_reply_count
       FROM reports WHERE user_id = ? AND status <> 'papierkorb' ORDER BY ${orderBy}`,
      [userId]
    )

    // Foto-IDs pro Anzeige für die Thumbnail-Leiste (gemeinsames Tabellen-Partial).
    const imagesByReport = await thumbStrips("r.user_id = ? AND r.status <> 'papierkorb'", [userId], { zeit: true })

    // Eingereichte Anzeigen: Countdown bis zum Versand (report-row.ejs).
    const warte = await versandWartezeiten(reports.filter((r) => r.status === 'eingereicht').map((r) => Number(r.id)))
    for (const r of reports) r.versand_warte = warte.get(Number(r.id)) || null

    const [[trash]] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS c FROM reports WHERE user_id = ? AND status = 'papierkorb'",
      [userId]
    )

    return reply.view('/dashboard/index.ejs', viewData(request, {
      trashCount: Number(trash.c),
      title: 'Meine Anzeigen',
      wide: true, // Tabelle über die volle Breite (layout.ejs)
      sort, // aktive Sortierung für die Spaltenköpfe (report-table.ejs)
      reports,
      imagesByReport,
      duplicateGroups: findDuplicateGroups(reports as any),
      mergeBack: '/anzeigen',
    }))
  })
}
