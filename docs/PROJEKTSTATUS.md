# OWiA – Projektstand und Übergabe an Codex

Stand: 06.10.2026. Geprüfte Entwicklungsbasis: Branch `main`, Commit `cf60f1b` vom 22.09.2026.

> Nachtrag: Diese Datei bewahrt die ursprüngliche Bestandsaufnahme. Der inzwischen
> umgesetzte Stand einschließlich Tests und Dev-Start steht in
> [FEHLERBEHEBUNG-2026-10-06.md](FEHLERBEHEBUNG-2026-10-06.md).

## Einschätzung

OWiA ist eine bereits betriebene Web-Anwendung mit umfangreichem Funktionsumfang. Die Kernstrecke von Foto-Upload über Entwurf und Admin-Prüfung bis zum Versand und Antwortverlauf ist implementiert. Die nächsten Arbeiten sollten vor allem Versandzuverlässigkeit, reproduzierbare Tests und Betriebsabsicherung verbessern.

Diese Bestandsaufnahme kombiniert Verzeichnis-/Git-Abgleich, Prüfung zentraler Quellcodepfade, Syntax-/Typprüfungen und lesende Betriebsabfragen. Sie ist kein vollständiges Zeile-für-Zeile-Audit, kein Browser-End-to-End-Test und kein Nachweis rechtlicher Konformität. Keine Produktionstests mit Schreibzugriff, keine E-Mails, keine Migrationen oder Deployments wurden ausgelöst.

## Warum zwei Ordner?

| Ordner | Aufgabe | Besonderheit |
| --- | --- | --- |
| `/root/owia/owia-codebase` | Entwicklung, Git-Verlauf, Änderungen und Prüfungen | eigene Konfiguration und Daten; hier arbeiten |
| `/root/owia/owia` | laufende Produktionskopie | kein Git-Repository; Änderungen kommen per Deployment |

Ablauf: Entwicklung → prüfen → committen → gezielt `./deploy.sh` ausführen → Produktion prüfen. Ein Git-Push dient laut Repository-Konfiguration als Backup und Referenz; er deployt nicht automatisch.

`deploy.sh` synchronisiert mit rsync und startet den Produktionsstack neu. `.env`, `data/`, `node_modules/` und Git-Metadaten werden nicht kopiert. Das Skript kopiert allerdings auch unversionierte Dateien außerhalb seiner Ausschlussliste; es warnt bei uncommittierten Änderungen, erlaubt aber eine manuelle Fortsetzung. Es ist kein unveränderliches Release-Artefakt und kein automatisches Rollback.

Die Trennung schützt den Live-Betrieb vor normalen Entwicklungsänderungen. Beide Stacks teilen sich trotzdem den Host und das Proxy-Netz; sie sind keine vollständige Infrastruktur-Isolation. Die Entwicklungsinstanz ist momentan nicht gestartet, die Trennung im Dateisystem besteht weiterhin.

## Beobachteter Betrieb

- Produktionscontainer vorhanden und laufend: App, Caddy, MariaDB, Mailpit, Photon, Tileserver und ALPR. App, DB, Mailpit, Photon und ALPR melden Docker-Healthstatus `healthy`; für Caddy/Tileserver wurde nur der Laufstatus festgestellt.
- `http://127.0.0.1:3000/health` lieferte `{"ok":true}`. Der Endpoint führt `SELECT 1` gegen die DB aus.
- Port `127.0.0.1:3001` nicht erreichbar; in `docker ps` kein laufender Dev-Stack.
- Vor den Dokumentationsänderungen waren die verglichenen Projektdateien beider Ordner identisch. Ausgenommen waren Git-/Claude-Metadaten, `.env`, Daten und Abhängigkeiten. Zusätzlich liegt in Prod eine `.env.bak-20260907-161620`; ihr Inhalt wurde nicht gelesen.
- 31 DB-Migrationen registriert; letzte `0031_photo_sha256.sql`.
- 193 Konten, davon 0 als anonymisiert markiert. Keine Aussage über aktive oder verifizierte Nutzung.
- 228 Anzeigen: 212 Entwürfe, 1 eingereicht, 15 versendet. Der Status ist kein Zustellnachweis beim Amt.
- 840 `report_images`-Datensätze, alle mit SHA-256. Die Hash-Abdeckung von `intake_photos` wurde nicht abgefragt.
- Externe Erreichbarkeit/TLS, tatsächliche SMTP-Zustellung, IMAP-Antworten, Backup-Zustand und Wiederherstellung wurden nicht getestet.

