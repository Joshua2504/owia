-- KI-Foto-Analyse und Guthaben-/Abrechnungssystem restlos entfernen.
-- Die Analyse (ALPR/VLM) und die Bezahlfunktionen (Einzahlungen, Erstattungen,
-- Abo) wurden aus der App ausgebaut; Anzeigen werden manuell ausgefüllt.
-- Buchungsdaten gehen bewusst verloren (Entscheidung vom 2026-07-14).

ALTER TABLE report_images DROP COLUMN IF EXISTS detected_plate;
ALTER TABLE report_images DROP COLUMN IF EXISTS plate_confidence;
ALTER TABLE report_images DROP COLUMN IF EXISTS vlm_verstoss_art;
ALTER TABLE report_images DROP COLUMN IF EXISTS vlm_marke;
ALTER TABLE report_images DROP COLUMN IF EXISTS vlm_beschreibung;
ALTER TABLE report_images DROP COLUMN IF EXISTS analysis_status;
ALTER TABLE report_images DROP COLUMN IF EXISTS analyzed_at;

ALTER TABLE users DROP COLUMN IF EXISTS balance_cents;
ALTER TABLE users DROP COLUMN IF EXISTS free_cents;
ALTER TABLE users DROP COLUMN IF EXISTS free_accrued_on;
ALTER TABLE users DROP COLUMN IF EXISTS subscription_active_until;

-- Reihenfolge wegen Fremdschlüsseln: erst abhängige Tabellen.
DROP TABLE IF EXISTS refund_request_images;
DROP TABLE IF EXISTS refund_requests;
DROP TABLE IF EXISTS deposit_orders;
DROP TABLE IF EXISTS account_transactions;
