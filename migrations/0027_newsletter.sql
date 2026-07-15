-- Newsletter: Benachrichtigung, wenn neue Städte/PLZ freigeschaltet werden
-- (Anmeldung auf der Startseite). Double-Opt-In: Der Eintrag entsteht bei der
-- Anmeldung, zählt aber erst ab confirmed_at; unbestätigte Einträge verfallen
-- nach expires_at. token dient dem Bestätigungs- UND dem Abmelde-Link.
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  token VARCHAR(64) NOT NULL UNIQUE,
  confirmed_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
