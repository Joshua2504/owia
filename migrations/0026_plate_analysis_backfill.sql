-- Bestandsbilder von vor der Kennzeichenerkennung als 'skipped' markieren.
-- Der Poll-Endpoint wertet nur noch analysis_status='pending' als "läuft noch";
-- NULL-Altbestand würde sonst im Formular eine endlose Ladeanimation auslösen.
UPDATE report_images SET analysis_status='skipped' WHERE analysis_status IS NULL;
