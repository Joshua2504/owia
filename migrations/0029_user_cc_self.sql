-- Nutzer können wählen, ob E-Mails ans Ordnungsamt (Anzeige-Versand und
-- eigene Antworten) in Kopie (CC) an die eigene Adresse gehen. Standard: an.

ALTER TABLE users ADD COLUMN IF NOT EXISTS cc_self TINYINT(1) NOT NULL DEFAULT 1;
