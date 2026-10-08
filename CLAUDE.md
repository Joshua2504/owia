# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Projekt-Doku: [README.md](README.md) (Funktionsumfang, Stack, Städte-Registry),
[DEPLOY.md](DEPLOY.md) (Go-Live-Checkliste, Prod-Pflichtwerte). Hier steht nur,
was dort nicht steht: Server-Setup, Befehle, Architektur-Zusammenhänge, Konventionen.

## Setup auf diesem Server

Es gibt zwei Instanzen, beide als Docker-Compose-Stacks auf derselben Maschine:

| | Dev | Prod |
|---|---|---|
| Verzeichnis | `/root/owia/owia-codebase` (dieses Repo) | `/root/owia/owia` (Deploy-Ziel, kein Git) |
| Compose-Projekt | `ffm-owianzeiger` (in `.env` gepinnt!) | `owia` (aus Verzeichnisname) |
| URL | https://dev.owia.treudler.net (Basic Auth `dev`, Passwort: `/root/.owia-dev-basicauth`) | https://owia.treudler.net (Live-Traffic!) |
| Mail | Mailpit: https://dev-mail.owia.treudler.net | echter SMTP + IMAP |
| Lokale Ports | App 127.0.0.1:3001, Mailpit 8026 | App 127.0.0.1:3000, Mailpit 8025 |

- **Entwickelt wird nur hier.** Die App läuft mit `tsx watch` — Änderungen unter
  `src/`, `public/`, `migrations/` greifen sofort ohne Rebuild (Bind-Mounts).
  Änderungen an `docker-compose.yml`, `docker/` oder `package.json` brauchen
  `docker compose up -d --build`.
- Die App läuft im Container als `node` (UID 1000): `data/uploads` und
  `data/pdfs` müssen auf dem Host UID 1000 gehören (`deploy.sh` macht das
  chown; in Dev einmalig von Hand). Der App-Container bekommt **nicht** die
  ganze `.env`, sondern nur die in `docker-compose.yml` unter `environment:`
  gelisteten Variablen – neue `process.env.X` dort eintragen.
- **Deploy nach Prod:** `./deploy.sh` (rsync + force-recreate + Health-Check).
  Vorher committen. `git push` deployt NICHT mehr — GitHub ist nur Backup
  (Remote-Redirect: Repo heißt dort inzwischen `Joshua2504/owia`).
- Der Prod-Caddy proxyt die Dev-Subdomains über das Shared-Netz `owia-proxy`
  per Containernamen (`ffm-owianzeiger-app-1` usw.) — deshalb ist der
  Projektname gepinnt; Caddyfile-Änderungen greifen erst nach Prod-Deploy.

## Befehle

```bash
npx tsc --noEmit                      # Typecheck (kein Build, kein Lint, keine Tests)
node --check public/js/datei.js       # Syntax-Check für Frontend-JS
docker compose logs app -f --tail 50  # App-Logs (im jeweiligen Verzeichnis)
docker compose up -d --build          # nach Compose-/Docker-/Dependency-Änderungen
npx tsx src/scripts/foo.ts            # Einmal-Scripts (Muster: backfill-thumbs.ts)

# Amts-Antwort in Dev simulieren (Mailpit spricht kein IMAP):
curl -X POST http://127.0.0.1:3001/dev/inbound-mail \
  -H 'Content-Type: message/rfc822' --data-binary @mail.eml

# AcroForm-Feldnamen eines PDF-Formulars auslesen (nur Dev):
curl http://127.0.0.1:3001/debug/pdf-fields
```

## Architektur

**Boot** (`src/server.ts`, eine `main()`, Reihenfolge relevant): Prod-Fail-Fast
(SESSION_SECRET/APP_URL) → `initDb()` (Legacy-ALTERs in `src/db/init.ts`, dann
Migrations-Runner) → Plugins (helmet mit strikter CSP, rate-limit, session mit
eigenem MySQL-Store) → 301-Redirects alter englischer Pfade → Routen →
Hintergrund-Jobs (IMAP-Polling, 6h-Purge, ALPR-Aufräumer, Job-Runner).

