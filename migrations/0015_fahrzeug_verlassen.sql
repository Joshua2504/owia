-- Checkbox "Das Fahrzeug war verlassen": fließt als Zusatz-Satz in die
-- Sachverhaltsschilderung (PDF) und den E-Mail-Text ein.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS fahrzeug_verlassen TINYINT(1) NOT NULL DEFAULT 0;
