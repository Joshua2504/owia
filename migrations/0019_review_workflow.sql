-- Freigabe-Workflow: Nutzer reichen Anzeigen zur Prüfung ein (status
-- 'eingereicht', bislang ungenutzt), ein Admin gibt frei und verschickt sie
-- ans Ordnungsamt. Bei Ablehnung geht die Anzeige mit Begründung zurück in
-- den Entwurf.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS eingereicht_at DATETIME NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS ablehnung_grund TEXT NULL;
