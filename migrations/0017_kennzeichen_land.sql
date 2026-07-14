-- Länderkürzel des Kennzeichens (blaues Band am Schild). Default 'D';
-- bei ausländischen Fahrzeugen z.B. 'USA', 'A', 'CH', 'PL'. Fließt bei
-- Nicht-D-Kennzeichen als Zusatz in PDF und E-Mail ein.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS kennzeichen_land VARCHAR(3) NOT NULL DEFAULT 'D';