**Hintergrund-Jobs** (`services/jobs.ts`, Tabelle `jobs`): Alles, worauf der
Nutzer nicht warten soll, läuft als durabler Job – `intake.group` (Import),
`report.pdf`, `report.dispatch` (Versand, 1 Versuch), `mail.*`. Handler müssen
wiederholbar sein (Neustart reiht laufende Jobs neu ein). Neue langsame Arbeit
in Requests: `registerJob` + `enqueueJob` statt `await`.

**Anzeigen-Lifecycle** (`reports.status`: `entwurf` → `eingereicht` → `versendet`):
1. Entwurf (`services/drafts.ts`; Aktenzeichen `OWiA-<6 Ziffern>`), einzeln im
   Editor oder gebündelt über den Foto-Import (`routes/intake.ts` +
   `services/intakeGrouping.ts`, deterministisches Clustering nach GPS/Zeit).
2. Fotoupload: `services/images.ts` (HEIC→JPG, Original bleibt erhalten) →
   `services/exif.ts` (liest **aus dem Original-Buffer** — die Konvertierung
   strippt EXIF) → `services/plateAnalysis.ts` (fire-and-forget-Queue) →
   `services/alpr.ts` (HTTP an lokalen ALPR-Container, Fehler ⇒ `null`).
3. `submit` prüft Vollständigkeit + Nutzerprofil + Städte-Gate
   (`services/districts.ts`: PLZ → Ordnungsamt aus `resources/districts.csv`;
   freigeschaltet nur, was in `src/config/cities.ts` steht).
4. Admin-Freigabe (`routes/admin.ts`) regeneriert das PDF (`services/pdf.ts`,
   AcroForm-`fieldMap` je Stadt), versendet (`services/mail.ts`) und legt die
   ausgehende Mail als erste Zeile in `report_replies` ab. **Ausnahme Städte mit
   `portal` (Frankfurt, Wiesbaden, Mainz – Adapter `services/portale.ts`):** Versand live unter `/versand` (`routes/portal.ts` →
   `services/portalDispatch.ts` → Container `portal`, Playwright,
   `docker/portal/ekom21.mjs`). Mapping Katalog → Portal-Auswahlbaum und
   Pflichtangaben (Variante, Fahrzeugtyp, Hausnummer): `services/portalFfm.ts`.
   Was im Frankfurter Formular fehlt/abweicht: `docs/FRANKFURT-NOTIZEN.md`
   (bei neuen Funden dort ergänzen).
   Trockenläufe gegen das echte Portal sind ok (bis zur Zusammenfassung,
   dann abbrechen) – nie mit echten Fotos Dritter testen, nie absenden.
5. Amts-Antworten: `services/mailInbox.ts` pollt per IMAP, ordnet über
   In-Reply-To/References bzw. `OWiA-\d{6}` im Betreff zu.

**DB/Migrationen:** `src/db/schema.sql` gilt nur für frische Volumes. Jede
Schemaänderung ist eine neue Datei `migrations/NNNN_snake_case.sql`
(fortlaufend; höchste vorhandene Nummer vor jeder Änderung prüfen –
`ls migrations | tail -1`; Stand 08.10.2026: 0041, nächste freie Nummer 0042), idempotent formulieren
(`IF [NOT] EXISTS`) — der Runner (`src/db/migrate.ts`) hat KEINE Transaktion,
ein Fehler beim Boot ist eine bewusste Container-Restart-Schleife. Nichts mehr
in `src/db/init.ts` ergänzen (Legacy).

**Views/Frontend:** EJS serverseitig (`src/views/`, Layout `layout.ejs`,
Handler übergeben immer `viewData(request, {...})` aus `src/middleware/auth.ts`).
Frontend ist buildloses Browser-JS in `public/js/`, Libraries lokal gevendort
in `public/vendor/` — kein CDN, die CSP erzwingt das. **Keine Inline-Scripts
und keine `on*=`-Attribute** (CSP `script-src 'self'` seit 08.10.2026): Logik
in Dateien unter `public/js/`, Serverwerte per `data-*` oder
`<script type="application/json">`, Rückfragen per `data-confirm` (Handler in
`layout.js`). Gemeinsame Helfer (`escapeHtml`, `debounce`, `fetchJson`,
`loadCatalog`, `normalizePlate`) liegen in `public/js/common.js` als `window.OWIA`.

