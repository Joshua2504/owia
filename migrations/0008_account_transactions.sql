-- Hauptbuch aller Kontobewegungen (Audit). amount_cents = vorzeichenbehafteter Effekt
-- auf das BEZAHLTE Guthaben (users.balance_cents); free_used_cents = daraus verbrauchtes
-- bzw. (bei Erstattung negativ) zurückgegebenes Gratisguthaben.
--   topup            amount = +Betrag,        free_used = 0
--   analysis_charge  amount = -bezahlter Teil, free_used = +Gratis-Teil
--   refund           amount = +Erstattung,    free_used = -zurückgegebener Gratis-Teil
--   adjustment       manuelle Korrektur
-- Invariante (testbar): SUM(amount_cents) je Nutzer == users.balance_cents.

CREATE TABLE IF NOT EXISTS account_transactions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  type            ENUM('topup','analysis_charge','refund','adjustment') NOT NULL,
  amount_cents    INT NOT NULL DEFAULT 0,
  free_used_cents INT NOT NULL DEFAULT 0,
  image_id        INT NULL,
  deposit_id      INT NULL,
  description     VARCHAR(255) NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_acct_tx_user    ON account_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_acct_tx_image   ON account_transactions(image_id);
CREATE INDEX IF NOT EXISTS idx_acct_tx_created ON account_transactions(created_at);
