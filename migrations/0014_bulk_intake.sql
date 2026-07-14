-- Sammel-Import ("Foto-Import"): Nutzer lädt viele Fotos auf einmal hoch, der
-- Server liest EXIF (GPS + Aufnahmezeit), gruppiert die Fotos zu Vorfällen und
-- erzeugt daraus automatisch Entwürfe. captured_at ist Wanduhrzeit der Aufnahme
-- (EXIF hat keine Zeitzone), nie durch eine Zeitzonen-Umrechnung gedreht.

ALTER TABLE report_images ADD COLUMN IF NOT EXISTS captured_at DATETIME     NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS gps_lat     DECIMAL(9,6) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS gps_lon     DECIMAL(9,6) NULL;

-- Ein Batch pro Massen-Upload. Status: open (Upload läuft) -> grouping
-- (Finish beansprucht) -> done (Entwürfe erzeugt).
CREATE TABLE IF NOT EXISTS intake_batches (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  grouped_at DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Hochgeladene Fotos eines Batches vor der Zuordnung zu Entwürfen.
-- report_id bleibt NULL, solange das Foto keinem Entwurf zugeordnet ist
-- (Gruppierung ohne EXIF-Signal nicht möglich -> manuelle Zuordnung).
CREATE TABLE IF NOT EXISTS intake_photos (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  batch_id          INT NOT NULL,
  filename          VARCHAR(255) NOT NULL,
  mimetype          VARCHAR(100) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  original_mimetype VARCHAR(100) NOT NULL,
  upload_name       VARCHAR(255) NULL,
  captured_at       DATETIME NULL,
  gps_lat           DECIMAL(9,6) NULL,
  gps_lon           DECIMAL(9,6) NULL,
  report_id         INT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES intake_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_intake_photos_batch ON intake_photos(batch_id);

-- Herkunfts-Batch eines automatisch erzeugten Entwurfs (für die Review-Queue).
ALTER TABLE reports ADD COLUMN IF NOT EXISTS intake_batch_id INT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_intake_batch ON reports(intake_batch_id);
