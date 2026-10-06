-- Papierkorb: gelöschte Entwürfe bekommen status='papierkorb' und den
-- Zeitpunkt des Löschens; nach 30 Tagen räumt server.ts sie endgültig ab.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS papierkorb_at DATETIME NULL;
ALTER TABLE reports MODIFY status ENUM('entwurf','eingereicht','versendet','papierkorb') NOT NULL DEFAULT 'entwurf';
