-- „Uhrzeit bis" nur noch ab 3 Minuten Abstand (services/tatzeit.ts). Offene
-- Entwürfe, deren Zeitraum aus den Fotos kürzer ist (z.B. „16:18 – 16:18"),
-- werden zu einem Zeitpunkt. Eingereichte/versendete bleiben unverändert.
UPDATE reports SET tatzeit_bis = NULL
 WHERE status = 'entwurf' AND versand_status IS NULL AND tattag_bis IS NULL
   AND tatzeit_von IS NOT NULL AND tatzeit_bis >= tatzeit_von
   AND TIME_TO_SEC(TIMEDIFF(tatzeit_bis, tatzeit_von)) < 180;
