-- Versand-Takt im Admin einstellbar (/versand): Abstand zwischen zwei
-- Portal-Anzeigen in Sekunden. NULL = Vorgabe aus VERSAND_ABSTAND_SEK (60).
ALTER TABLE versand_takt ADD COLUMN IF NOT EXISTS abstand_sek INT NULL;
