-- Optionale PLZ zur Newsletter-Anmeldung: zeigt, wo die Nachfrage sitzt, und
-- hilft zu priorisieren, welche Städte/PLZ-Gebiete als Nächstes freigeschaltet
-- werden (Auswertung auf /admin/newsletter).
ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS plz VARCHAR(5) NULL;
