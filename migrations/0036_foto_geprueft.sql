-- Foto-Prüfung: Jedes Foto eines Entwurfs muss einzeln angesehen und bestätigt
-- werden (ggf. nach dem Schwärzen), bevor die Anzeige eingereicht werden kann.
-- NULL = noch ungeprüft. Fotos bereits eingereichter/versendeter Anzeigen
-- gelten als geprüft; offene Entwürfe starten bewusst ungeprüft.
ALTER TABLE report_images ADD COLUMN IF NOT EXISTS geprueft_at DATETIME NULL;
UPDATE report_images ri JOIN reports r ON r.id = ri.report_id
   SET ri.geprueft_at = NOW()
 WHERE r.status IN ('eingereicht', 'versendet') AND ri.geprueft_at IS NULL;
