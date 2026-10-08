-- Prüf-Dialog (photo-edit.js): Der Nutzer markiert auf jedem Foto das
-- Kennzeichen des angezeigten Fahrzeugs (vorbelegt aus der Erkennung) oder
-- bestätigt, dass keins zu sehen ist. Die öffentliche Übersichtskarte schwärzt
-- die markierte Box zusätzlich zu den erkannten (services/pixelate.ts).
-- kennzeichen_box: JSON [x1,y1,x2,y2], Anteile 0..1 der gespeicherten Fassung
-- (EXIF-gedreht); wird beim Ersetzen des Fotos zurückgesetzt.
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS kennzeichen_box VARCHAR(120) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS kennzeichen_keins TINYINT(1) NOT NULL DEFAULT 0;