**Sicherheitsringe (server.ts):** Session-Cookie `sameSite=lax` **plus**
Fetch-Metadata-Prüfung (`Sec-Fetch-Site` ≠ cross-site für POST/PUT/PATCH/
DELETE) statt CSRF-Token; Abmelden nur per POST; `trustProxy` nur für
Loopback/private Netze; Fehlerhandler reicht 4xx mit Status durch (JSON bei
`Accept: application/json`), nur 5xx werden als `error` geloggt. `/health`
meldet `warnungen` (Job-Runner, mit `?voll=1` auch Portal/ALPR), bleibt aber
200, solange die DB antwortet.

**Bilder:** Typ wird aus den Bytes bestimmt (`sniffImageType`), nicht aus dem
Client-Mimetype; `decode()` lehnt Bilder über 80 MP anhand des Headers ab.
Alle Dekodierung läuft im Bild-Worker (`intakeImageProcessing.ts`, auch das
öffentliche Pixelbild via `loadPixelated`/`prewarmPublicImages`), nie im
Request. Dateien werden beim Verschieben kopiert → DB → Quelle gelöscht.

## Konventionen

- **Alles Deutsch**: UI-Texte, Kommentare, Flash-Messages, DB-Spalten
  (`kennzeichen`, `tatort`, `verstoss_art`), URL-Pfade (`/anzeigen`,
  `/einstellungen`). Bezeichner/Funktionsnamen Englisch.
- Kommentare sind dicht und erklären das **Warum**, oft Invarianten über
  Dateigrenzen (z.B. Chunk-Größe in `routes/intake.ts` ↔
  `public/js/import-upload.js`, Stadtname in `cities.ts` ↔ `districts.csv`).
  Beim Ändern beide Seiten + Kommentar nachziehen.
- Flash-Messages laufen über ein kurzlebiges Cookie, NICHT über die Session
  (parallele Bild-/Tile-Requests würden Session-Flashes wiederbeleben).
- Externe Dienste (Photon, ALPR, Tileserver) degradieren graceful: `fetch` mit
  `AbortController`-Timeout, Fehler ⇒ `null`/leer statt Exception. In Handlern:
  `try/catch` + `log.error` + deutsche Flash-Message, Redirect trotzdem.
- Foto-Zeitstempel bleiben Strings (`'YYYY-MM-DD HH:MM:SS'`) und gehen nie
  durch ein JS-`Date` (Zeitzonen). Abgeleitete Dateien liegen per
  Namenskonvention neben dem Original (`.thumb.jpg`, `.pixel.jpg`, `.plate.jpg`)
  unter `data/uploads/<userId>/<reportId>/`.
- Datenschutz ist Designbedingung: keine externen Requests, Originalfotos
  verlassen den Host nie, öffentliche Endpoints liefern nur anonymisierte
  Bilder (erkannte Kennzeichen/Gesichter geschwärzt + 160 px, ohne Analyse
  32 px verpixelt; `services/pixelate.ts`) und Aggregate.

## Geprüfter Projektstand

Die Bestandsaufnahme vom 06.10.2026 steht in [docs/PROJEKTSTATUS.md](docs/PROJEKTSTATUS.md).
Für Codex dient [AGENTS.md](AGENTS.md) als Einstieg; diese Datei bleibt gemeinsame
Referenz für Architektur und Konventionen. Betriebsangaben sind Soll-Konfiguration:
Bei der ersten Bestandsaufnahme lief nur der Produktionsstack. Inzwischen laufen
Dev-App, DB und Mailpit wieder. Details und offene Punkte:
[docs/FEHLERBEHEBUNG-2026-10-06.md](docs/FEHLERBEHEBUNG-2026-10-06.md).

Versand erfolgt über `services/reportDispatch.ts`: persistenter Claim vor SMTP,
unklares Ergebnis bleibt gesperrt, bestätigter Versandabschluss ist ohne neue Mail
wiederholbar. Anleitung: [docs/VERSANDBETRIEB.md](docs/VERSANDBETRIEB.md).
Tests: `npm run check` und `npm test` (isolierte Docker-Testumgebung).
