-- Eindeutiges, zufälliges Aktenzeichen je Anzeige (z.B. "OWiAA#7K3QF2").
-- Bewusst NICHT aus der laufenden ID ableitbar, damit keine Rückschlüsse auf
-- Anzahl/Reihenfolge möglich sind. Neue Anzeigen erhalten das Aktenzeichen in
-- der App (kryptografisch zufällig); diese Migration rüstet die Spalte nach und
-- vergibt für bestehende Anzeigen rückwirkend ein Aktenzeichen.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS aktenzeichen VARCHAR(20) NULL;

UPDATE reports
   SET aktenzeichen = CONCAT('OWiAA#', UPPER(SUBSTRING(MD5(CONCAT(id, RAND(), UUID())), 1, 6)))
 WHERE aktenzeichen IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reports_aktenzeichen ON reports (aktenzeichen);
