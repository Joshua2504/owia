-- Nutzerinitiierte Erstattungsanträge für einen bezahlten Job (KI-Analyse). Der Nutzer
-- nennt einen Grund und kann optional Screenshots beifügen. Ein Admin genehmigt (Gutschrift
-- über das Hauptbuch) oder lehnt ab. Getrennt von der automatischen Storno-Gutschrift bei
-- technischem Analyse-Fehler.

CREATE TABLE IF NOT EXISTS refund_requests (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NOT NULL,
  transaction_id INT NOT NULL,           -- die erstattete analysis_charge (= „Job")
  image_id       INT NULL,               -- Kontext (analysiertes Bild), falls noch vorhanden
  reason         TEXT NOT NULL,
  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  decided_by     VARCHAR(255) NULL,
  decided_at     DATETIME NULL,
  decision_note  VARCHAR(255) NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id) REFERENCES account_transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refund_req_user   ON refund_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_refund_req_status ON refund_requests(status);
-- Nur ein Antrag je Job.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_req_tx ON refund_requests(transaction_id);

-- Beigefügte Screenshots; Dateien liegen unter data/refunds/{userId}/{requestId}/
CREATE TABLE IF NOT EXISTS refund_request_images (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  request_id        INT NOT NULL,
  filename          VARCHAR(255) NOT NULL,
  mimetype          VARCHAR(100) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  original_mimetype VARCHAR(100) NOT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES refund_requests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refund_req_img ON refund_request_images(request_id);
