# Fehlerbehebung vom 06.10.2026

## Ergebnis

Im Entwicklungsrepo umgesetzt, geprüft und in der Dev-App verfügbar. Noch kein
Commit, Push oder Produktionsdeployment. Der Produktionscode ist unverändert.

- Admin-Freigaben beanspruchen eine Anzeige atomar vor der Vorbereitung.
  Parallele Anfragen verschicken sie nicht mehrfach.
- Unklare SMTP-Ergebnisse bleiben dauerhaft gesperrt, auch nach Neustart.
  Gespeicherte Annahmen können ihren lokalen Abschluss ohne erneuten Versand nachholen.
- Versandstatus und ausgehende Korrespondenz werden gemeinsam committed.
- Rücknahme, Ablehnung und Kontoschließung respektieren einen begonnenen Versand.
  Doppelte Einreichung überschreibt keinen späteren Status mehr.
- Posteingang speichert neue Mail und Anhang-Metadaten atomar. SQL- oder
  Dateisystemfehler erlauben einen vollständigen späteren Import.
- Login-Code und Magic-Link können denselben Token auch bei Parallelität nur
  einmal verbrauchen. Fehlversuchslimit und Ablaufprüfung bleiben erhalten.
- Falscher Produktions-Mailtreiber oder fehlender Host/Absender führt zum
  Startabbruch statt stiller Umleitung an Mailpit. SMTP-Zeitlimits sind gesetzt.
- Isolierte Regressionstests sowie GitHub-Actions-Prüfungen ergänzt.

## Verifiziert

`npm run check`: TypeScript für Anwendung und Tests, Browser-JavaScript und alle
24 EJS-Templates erfolgreich geprüft.

`npm test`: **21 Tests bestanden**. Unter anderem parallele Freigaben, PDF-
Vorbereitungsfehler, unklarer SMTP-Ausgang, SQL-Ausfälle nach SMTP, Wiederaufnahme,
Rücknahme/Ablehnung, konkurrierender Link-/Code-Login, Ablauf und Versuchslimit,
SQL-/Dateisystemfehler beim Anhang, paralleler Import, echter SMTP-Austausch mit
isoliertem Mailpit, Nutzerisolation, Stadtzuordnung, Mitternachtsgruppierung,
Kontoschließung und tatsächlich gerenderte Admin-Ansicht.

Die gesamte Migrationskette einschließlich `0032_report_dispatch.sql` wurde auf
frischer Test-DB angewandt und der Migrationsrunner erneut ausgeführt. Die CI-Datei
führt dieselben Befehle aus; ein GitHub-Lauf wurde noch nicht ausgelöst.

Dev-App, Dev-DB und Dev-Mailpit laufen wieder. `127.0.0.1:3001/health` liefert
`{"ok":true}`. Startseite und Loginseite antworten ebenfalls mit HTTP 200.
Migration 0032 ist in Dev bestätigt. Die Konfiguration wurde auf Development-Modus, Mailpit, deaktiviertes
IMAP und getrennte Datenpfade geprüft. Optionale Dev-Dienste Photon/Tileserver/ALPR
wurden nicht gestartet. Produktion wurde weder neugestartet noch migriert.

## Dokumentation und verbleibende Entscheidungen

Versandzustände, Fehlergrenzen und manuelle Klärung stehen in `VERSANDBETRIEB.md`.
`AGENTS.md`, `CLAUDE.md`, `README.md` und `DEPLOY.md` wurden nachgeführt.

Die Entscheidung, ob Kontoschließung künftig sämtliche Anzeigen, Originalfotos
und Importdaten löschen soll, wurde beim Nutzer angefragt und ist noch offen.
Das bisherige Aufbewahrungsmodell wurde deshalb beibehalten. Die technische
Sperre während laufenden/ungeklärten Versands ist bereits umgesetzt.

Backup/Restore wurde nicht ausgeführt oder nachgewiesen. Weitere Punkte aus der
Bestandsaufnahme (z.B. Abhängigkeiten pinnen, Import-Aufräumen, atomare Upload-
Duplikaterkennung und generelle Release-/Rollback-Strategie) sind nicht Teil der
hier umgesetzten Fehlerbehebung. Keine aktuellen Behördenadressen/Rechtstexte
extern geprüft und kein vollständiger Browser-End-to-End-Test durchgeführt.