## Produktumfang

- Passwortloser Login per E-Mail-Code oder Magic-Link, optionale längere Sitzung, lokales Proof-of-Work-Captcha.
- Nutzerprofil, E-Mail-Wechsel, Datenexport als ZIP, Kontoschließung mit bereichsweiser Löschung/Anonymisierung.
- Anzeigeneditor mit Fotos, HEIC-Konvertierung, Originalerhalt, EXIF-Zeit/GPS, Kartenposition und Verstoßkatalog.
- Sammelimport: kleine Upload-Chunks, Gruppierung anhand Ort/Zeit, Zuordnung zu Entwürfen; Übernacht-Zeiträume werden unterstützt.
- SHA-256-Duplikaterkennung pro Nutzer in Anzeigen und unzugeordneten Importfotos.
- Lokale Kennzeichenerkennung, Bildausschnitt und Vorbefüllung noch leerer Kennzeichenfelder.
- Admin-Prüfung, Freigabe/Ablehnung, Benutzerübersicht, Verwaltung nicht zugeordneter Antworten und Newsletter.
- PDF für Frankfurt; strukturierte E-Mail mit Beweisfotos und ggf. Karte für Bad Soden-Salmünster und Hanau.
- IMAP-Antwortverarbeitung, Korrespondenz in der Anzeige, Antworten des Nutzers ans Amt.
- Öffentliche Karte mit Tatortkoordinaten, Datum, Verstoß und stark pixeliertem Foto; es werden auch Einzelfallmarker ausgeliefert, nicht ausschließlich Aggregate.
- Responsive Oberfläche, Theme-Umschaltung und PWA-Service-Worker; nur statische `/public/`-Assets werden gecacht.

## Architektur und Einstiegspunkte

| Bereich | Dateien | Bedeutung |
| --- | --- | --- |
| Boot / HTTP | `src/server.ts` | Produktionsprüfungen, DB-Initialisierung, Plugins, Routen, Hintergrundjobs, Healthcheck |
| Login / Zugriffsprüfung | `src/routes/auth.ts`, `src/middleware/auth.ts`, `src/config/admin.ts` | Sitzungen, Nutzeridentität, Admin-Allowlist |
| Anzeigen | `src/routes/reports.ts`, `src/services/drafts.ts` | Eigentümerprüfung, Entwürfe, Bearbeitung, Bilder, Einreichung |
| Sammelimport | `src/routes/intake.ts`, `src/services/intakeGrouping.ts`, `public/js/import-upload.js` | Batches, Chunkgröße 5, Gruppierung, manuelle Zuordnung |
| Fotos | `images.ts`, `exif.ts`, `pixelate.ts`, `photoDedup.ts` unter `src/services/` | Originale, Konvertierung, Metadaten, Ableitungen, Hashes |
| Kennzeichen | `src/services/alpr.ts`, `plateAnalysis.ts`, `docker/alpr/` | serielle In-Process-Warteschlange, HTTP-Inferenz, Ergebnisablage |
| Versand / Prüfung | `src/routes/admin.ts`, `src/services/mail.ts`, `pdf.ts`, `staticmap.ts` | Freigabe, Formular, SMTP, Beweisanhänge |
| Posteingang | `src/services/mailInbox.ts` | IMAP-Polling, Message-ID-/Aktenzeichen-Zuordnung, Anhänge |
| Städte | `src/config/cities.ts`, `src/services/districts.ts`, `resources/districts.csv` | Freischaltung und PLZ-/Empfängerzuordnung |
| Geodaten | `src/routes/geo.ts`, `tiles.ts`, `src/services/geocode.ts` | lokale Photon-/Tile-Proxys |
| Konto | `src/routes/settings.ts` | Profil, E-Mail-Wechsel, Export, Kontoschließung |
| Öffentlichkeit | `src/routes/public.ts`, `legal.ts` | Startseite, Karte, Newsletter, Rechtstexte |
| Darstellung | `src/views/`, `public/js/`, `public/css/`, `public/vendor/` | EJS, buildloses Browser-JS, Bootstrap, Leaflet |
| Datenbank | `src/db/`, `migrations/` | MariaDB, Session-Store, Basisschema und nummerierte Migrationen |
| Betrieb | `docker-compose.yml`, `docker/`, `deploy.sh`, `.github/workflows/deploy.yml` | Dienste, Proxy, lokales Deployment, manueller Actions-Fallback |

