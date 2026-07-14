-- Antworten des Ordnungsamts: das Versand-Postfach (MAIL_FROM) wird per IMAP
-- abgefragt; eingehende Mails werden über die Message-ID der versendeten
-- Anzeige (In-Reply-To/References) bzw. das Aktenzeichen im Betreff zugeordnet
-- und dem Nutzer auf der Detailseite angezeigt.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS sent_message_id VARCHAR(255) NULL;

CREATE INDEX IF NOT EXISTS idx_reports_sent_message_id ON reports(sent_message_id);

-- report_id NULL = (noch) keiner Anzeige zugeordnet -> Admin-Liste.
-- message_id UNIQUE dedupliziert nach einem Crash zwischen Speichern und
-- Als-gelesen-Markieren im Postfach.
CREATE TABLE IF NOT EXISTS report_replies (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  report_id     INT NULL,
  message_id    VARCHAR(255) NOT NULL UNIQUE,
  from_address  VARCHAR(255) NULL,
  subject       VARCHAR(500) NULL,
  body_text     MEDIUMTEXT NULL,
  received_at   DATETIME NULL,
  read_at       DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_report_replies_report ON report_replies(report_id);

CREATE TABLE IF NOT EXISTS report_reply_attachments (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  reply_id          INT NOT NULL,
  filename          VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NULL,
  mimetype          VARCHAR(100) NULL,
  size_bytes        INT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reply_id) REFERENCES report_replies(id) ON DELETE CASCADE
);
