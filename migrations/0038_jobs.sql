-- Hintergrund-Jobs (services/jobs.ts): langsame Serverarbeit (Foto-Import
-- gruppieren, PDF erzeugen, Mails, Versand) läuft nicht mehr im Request.
-- Durable, damit ein Neustart keine Arbeit verliert.
-- pending_key: gesetzt nur solange der Job wartet – UNIQUE verhindert doppelte
-- wartende Jobs (z.B. fünfmal „PDF neu" für dieselbe Anzeige).
CREATE TABLE IF NOT EXISTS jobs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  type         VARCHAR(64) NOT NULL,
  payload      TEXT NOT NULL,
  status       ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
  pending_key  VARCHAR(191) NULL,
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_after    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at   DATETIME NULL,
  finished_at  DATETIME NULL,
  error        TEXT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jobs_pending_key (pending_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run ON jobs(status, run_after);