Node.js/TypeScript mit Fastify 4 und EJS; kein SPA-Build. Das Node-Image basiert auf Node 22 und führt TypeScript mit `tsx` aus. MariaDB wird über `mysql2` angesprochen. Der ALPR-Dienst nutzt Python/FastAPI, YOLOv9-Kennzeichendetektion (open-image-models) und das Kennzeichen-OCR fast-plate-ocr (cct-s-v2) über ONNX Runtime; keine PaddlePaddle-Laufzeit.

## Datenfluss und wichtige Invarianten

1. Ein Nutzer erstellt einen Entwurf oder lädt einen Foto-Batch hoch.
2. Originalbytes werden gehasht und für EXIF verwendet. HEIC wird zusätzlich in JPEG konvertiert. Original und bearbeitete Fassung müssen unterscheidbar bleiben.
3. Ort/Zeit gruppieren Importfotos; optionale ALPR analysiert nacheinander. Manuelle Kennzeichen werden nicht überschrieben.
4. Einreichung prüft Angaben, Profil und Stadt. Statusfolge: `entwurf` → `eingereicht` → `versendet`; Ablehnung führt zurück zum Entwurf.
5. Admin-Freigabe erzeugt das PDF neu, sendet die Mail, aktualisiert Status/Message-ID und speichert die ausgehende Nachricht.
6. IMAP verarbeitet ungelesene Mails. Zuordnung bevorzugt Message-ID-Bezüge; ohne diese wird das Aktenzeichen bei erlaubter Absenderdomain verwendet. Andere Mails landen zur manuellen Zuordnung im Adminbereich.

Relevante Tabellen: `users`, `reports`, `report_images`, `intake_batches`, `intake_photos`, `report_replies`, `report_reply_attachments`, `login_tokens`, `sessions`, `newsletter_subscribers`, `schema_migrations`. Ältere Migrationen enthalten Überreste früherer Zahlungs-/Abo-Funktionen; daraus keine aktuellen Produktfunktionen ableiten.

Dateien liegen insbesondere unter `data/uploads/<userId>/<reportId>/`, Importen unter `data/uploads/<userId>/intake/`, Mail-Anhängen unter `data/uploads/replies/` und PDFs unter `data/pdfs/`. Datenbank und Dateiablage sind nicht gemeinsam transaktional. DB-Backups allein reichen deshalb nicht zur vollständigen Wiederherstellung.

Die Arbeitsregeln in `CLAUDE.md` sind weiterhin relevant: deutsche Oberfläche, EXIF-Wanduhrzeiten als Strings, Flash-Cookie statt Session-Flash, lokale Assets, toleranter Ausfall optionaler Dienste. Aussagen wie „Originalfotos verlassen den Host nie“ beziehen sich sinnvollerweise auf die lokale Analyse; die Anwendung hat ausdrücklich Versand-/Exportfunktionen. Diese Aussagen nicht als pauschale technische Garantie übernehmen.

## Priorisierte Befunde

### 1. Versand gegen Doppelaufruf und Teilfehler absichern – hohe Priorität

Beleg: `src/routes/admin.ts`, Freigaberoute ab Zeile 171. Sie liest `eingereicht`, generiert das PDF, verschickt die Mail und setzt erst danach den DB-Status. Es gibt vor SMTP keinen atomaren Versand-Claim. Zwei parallele Freigaben können denselben Zustand lesen und beide senden. Nach erfolgreichem SMTP und fehlgeschlagenem DB-Update bleibt außerdem eine Wiederholung möglich. Scheitert nur das anschließende Speichern der Korrespondenz, behauptet die Fehlermeldung irrtümlich, die Anzeige bleibe eingereicht.

Empfehlung: persistenter Versandauftrag mit atomarem Claim, dokumentierten Zwischen-/Fehlerzuständen und kontrollierter Wiederaufnahme. Ein unklarer SMTP-Ausgang darf nicht blind erneut gesendet werden. Automatische Tests für parallele Freigaben und Fehler nach SMTP hinzufügen. Befund aus Codeprüfung; kein echter Doppelversand zum Test ausgelöst.

