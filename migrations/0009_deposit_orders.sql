-- Einzahlungsaufträge (Aufladung per Überweisung oder PayPal). Es gibt kein
-- Zahlungs-Gateway: ein Admin bestätigt den Eingang manuell, wodurch das Guthaben
-- gutgeschrieben wird (src/services/credits.ts confirmDeposit). reference ist der
-- Verwendungszweck, den der Nutzer bei der Zahlung angibt.

CREATE TABLE IF NOT EXISTS deposit_orders (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  amount_cents  INT NOT NULL,
  method        ENUM('ueberweisung','paypal') NOT NULL,
  reference     VARCHAR(40) NOT NULL,
  status        ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
  confirmed_by  VARCHAR(255) NULL,
  confirmed_at  DATETIME NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deposit_orders_user   ON deposit_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_orders_status ON deposit_orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_orders_ref ON deposit_orders(reference);
