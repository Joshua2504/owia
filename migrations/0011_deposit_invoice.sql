-- Bei der Bestätigung einer Einzahlung gibt der Admin die Zahlungsreferenz an (die er
-- auf dem Kontoauszug / bei PayPal sieht); außerdem wird eine Rechnungsnummer vergeben
-- und dem Nutzer eine Rechnung per E-Mail geschickt.

ALTER TABLE deposit_orders ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255) NULL;
ALTER TABLE deposit_orders ADD COLUMN IF NOT EXISTS invoice_number    VARCHAR(40)  NULL;
