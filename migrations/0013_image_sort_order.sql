-- Sortierreihenfolge der Beweisfotos innerhalb einer Anzeige. Das erste Bild
-- (kleinster sort_order) wird u.a. als Karten-Marker verwendet. Bestehende Bilder
-- behalten mit Default 0 ihre bisherige Reihenfolge (Fallback nach id).

ALTER TABLE report_images ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_report_images_sort ON report_images(report_id, sort_order, id);