### 2. Posteingang nach Teilfehlern vollständig wiederaufnehmen – hohe Priorität

Beleg: `src/services/mailInbox.ts`, `processInboundMail()`. Die Mailzeile wird vor den Anhängen gespeichert. Bei einem Fehler danach bleibt die IMAP-Mail zwar ungelesen, der nächste Versuch erkennt aber die Message-ID als Duplikat und kehrt zurück; anschließend markiert der Poller sie als gelesen. Dadurch können Anhänge bzw. Benachrichtigung dauerhaft fehlen.

Empfehlung: Verarbeitungsstatus und wiederholbare Anhangsschritte; erst vollständig verarbeitete Mails als abgeschlossen behandeln. Test mit künstlichem Fehler zwischen Mailzeile und Anhang. Befund aus Codeprüfung, nicht gegen das echte Postfach reproduziert.

### 3. Automatisierte fachliche Tests / CI fehlen – hohe Priorität

`package.json` bietet nur `dev` und `start`. Keine versionierten Test-/Spec-Dateien gefunden; einziger GitHub-Workflow ist das manuelle Deployment. Erfolgreicher Typecheck beweist weder korrekten Mailversand noch Upload-/Berechtigungslogik.

Erste sinnvolle Tests: Nutzerisolation bei Bildern/Anzeigen, Einmal-Login unter Parallelität, Versandwiederholungen, IMAP-Teilfehler, Foto-Gruppierung über Mitternacht, Empfänger/Städte-Gate. CI zunächst mit Typecheck und diesen Tests; DB- und Mailtests isoliert.

### 4. Kontoschließung ist keine vollständige Inhaltslöschung – Produktentscheidung klären

Beleg: `src/routes/settings.ts`, `/einstellungen/loeschen`. Profildaten, PDFs und bisherige Korrespondenz werden entfernt; Anzeigen, Beweisfotos, EXIF und Importdaten bleiben bestehen. Freitexte können ebenfalls personenbezogene Angaben enthalten. Spätere Amtsantworten können erneut an verbliebene Anzeigen angehängt werden (`mailInbox.ts`).

Das ist teilweise ausdrücklich gewollt, aber „anonymisiert“ beschreibt nicht automatisch alle verbliebenen Inhalte. Dateninventar, gewünschte Aufbewahrung und Nutzerkommunikation fachlich abstimmen. Keine pauschale Rechtsbewertung aus dieser Bestandsaufnahme ableiten.

### 5. Einmal-Login wird nicht atomar verbraucht – mittlere Priorität

Beleg: `src/routes/auth.ts`, Codeprüfung und `/login/link/:token`. Nach dem Lesen eines unbenutzten Tokens setzt ein separates unbedingtes UPDATE `used_at`. Parallele Anfragen mit demselben gültigen Token können beide bis zur Anmeldung gelangen. Der atomare Fehlversuchszähler löst dieses andere Problem nicht.

Empfehlung: bedingtes UPDATE mit `used_at IS NULL` und Ablaufbedingung, `affectedRows` prüfen und nur den Gewinner anmelden. Mit isolierter DB auf konkurrierende Anfragen testen.

### 6. Betrieb reproduzierbarer machen – mittlere Priorität

- Dev-Stack ist dokumentiert, aber nicht aktiv. Vor Funktionstests kontrolliert bereitstellen; nicht einfach Prod zum Testen verwenden.
- Backup wird als extern vorhanden beschrieben, wurde aber weder nachgewiesen noch wiederhergestellt. Wiederherstellung von DB und Dateien dokumentieren/testen.
- Docker-Images verwenden teils `latest`; mehrere Python-Abhängigkeiten und die globale `tsx`-Installation sind ungepinnt. Ein Rebuild kann ohne Codeänderung neue Versionen einführen.
- Deployment startet den gesamten Stack neu, hat keinen automatischen Rollback und keine atomare Release-Umschaltung. Der Actions-Fallback hat keinen abschließenden Healthcheck.
- `MAIL_DRIVER` fällt bei jedem Wert außer exakt `smtp` auf Mailpit zurück. Produktionsprüfung dafür ergänzen; `/health` erkennt Fehlkonfiguration des Mailversands nicht.
- SHA-256-Duplikaterkennung ist eine Vorab-Abfrage mit normalen Indizes, keine atomare Eindeutigkeitsgarantie gegen gleichzeitige identische Uploads.
- Offene Import-Batches werden nicht automatisch bereinigt; Bilddekodierung arbeitet teilweise synchron; Node läuft im Container als root. Bereits bekannte technische Schulden.

