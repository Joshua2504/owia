-- Datenschutz-Prüfung der Beweisfotos (services/dritte.ts): vollständiges
-- Ergebnis der Bildanalyse je Foto – alle erkannten Kennzeichen mit Position,
-- Gesichter, Bildgröße – als JSON. dritte_ok = Nutzer hat die Warnung zu
-- diesem Foto als unbedenklich bestätigt (wird beim Ersetzen zurückgesetzt).
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS analyse_json MEDIUMTEXT NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS dritte_ok TINYINT(1) NOT NULL DEFAULT 0;
