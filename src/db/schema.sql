CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  vorname       VARCHAR(100),
  nachname      VARCHAR(100),
  strasse       VARCHAR(255),
  plz           VARCHAR(10),
  ort           VARCHAR(100),
  telefon       VARCHAR(50),
  datenschutz_akzeptiert_at DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  kennzeichen   VARCHAR(20),
  fahrzeug_marke VARCHAR(100),
  tattag        DATE,
  tatzeit_von   TIME,
  tatzeit_bis   TIME,
  tatort        TEXT,
  verstoss_art  VARCHAR(255),
  beschreibung  TEXT,
  behinderung      TINYINT(1) NULL,   -- wurde jemand behindert? 1=ja, 0=nein, NULL=keine Angabe
  behinderung_text TEXT,              -- wer wurde wie behindert
  status        ENUM('entwurf','eingereicht','versendet') NOT NULL DEFAULT 'entwurf',
  versand_art   VARCHAR(20) NULL,
  pdf_filename  VARCHAR(255),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS report_images (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  report_id         INT NOT NULL,
  filename          VARCHAR(255) NOT NULL,   -- nutzbares JPG/PNG (für PDF und Web)
  mimetype          VARCHAR(100) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,    -- wie hochgeladen (z.B. HEIC)
  original_mimetype VARCHAR(100) NOT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reports_user    ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
CREATE INDEX IF NOT EXISTS idx_report_images_report ON report_images(report_id);

-- Einmal-Codes / Magic-Links für die passwortlose Anmeldung per E-Mail
CREATE TABLE IF NOT EXISTS login_tokens (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  code        VARCHAR(6) NOT NULL,
  token       VARCHAR(64) NOT NULL UNIQUE,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens(email);
