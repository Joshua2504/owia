-- Duplikat-Erkennung beim Foto-Upload: SHA-256 über den Original-Upload-Buffer
-- (vor jeder Konvertierung/Schwärzung – bei Ersatzfassungen bleibt der Hash des
-- Erst-Uploads stehen). NULL = Bestand vor dem Backfill
-- (src/scripts/backfill-hashes.ts) bzw. Originaldatei nicht mehr lesbar.

ALTER TABLE intake_photos ADD COLUMN IF NOT EXISTS sha256 CHAR(64) NULL;
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS sha256 CHAR(64) NULL;

CREATE INDEX IF NOT EXISTS idx_intake_photos_sha256 ON intake_photos(sha256);
CREATE INDEX IF NOT EXISTS idx_report_images_sha256 ON report_images(sha256);
