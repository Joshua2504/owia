-- Kontoschließung anonymisiert den Nutzer, statt Anzeigen hart zu löschen:
-- die users-Zeile bleibt (mit geleerten Feldern + Platzhalter-E-Mail) erhalten,
-- damit die Anzeigen inkl. Fotos/Tatort für Statistik und öffentliche Karte
-- bestehen bleiben. anonymized_at markiert solche Konten (Login gesperrt,
-- keine Benachrichtigungen mehr).

ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at DATETIME NULL;
