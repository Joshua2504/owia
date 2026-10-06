# Arbeitsanleitung für Codex: OWiA

## Einstieg

- Lies `CLAUDE.md` für Architektur, Befehle und Konventionen. Diese Regeln gelten auch für Codex.
- Lies `docs/PROJEKTSTATUS.md` für den geprüften Stand, Befunde und nächste Aufgaben; Datum beachten.
- `README.md` beschreibt Produkt und Setup, `DEPLOY.md` den Betrieb, `.env.example` die Konfiguration.
- Antworte dem Nutzer auf Deutsch und erkläre Auswirkungen in verständlicher Sprache.

## Arbeitsort und Betrieb

- Änderungen erfolgen in `/root/owia/owia-codebase` (Git). `/root/owia/owia` ist das Produktionsziel.
- Die Ordner sind keine zwei Produkte: `deploy.sh` kopiert die Entwicklung nach Produktion und startet dort Dienste neu.
- `.env`, `data/` und Docker-Volumes gehören zur jeweiligen Umgebung. Keine Produktionsdaten in Tests übernehmen.
- Vor einer Aufgabe Git-Status prüfen und vorhandene Änderungen erhalten. Bei der Bestandsaufnahme am 06.10.2026 war die Arbeitskopie sauber.
- Vor Laufzeittests den tatsächlichen Dev-Stack prüfen. Seit der Fehlerbehebung am 06.10.2026 laufen Dev-App, DB und Mailpit auf Port 3001/8026; optionale Kartendienste/ALPR wurden nicht gestartet.
- Ein App-Start führt Migrationen und Hintergrundjobs aus. Produktion nicht für schreibende Tests, Probeversand oder Backfill-Skripte verwenden.
- Deployment, Neustarts oder echter Mailversand nur, wenn sie vom jeweiligen Auftrag gedeckt sind. Eine Bestandsaufnahme autorisiert sie nicht.
- Keine Geheimnisse, `.env`-Inhalte, Login-Links oder personenbezogenen Nutzdaten in Dokumentation, Chat oder Git übernehmen.

## Implementierung

- Deutsche Oberfläche, englische Funktionsnamen; bestehende Benennungen respektieren.
- EXIF aus Originalbytes lesen. Foto-Wanduhrzeiten als Strings erhalten. Original und bearbeitete Bildfassung getrennt behandeln.
- Nutzerzugehörigkeit und Status serverseitig prüfen; öffentliche Bilder nur über die Pixelierungs-Pipeline ausliefern.
- Städte in `src/config/cities.ts`, Empfänger in `resources/districts.csv`; Grenzen und PDF-Zuordnung bei Stadterweiterungen mitprüfen.
- Neue DB-Änderung als neue idempotente SQL-Migration; höchste Nummer vorher nachsehen. Keine neuen Legacy-ALTERs in `src/db/init.ts`.
- Frontend bleibt buildlos und lokal gehostet. Flash-Cookies und gemeinsame Upload-Limits beachten.
- Fachliche Versandänderungen brauchen Schutz vor parallelen Anfragen und unklarem SMTP-Ergebnis; siehe Befunde im Projektstatus.

## Prüfen und dokumentieren

- Typ- und Syntaxprüfungen einschließlich Tests: `npm run check`.
- Geändertes Browser-JS: `node --check public/js/<datei>.js`; Service Worker ggf. ebenfalls prüfen.
- Deploy-Shell bei Änderungen: `bash -n deploy.sh`.
- Regressionstests: `npm test` startet eine vollständig isolierte Wegwerf-DB und Mailpit ohne Internetzugang (`compose.test.yml`). Niemals Tests direkt gegen Dev-/Prod-Datenbanken starten. GitHub-CI führt `npm run check` und `npm test` aus.
- Bei fachlichen Änderungen gezielte Tests ergänzen und ausschließlich mit isolierten Testdaten/Mailpit ausführen.
- Ergebnisse, nicht geprüfte Bereiche und neue Betriebsannahmen dokumentieren. Flüchtige Betriebszahlen gehören in den datierten Projektstatus, nicht in dauerhafte Regeln.

## Versand und Fehlerbehebung

- `docs/FEHLERBEHEBUNG-2026-10-06.md` beschreibt die Regressionstests und den Stand der Umsetzung.
- `docs/VERSANDBETRIEB.md` erklärt die dauerhafte Versandsperre und die manuelle Klärung ungewisser SMTP-Ergebnisse. Niemals eine Versandsperre automatisch nach einem Timeout zurücksetzen.
- `reports.versand_status` schützt auch gegen Rücknahme, Ablehnung und Kontoschließung während des Versands. Neue Statuswechsel müssen diese Sperre respektieren.
