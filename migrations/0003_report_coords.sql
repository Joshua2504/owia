-- Koordinaten des Tatorts. Photon liefert je Adresstreffer lat/lon; bisher wurden
-- diese verworfen. Mit der Karte beim Bearbeiten werden sie nun persistiert, damit
-- die Karte nach dem Neuladen zentriert bleibt und der Tatort eindeutig ist.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS tatort_lat DECIMAL(9,6) NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS tatort_lon DECIMAL(9,6) NULL;
