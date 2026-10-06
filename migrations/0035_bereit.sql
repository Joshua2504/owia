-- „Bereit"-Markierung: eigene Notiz des Nutzers, dass ein Entwurf fertig ist
-- und als Nächstes eingereicht werden kann. Rein informativ, kein Workflow.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS bereit_at DATETIME NULL;
