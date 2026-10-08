-- Kennzeichen vom Nutzer bestätigt (Häkchen „geprüft" im Foto-Dialog):
-- gespeichert wird „<Land>|<Kennzeichen>" zum Zeitpunkt der Bestätigung. Es gilt
-- nur, solange es zum aktuellen Kennzeichen passt – jede Änderung macht eine
-- neue Bestätigung nötig (submitProblems in routes/reports/submit.ts).
ALTER TABLE reports ADD COLUMN IF NOT EXISTS kennzeichen_bestaetigt VARCHAR(40) NULL;
