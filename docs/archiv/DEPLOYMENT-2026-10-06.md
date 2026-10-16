# Produktionsdeployment 06.10.2026

Abschlussprüfung: 2026-10-06T16:06:17+02:00 (Europe/Berlin).
Nutzerauftrag: Änderungen ausrollen, anschließend offene Rückfragen stellen.
Code-Commit: `1ad1642`.

## Durchführung

- `npm run check` und alle 21 Regressionstests erneut erfolgreich ausgeführt.
- Produktionskonfiguration für SMTP/HTTPS überprüft.
- Bisheriges Image als `owia-app:rollback-20261006` erhalten.
- Neues App-Image `owia-app:release-1ad1642` gebaut.
- Sicherung unter `/root/owia/backups/20261006-codex-01/`:
  `code/` enthält bisherigen Code und Konfiguration; `data/` enthält Uploads/PDFs;
  `database.sql.gz` enthält den konsistenten MariaDB-Dump mit Routinen/Events/Triggern.
  Archivintegrität mit `gzip -t` geprüft; SHA-256 in `database.sha256` gespeichert.
  Übergeordnetes Sicherungsverzeichnis ist nur für root zugänglich. Kein Restore durchgeführt.
- App für abschließende Dateisynchronisation und DB-Sicherung angehalten.
- Code mit rsync synchronisiert, `.env*`, `data/`, Abhängigkeiten und Git-Metadaten geschützt.
- Fehlendes `TSX_WATCH` war in Produktion auf den Watch-Modus zurückgefallen.
  In Produktions-`.env` jetzt explizit leer gesetzt und im laufenden Container geprüft.
- App mit dem neuen Image neu erstellt, ohne andere Dienste neu zu starten oder
  deren Images zu aktualisieren. Bewusst gezielter App-Deploy statt des pauschalen
  Pull/Recreate aller Dienste durch `deploy.sh`.
- Migration `0032_report_dispatch.sql` beim Start erfolgreich angewandt.

## Ergebnis der Nachprüfung

- Öffentliches HTTPS: `/health`, `/`, `/login` liefern HTTP 200.
- Produktionsfremder Debug-Endpunkt `/debug/pdf-fields` liefert HTTP 404.
- App meldet Docker-Healthstatus `healthy`; 32 Migrationen in der Produktions-DB.
- SMTP-Verbindung und Authentifizierung per `verify()` erfolgreich, keine Testmail versendet.
- IMAP-Polling gestartet; keine Fehler-Level-Meldungen im neuen App-Container bei der Prüfung.
- Caddy, DB, Photon, Tileserver, ALPR und Mailpit blieben unverändert laufend.

## Grenzen und nächste Entscheidungen

Kein neuer fachlicher Test mit echten Nutzerkonten oder Amts-Empfängern ausgeführt.
Die Regressionstests verwenden ausschließlich ihre isolierte Datenbank und Mailpit.
Die Sicherung liegt auf demselben Host und ersetzt kein externes regelmäßiges Backup.
Vor einem Rollback zunächst offene `versand_status`-Vorgänge prüfen; alter Code
kennt deren Sperren nicht. Wiederaufnahme siehe `VERSANDBETRIEB.md`.

## Bestätigte Entscheidungen nach dem Deployment

Am 06.10.2026 vom Nutzer bestätigt:

- Die bisherige Datenaufbewahrung nach Kontoschließung bleibt unverändert.
- Die gesamte VM wird regelmäßig gesichert. Keine zusätzliche Backup-Einrichtung
  im Rahmen dieser Aufgabe erforderlich. Diese Angabe stammt vom Nutzer;
  ein eigener Restore-Test wurde nicht durchgeführt.

Die beiden Rückfragen sind damit abgeschlossen.
