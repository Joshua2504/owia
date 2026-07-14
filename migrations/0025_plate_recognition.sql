-- Kennzeichen-Erkennung (YOLO + PaddleOCR im Container "alpr") pro Beweisfoto.
-- Läuft nach dem Upload asynchron; das Formular pollt GET /anzeige/:az/analysis.
-- analysis_status: NULL (nicht eingereiht), pending, done, failed, skipped.
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS detected_plate VARCHAR(20) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS plate_confidence DECIMAL(4,3) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS analysis_status VARCHAR(20) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS analyzed_at DATETIME NULL;
