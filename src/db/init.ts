import { pool } from './connection'

/**
 * Idempotente Migrationen, die bei jedem Start laufen.
 * Nötig, weil schema.sql nur beim ersten Anlegen des DB-Volumes ausgeführt wird.
 */
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      email       VARCHAR(255) NOT NULL,
      code        VARCHAR(6) NOT NULL,
      token       VARCHAR(64) NOT NULL UNIQUE,
      attempts    INT NOT NULL DEFAULT 0,
      expires_at  DATETIME NOT NULL,
      used_at     DATETIME NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens(email)'
  )

  // Passwortlose Anmeldung: das alte Passwort-Feld wird nicht mehr gebraucht.
  await pool.query('ALTER TABLE users DROP COLUMN IF EXISTS password_hash')

  // Zeitpunkt der Zustimmung zur Datenschutzerklärung (Nachweis nach Art. 7 DSGVO).
  await pool.query(
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS datenschutz_akzeptiert_at DATETIME NULL'
  )

  // Entwurfs-Workflow: Anzeigen starten als Entwurf und werden später versendet.
  await pool.query(
    "ALTER TABLE reports MODIFY status ENUM('entwurf','eingereicht','versendet') NOT NULL DEFAULT 'entwurf'"
  )
  // Art des Versands (selbst gedruckt/Post, selbst per E-Mail, von uns versendet).
  await pool.query(
    'ALTER TABLE reports ADD COLUMN IF NOT EXISTS versand_art VARCHAR(20) NULL'
  )

  // Tatzeit als Zeitspanne (Datum + von/bis) statt einzelnem Zeitstempel.
  await pool.query('ALTER TABLE reports ADD COLUMN IF NOT EXISTS tattag DATE')
  await pool.query('ALTER TABLE reports ADD COLUMN IF NOT EXISTS tatzeit_von TIME')
  await pool.query('ALTER TABLE reports ADD COLUMN IF NOT EXISTS tatzeit_bis TIME')
  await pool.query('ALTER TABLE reports DROP COLUMN IF EXISTS tatzeit')

  // Wurde durch den Verstoß jemand behindert? (1=ja, 0=nein, NULL=keine Angabe)
  await pool.query('ALTER TABLE reports ADD COLUMN IF NOT EXISTS behinderung TINYINT(1) NULL')
  await pool.query('ALTER TABLE reports ADD COLUMN IF NOT EXISTS behinderung_text TEXT')

  // Hochgeladene Bilder zu einer Anzeige.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_images (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      report_id         INT NOT NULL,
      filename          VARCHAR(255) NOT NULL,
      mimetype          VARCHAR(100) NOT NULL,
      original_filename VARCHAR(255) NOT NULL,
      original_mimetype VARCHAR(100) NOT NULL,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
    )
  `)
  // Falls die Tabelle aus einer früheren Version ohne Original-Spalten stammt:
  await pool.query(
    "ALTER TABLE report_images ADD COLUMN IF NOT EXISTS original_filename VARCHAR(255) NOT NULL DEFAULT ''"
  )
  await pool.query(
    "ALTER TABLE report_images ADD COLUMN IF NOT EXISTS original_mimetype VARCHAR(100) NOT NULL DEFAULT ''"
  )
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_report_images_report ON report_images(report_id)'
  )
}
