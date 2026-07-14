-- E-Mail-Adresse ändern: die neue Adresse wird erst nach Bestätigung eines
-- per Mail (an die NEUE Adresse) verschickten Tokens übernommen.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_neu     VARCHAR(255) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token   VARCHAR(64)  NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_expires DATETIME     NULL;
