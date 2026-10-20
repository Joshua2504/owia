-- Automatisches Schwärzen fremder Kennzeichen/Gesichter (services/dritteSchwaerzen.ts):
-- auto_geschwaerzt = die aktuelle Fassung ist die automatische Schwärzung
--   (Foto-Dialog zeigt „Schwärzung aufheben"); je Fassung höchstens einmal.
-- auto_schwaerzen_aus = der Nutzer hat das Foto selbst übernommen (Original
--   wiederhergestellt oder eigene Fassung gespeichert) – danach schwärzt der
--   Server dieses Foto nie wieder von sich aus.
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS auto_geschwaerzt TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS auto_schwaerzen_aus TINYINT(1) NOT NULL DEFAULT 0;
