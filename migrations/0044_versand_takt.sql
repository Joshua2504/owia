-- Versand-Takt (services/versandTakt.ts): Die Warteschlange verschickt höchstens
-- eine Anzeige je VERSAND_ABSTAND (10 min) – Mail wie Portal. Eine Zeile hält den
-- Zeitpunkt des letzten Versandstarts; der Platz wird per bedingtem UPDATE
-- atomar belegt (CONCURRENCY im Job-Runner > 1).
CREATE TABLE IF NOT EXISTS versand_takt (
  id      TINYINT PRIMARY KEY,
  letzter DATETIME NOT NULL,
  vorher  DATETIME NOT NULL
);
INSERT IGNORE INTO versand_takt (id, letzter, vorher) VALUES (1, '2000-01-01', '2000-01-01');
