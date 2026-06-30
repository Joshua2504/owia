-- Ergebnisse der automatischen Foto-Analyse (Kennzeichen + Verstoßart) pro Bild.
-- Die Analyse läuft nach dem Upload asynchron im Hintergrund (selbst-gehostete
-- Dienste alpr + ollama); die Befunde werden hier zwischengespeichert und das
-- Bearbeiten-Formular liest sie per Poll, um leere Felder vorzubelegen.

ALTER TABLE report_images ADD COLUMN IF NOT EXISTS detected_plate   VARCHAR(20)  NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS plate_confidence DECIMAL(4,3) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS vlm_verstoss_art VARCHAR(255) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS vlm_marke        VARCHAR(100) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS vlm_beschreibung TEXT         NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS analysis_status  VARCHAR(20)  NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS analyzed_at      DATETIME     NULL;
