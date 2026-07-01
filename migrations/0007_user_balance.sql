-- Guthaben-Konto: bezahltes Guthaben (balance_cents) und kostenloses Tagesguthaben
-- (free_cents). Jeder Nutzer erhält 0,20 €/Tag; ungenutztes Freiguthaben wird
-- übertragen, ist aber bei 0,40 € gedeckelt. free_accrued_on merkt sich den Tag der
-- letzten Gutschrift für die lazy Akkumulation (siehe src/services/credits.ts).
-- Alle Geldbeträge in Cent (INT), niemals als Fließkomma.

ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_cents   INT  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_cents      INT  NOT NULL DEFAULT 20;
ALTER TABLE users ADD COLUMN IF NOT EXISTS free_accrued_on DATE NULL;
