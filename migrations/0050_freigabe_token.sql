-- Freigabe an den geprüften Stand binden (services/reportDispatch.ts,
-- freigabeErteilen): Die Admin-Freigabe setzt eine Marke, die der Versand-Job
-- (report.dispatch / portal.start) im Payload mitträgt. Zurückziehen, Ablehnen
-- und (Neu-)Einreichen löschen sie – ein Job aus einer früheren Freigabe findet
-- dann keine passende Marke mehr und versendet nichts (sonst ginge nach
-- Zurückziehen → Ändern → Neu-Einreichen die ungeprüfte Fassung raus).
ALTER TABLE reports ADD COLUMN IF NOT EXISTS freigabe_token VARCHAR(40) NULL;

-- Lauf-Kennung je Claim (services/jobs.ts): Nach einem Zeitlimit wird der Job
-- neu eingereiht, der alte Handler läuft aber weiter. Nur der Lauf, dessen
-- Kennung noch passt, darf den Job abschließen.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lauf_id VARCHAR(36) NULL;

-- Bestand beim Deploy: wartende/laufende Versand-Jobs haben noch keine Marke.
-- Ein Job, der NACH der letzten Einreichung angelegt wurde, gehört zur
-- aktuellen Fassung (Freigabe kam danach) – er bekommt eine Marke, Anzeige und
-- Payload dieselbe. Ältere Jobs (vor einer Neu-Einreichung angelegt) bleiben
-- ohne Marke und versenden nichts; die Anzeige muss neu freigegeben werden.
UPDATE reports r
  JOIN jobs j ON j.type IN ('report.dispatch', 'portal.start') AND j.status IN ('queued', 'running')
             AND CAST(JSON_VALUE(j.payload, '$.reportId') AS UNSIGNED) = r.id
   SET r.freigabe_token = CONCAT('alt-', j.id)
 WHERE r.status = 'eingereicht' AND r.freigabe_token IS NULL
   AND r.eingereicht_at IS NOT NULL AND r.eingereicht_at <= j.created_at;

UPDATE jobs j
  JOIN reports r ON CAST(JSON_VALUE(j.payload, '$.reportId') AS UNSIGNED) = r.id
   SET j.payload = JSON_SET(j.payload, '$.freigabe', r.freigabe_token)
 WHERE j.type IN ('report.dispatch', 'portal.start') AND j.status IN ('queued', 'running')
   AND r.status = 'eingereicht' AND r.freigabe_token IS NOT NULL
   AND r.eingereicht_at <= j.created_at
   AND JSON_VALUE(j.payload, '$.freigabe') IS NULL;

-- Gerade laufende Portal-Versände: ein Neustart des Laufs (restartFromScratch)
-- übernimmt die Marke der Anzeige – also auch hier eine setzen.
UPDATE reports SET freigabe_token = CONCAT('alt-lauf-', id)
 WHERE status = 'eingereicht' AND freigabe_token IS NULL
   AND versand_status IS NOT NULL AND versand_ergebnis LIKE '%"portal"%';
