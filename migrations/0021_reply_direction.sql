-- Aus den Ordnungsamt-Antworten wird ein vollständiger Nachrichtenverlauf:
-- auch die versendete Anzeige-Mail und Antworten des Nutzers werden als
-- Nachrichten gespeichert. direction: 'in' = vom Ordnungsamt eingegangen,
-- 'out' = von uns/dem Nutzer versendet.

ALTER TABLE report_replies ADD COLUMN IF NOT EXISTS direction VARCHAR(3) NOT NULL DEFAULT 'in';
