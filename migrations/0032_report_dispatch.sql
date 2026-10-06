-- Dauerhafte Versandsperre: SMTP und SQL können nicht gemeinsam committen.
-- Ein unklarer Versand wird deshalb niemals automatisch wiederholt.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS versand_status VARCHAR(20) NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS versand_ergebnis MEDIUMTEXT NULL;
