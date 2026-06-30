import fs from 'fs/promises'
import path from 'path'
import mysql from 'mysql2/promise'
import { pool } from './connection'

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations')

/** Naiver Splitter: Statements per ';' trennen, Zeilenkommentare entfernen.
 *  Reicht für unsere DDL/DML-Migrationen (keine ';' in String-Literalen). */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Wendet alle noch nicht ausgeführten .sql-Dateien aus dem migrations/-Verzeichnis
 * in alphabetischer Reihenfolge an und merkt sie sich in schema_migrations.
 * Migrationen müssen idempotent sein (IF [NOT] EXISTS), damit ein erneuter Lauf
 * bzw. ein frisches schema.sql nicht kollidiert.
 */
export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)

  let files: string[]
  try {
    files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return // kein migrations-Verzeichnis vorhanden
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT filename FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.filename as string))

  for (const file of files) {
    if (applied.has(file)) continue

    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
    const statements = splitStatements(sql)

    const conn = await pool.getConnection()
    try {
      for (const stmt of statements) await conn.query(stmt)
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file])
      console.log(`Migration angewandt: ${file}`)
    } finally {
      conn.release()
    }
  }
}
