-- QR-Sticker: Nutzer drucken Bögen mit Einmal-Codes selbst (sticker_batches),
-- verknüpfen einen Code nach dem Erstellen der Anzeige mit ihr und kleben ihn
-- ans Fahrzeug. /S/<code> zeigt dann die öffentlichen (anonymen) Angaben.
-- Ein Code gehört fest dem Nutzer, der ihn erzeugt hat – nur er kann ihn
-- verknüpfen. Neue Bögen gibt es erst, wenn kein Code mehr offen ist
-- (offen = weder verknüpft noch entwertet), siehe services/stickers.ts.
CREATE TABLE IF NOT EXISTS sticker_batches (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  seiten      INT NOT NULL,
  -- Bogenvorlage + Druckversatz als JSON (StickerLayout), damit ein erneuter
  -- Download exakt dieselben Bögen liefert.
  layout      TEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sticker_batches_user ON sticker_batches(user_id);

CREATE TABLE IF NOT EXISTS sticker_codes (
  code          CHAR(8) NOT NULL PRIMARY KEY,   -- Crockford-Base32, Großbuchstaben
  batch_id      INT NOT NULL,
  position      INT NOT NULL,                   -- Reihenfolge auf den Bögen (0-basiert)
  user_id       INT NOT NULL,
  report_id     INT NULL,
  linked_at     DATETIME NULL,                  -- bleibt gesetzt, auch wenn die Anzeige später gelöscht wird
  voided_at     DATETIME NULL,
  scan_count    INT NOT NULL DEFAULT 0,         -- Aufrufe durch andere als den Besitzer
  last_scan_at  DATETIME NULL,
  FOREIGN KEY (batch_id) REFERENCES sticker_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_codes_user ON sticker_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_sticker_codes_report ON sticker_codes(report_id);
CREATE INDEX IF NOT EXISTS idx_sticker_codes_batch ON sticker_codes(batch_id, position);