## Dokumentationsabgleich

Im Entwicklungsrepo im Zuge dieser Übergabe korrigiert:

- README: Hanau ergänzt; ALPR-Laufzeit präzisiert; vorhandene Serverkonfiguration von Neuinstallation abgegrenzt; erforderliches externes Proxy-Netz im Schnellstart ergänzt.
- CLAUDE.md: veraltete Migrationsnummer 0030/0031 korrigiert; nächste Nummer immer im Dateisystem prüfen; Bezug zum datierten Status ergänzt.
- DEPLOY.md: wirkungslose Variable `MAIL_TO_FRANKFURT` entfernt; tatsächliche CSV-Empfängerquelle erklärt; kontrollierte Smoke-Tests und Grenzen des Healthchecks präzisiert.
- Neue `AGENTS.md`: kompakter Einstieg für Codex mit Verweisen auf die vorhandene Dokumentation.

Weitere Quellen von Missverständnissen: Kommentar am Anfang von `src/services/districts.ts` beschreibt noch Empfänger-Overrides aus der Städte-Registry, während der Code CSV-Empfänger nutzt. Kommentare in Compose nennen noch ausschließlich Frankfurt bzw. PaddleOCR. Diese Quellcodekommentare wurden bei dieser Dokumentationsaufgabe nicht geändert.

## Durchgeführte Prüfungen

| Prüfung | Ergebnis / Grenze |
| --- | --- |
| Git-Status vor Änderungen | sauber; Branch `main`, HEAD `cf60f1b` |
| TypeScript `tsc --noEmit` | erfolgreich; keine fachlichen Tests |
| `node --check` | alle 8 Dateien in `public/js/` und `public/sw.js` erfolgreich |
| EJS-Kompilierung | alle 24 Templates erfolgreich; kein Rendering mit echten View-Daten |
| Python-AST-Parsing | alle 6 ALPR-Python-Dateien erfolgreich; keine OCR-Inferenz getestet |
| `bash -n deploy.sh` | erfolgreich; Deployment nicht ausgeführt |
| Produktions-Healthcheck | erfolgreich, App und DB erreichbar |
| Dev-Healthcheck | Verbindung zu Port 3001 nicht möglich |
| DB-Abfragen | ausschließlich Schema-Metadaten und aggregierte Zählungen |
| Vergleich Dev/Prod-Dateien | vor Dokumentationsänderungen gleicher verglichener Projektstand; Laufzeitdaten/Secrets ausgenommen |

Nicht durchgeführt: vollständiger Browser-/Mobiltest, echter Login-Mailversand, SMTP-/IMAP-End-to-End, Lasttest, aktuelle Dependency-/CVE-Prüfung, Restore, externe Prüfung der Behördenadressen oder Rechtstexte. Keine bestehenden Fachtests ausführbar, da keine Suite vorhanden.

## Empfohlene nächste Arbeitsfolge

1. Dev-Umgebung mit getrennten Daten und Mailpit überprüfen und bereitstellen.
2. Versand und Posteingang wiederholbar machen und gezielt testen.
3. Einmal-Login atomar absichern; CI für Typen und kritische Fachtests ergänzen.
4. Aufbewahrung/Kontoschließung sowie Backup/Restore konkret festhalten.
5. Danach neue Produktfunktionen bzw. weitere Städte angehen.

## Arbeiten mit Codex

Der Nutzer beschreibt Ziel oder Problem in normalen Sätzen. `AGENTS.md` ist der dauerhafte Einstieg für spätere Aufgaben; `CLAUDE.md` bleibt als gemeinsame Fachreferenz bestehen. Der Projektstatus ist ein datierter Nachweis, keine automatisch aktuelle Übersicht. Änderungen am Betrieb oder an der Architektur müssen dort bei Bedarf nachgetragen werden.

Offizielle Referenz für projektbezogene Anweisungen: https://learn.chatgpt.com/docs/agent-configuration/agents-md

Diese Übergabe verändert ausschließlich Dokumentation im Entwicklungsrepo. Kein Commit, Push oder Deployment wurde vorgenommen. Die Produktionskopie behält ihren bisherigen Dokumentationsstand bis zu einem späteren Deployment.
