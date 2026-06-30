-- Zuständige Stadt/Behörde je Anzeige. Vorbereitung für mehrere Städte; aktuell
-- ist nur "frankfurt" konfiguriert (siehe src/config/cities.ts). Bestehende und
-- neue Anzeigen ohne explizite Angabe gelten als Frankfurt.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS city VARCHAR(50) NOT NULL DEFAULT 'frankfurt';
