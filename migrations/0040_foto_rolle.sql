-- Frankfurter Portal: Beweisfotos gehen getrennt als Übersichts- und als
-- Fahrzeugfoto hoch. NULL = automatisch (erkanntes Kennzeichen ⇒ Fahrzeug),
-- sonst 'uebersicht' oder 'fahrzeug' (im Foto-Dialog gesetzt, services/portalFfm.ts).
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS portal_rolle VARCHAR(12) NULL;
