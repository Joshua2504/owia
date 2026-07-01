-- Analyse-Flatrate: 5 €/Monat für unbegrenzte KI-Analysen. subscription_active_until hält
-- fest, bis wann die Flatrate gilt (aktiv, solange > NOW()). Bezahlt wird aus dem
-- bezahlten Guthaben; die Buchung erscheint als neue Ledger-Art 'subscription'.

ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_active_until DATETIME NULL;

ALTER TABLE account_transactions
  MODIFY COLUMN type ENUM('topup','analysis_charge','refund','adjustment','subscription') NOT NULL;
