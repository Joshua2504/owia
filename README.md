# 🚗 OWiA-Anzeiger

Web-Anwendung, mit der Bürger:innen **Ordnungswidrigkeiten im ruhenden Verkehr**
(Falschparken, blockierte Rad-/Gehwege, Behindertenparkplätze usw.) rechtssicher
beim zuständigen Ordnungsamt anzeigen können. Aus hochgeladenen Beweisfotos,
GPS-/EXIF-Daten und einer Karten-Verortung entsteht eine vollständige Anzeige,
die – je nach Stadt – über das Online-Portal der Stadt, als amtliches
PDF-Formular oder als strukturierte E-Mail ans Ordnungsamt versendet wird.

Aktuell freigeschaltet: **Frankfurt am Main**, **Wiesbaden** (beide Online-Portal
ekom21), **Mainz** (civento-Formular RLP) und **Hamburg** (Online-Dienst im
Serviceportal, IntelliForm) – jeweils live im Browser ausgefüllt, weil diese
Städte keine Mail-Anzeigen mehr annehmen bzw. Hamburg ausdrücklich um den
Online-Dienst bittet – sowie
**Bad Soden-Salmünster** und **Hanau** (jeweils E-Mail-Versand). Weitere Städte lassen sich über eine
zentrale Registry ergänzen (siehe [Neue Stadt freischalten](#neue-stadt-freischalten)).

---

## Funktionsumfang

- **Anmeldung per Magic-Link** – kein Passwort; Login-Link kommt per E-Mail.
- **Anzeige erstellen** – Beweisfotos hochladen (inkl. HEIC-Konvertierung),
  Tatort per Adresssuche oder Kartenklick verorten, Verstoß und Fahrzeugdaten
  erfassen.
- **Automatische Kennzeichenerkennung** (ALPR, YOLOv9 + fast-plate-ocr über ONNX) – befüllt
  das Kennzeichen-Feld aus dem Beweisfoto vor. Läuft lokal, die Fotos verlassen
  den Host nie.
- **EXIF-/GPS-Auswertung** – Aufnahmezeitpunkt und Position aus den Fotos.
- **Foto-Import in Serie** – viele Fotos auf einmal hochladen und gruppiert zu
  mehreren Anzeigen verarbeiten (Bulk-Intake).
- **Karten** – Adresssuche (Photon), Reverse-Geocoding und Kacheln von
  basemap.de (BKG) über einen eigenen Proxy – der Browser lädt alles same-origin.
- **Prüf-Workflow** – eingereichte Anzeigen landen bei Admins, die sie freigeben
  (Versand ans Ordnungsamt) oder ablehnen.
- **Amts-Antworten in der App** – Antworten des Ordnungsamts werden per IMAP
  abgeholt und der passenden Anzeige zugeordnet (über Aktenzeichen / Message-ID).
- **PDF-Generierung** – amtliches Frankfurter Formular wird per `pdf-lib` befüllt.
- **QR-Sticker** – Nutzer drucken Etikettenbögen mit Einmal-Codes selbst
  (`/sticker`, max. 20 Bögen, neue erst ohne offene Codes), verknüpfen einen
  Code per Scanner oder Handy-Kamera mit der Anzeige; `/S/<code>` zeigt nur
  die öffentlichen Angaben (`services/stickers.ts`, `routes/sticker.ts`).
- **Newsletter** mit Double-Opt-In und optionaler PLZ (Bedarfsanzeige im Admin).
- **DSGVO** – Daten-Export und Konto-Löschung/Anonymisierung durch Nutzer selbst;
  nur technisch notwendige Cookies.
- **Hell/Dunkel-Modus**, responsive (Bootstrap 5).

---

## Technik-Überblick

| Bereich          | Verwendung |
|------------------|------------|
| Laufzeit         | Node.js + TypeScript, ausgeführt via `tsx` |
| Web-Framework    | Fastify (Sessions, Rate-Limit, Helmet, Multipart) |
| Views            | EJS, serverseitig gerendert |
| Frontend         | Bootstrap 5, Leaflet (selbst gehostet, kein CDN) |
| Datenbank        | MariaDB (`mysql2`) + SQL-Migrationen |
| PDF              | `pdf-lib` (AcroForm-Befüllung) |
| Bilder           | `heic-convert`, `exifr`, `jpeg-js`, `pngjs` (Pixelierung) |
| E-Mail           | `nodemailer` (Versand), `imapflow` + `mailparser` (Posteingang) |
| Geodaten         | Photon (Geocoding), basemap.de (Kacheln, via Proxy) |
| Kennzeichen      | eigener ALPR-Dienst (YOLOv9 + fast-plate-ocr über ONNX, CPU-only) |
| Reverse-Proxy    | Caddy (automatisches HTTPS via Let's Encrypt, nur Produktion) |
| Orchestrierung   | Docker Compose |

### Dienste (Docker Compose)

- **app** – die Node/Fastify-Anwendung (Port 3000)
- **db** – MariaDB, initialisiert aus `src/db/schema.sql`
- **mail** – Mailpit (Dev-Mailserver mit Web-UI auf Port 8025)
- **photon** – OSM-Geocoder für die Adresssuche (lädt beim ersten Start den
  Deutschland-Index, mehrere GB)
- **alpr** – Kennzeichenerkennung (Produktion automatisch, Dev opt-in)
- **caddy** – Reverse-Proxy mit HTTPS (nur Produktions-Profil)

---

## Schnellstart (Entwicklung)

Voraussetzung: Docker + Docker Compose.

Auf diesem Server ist `/root/owia/owia-codebase` die Entwicklungsbasis und
`/root/owia/owia` das Produktionsziel. Die folgenden Schritte beschreiben eine
neue Entwicklungsinstallation; vorhandene `.env`-Dateien nicht überschreiben.
Den geprüften Stand und die nächsten Aufgaben enthält [docs/PROJEKTSTATUS.md](docs/PROJEKTSTATUS.md).
Codex liest die Arbeitsregeln in [AGENTS.md](AGENTS.md).

```bash
# 1. Konfiguration anlegen
cp .env.example .env
#    In der .env für lokale Entwicklung mindestens setzen/prüfen:
#      NODE_ENV=development
#      ADMIN_EMAILS=deine@mail.de   (sonst kann niemand Anzeigen freigeben)

# 2. Gemeinsames Proxy-Netz einmalig anlegen, falls noch nicht vorhanden
docker network inspect owia-proxy >/dev/null 2>&1 || docker network create owia-proxy

# 3. Stack starten
docker compose up -d --build

# 4. App öffnen
open http://localhost:3000
```

In der Entwicklung werden E-Mails **nicht** wirklich versendet, sondern landen
in **Mailpit**: <http://localhost:8025>. Dort findet man auch den Magic-Link zum
Anmelden.

### Optional in der Entwicklung

- **Kennzeichenerkennung** einschalten: `COMPOSE_PROFILES=alpr` und
  `ALPR_ENABLED=on` in der `.env`, dann Stack neu starten.
- **Karten-Kacheln** kommen von basemap.de (`src/services/tiles.ts`), ein
  Import ist nicht nötig.
- **Amts-Antwort testen** (Mailpit spricht kein IMAP) – rohe RFC822-Mail einspielen:
  ```bash
  curl -X POST http://localhost:3000/dev/inbound-mail \
    -H 'Content-Type: message/rfc822' --data-binary @mail.eml
  ```

Lokal ohne Docker (nur die App, DB/Dienste müssen laufen):

```bash
npm install
npm run dev      # tsx watch (Hot-Reload)
npm start        # ohne Watch
```

---

## Konfiguration

Alle Einstellungen laufen über Umgebungsvariablen; `.env.example` ist die
maßgebliche, dokumentierte Referenz. Die wichtigsten Gruppen:

- **Datenbank** – `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_ROOT_PASSWORD`
- **App** – `NODE_ENV`, `SESSION_SECRET`, `APP_URL`, `APP_BIND`, `TSX_WATCH`
- **HTTPS / Proxy** – `COMPOSE_PROFILES`, `APP_DOMAIN`, `ACME_EMAIL`
- **Geodaten** – `PHOTON_URL`
- **Kennzeichen** – `ALPR_URL`, `ALPR_ENABLED`, `ALPR_MIN_CONFIDENCE`
- **E-Mail-Versand** – `MAIL_DRIVER` (`mailpit` | `smtp`), `MAIL_HOST`,
  `MAIL_PORT` (587/STARTTLS oder 465/SMTPS), `MAIL_USER`, `MAIL_PASS`,
  `MAIL_FROM`, `MAIL_FROM_NAME`
- **E-Mail-Posteingang (IMAP)** – `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`,
  `IMAP_PASS`, `IMAP_POLL_SECONDS`, `REPLY_TRUSTED_DOMAINS`
- **Admins** – `ADMIN_EMAILS` (kommagetrennt; leer = niemand kann freigeben)

> ⚠️ **Produktion:** `NODE_ENV=production` ist Pflicht – sonst sind Dev-Endpoints
> offen und das Session-Cookie hat kein `Secure`-Flag. Die App **verweigert den
> Start**, wenn `SESSION_SECRET` ein Platzhalter ist oder `APP_URL` nicht `https://`
> ist. `MAIL_DRIVER` muss exakt `smtp` lauten; außerdem müssen `MAIL_HOST` und
> `MAIL_FROM` gesetzt sein. Sonst verweigert die Produktions-App den Start.

Die Go-Live-Checkliste, Pflichtwerte und der Smoke-Test stehen in
[DEPLOY.md](DEPLOY.md).

---

## Empfänger-Adressen & Städte

- Die **Empfänger-Adresse** wird nie fest verdrahtet, sondern immer aus der
  bundesweiten PLZ→Ordnungsamt-Tabelle [`resources/districts.csv`](resources/districts.csv)
  anhand der PLZ des Tatorts ermittelt.
- Welche Städte tatsächlich **freigeschaltet** sind, entscheidet die Registry
  [`src/config/cities.ts`](src/config/cities.ts). Ein erkannter Ort ohne Eintrag
  dort wird als „noch nicht freigeschaltet" abgewiesen.
- Städte **mit** `portal` (Frankfurt, Wiesbaden, Mainz, Hamburg) werden über das Online-Formular der Stadt
  versendet: der Container `portal` (`docker/portal/`, Playwright) füllt es aus,
  der Admin sieht unter `/versand` live zu (zwei Läufe parallel), greift bei
  Bedarf per Klick ins Live-Bild ein und sendet ab; nächtlicher Selbsttest. Je Stadt
  ein Adapter (`src/services/portale.ts` → `portalFfm.ts`, `portalWi.ts`,
  `portalMz.ts`, `portalHh.ts`) und ein Formular-Profil im Dienst (`docker/portal/ekom21.mjs`,
  `mainz.mjs`, Bausteine in `lib.mjs`; Hamburg ist kein civento, sondern IntelliForm
  und fährt den Ablauf in `hamburg.mjs` selbst); Ablauf/Zustände: `src/services/portalDispatch.ts`.
  Lücken im Frankfurter Formular (fehlende Tatbestände/Stufen):
  [docs/FRANKFURT-NOTIZEN.md](docs/FRANKFURT-NOTIZEN.md).
- Städte **ohne** `portal` und **mit** `pdfForm` bekommen das amtliche Formular
  als PDF-Anhang, Städte **ohne** beides eine strukturierte E-Mail mit
  Beweisfotos + Tatort-Karte.

### Neue Stadt freischalten

1. Eintrag in [`src/config/cities.ts`](src/config/cities.ts) ergänzen – Ortsname
   **exakt** wie in `districts.csv`.
2. Optional ein amtliches PDF-Formular unter `resources/` ablegen und als
   `pdfForm` referenzieren; AcroForm-Feldnamen mit
   `curl http://localhost:3000/debug/pdf-fields` (nur Dev) auslesen und in
   [`src/services/pdf.ts`](src/services/pdf.ts) (`fieldMap`) eintragen.
3. Stadtgrenze als `resources/boundaries/<id>.geojson` ablegen (OSM-Verwaltungs-
   grenze), damit die Karten den Umriss zeichnen.

---

## Datenbank & Migrationen

- Das Basis-Schema liegt in [`src/db/schema.sql`](src/db/schema.sql) und wird beim
  ersten Start des DB-Containers eingespielt.
- Schemaänderungen kommen als nummerierte SQL-Dateien in
  [`migrations/`](migrations/) und werden beim App-Start vom Migrations-Runner
  angewendet – **keine** inline-`ALTER`s.
- Migrationen laufen ohne umschließende Transaktion; ein Fehler beim Boot führt
  bewusst zu einem lauten Container-Restart. Vor Migrations-Deploys ein Backup
  prüfen.

---

## Projektstruktur

```
src/
  server.ts          Einstieg: Fastify-Setup, Sicherheits-Header, Hooks, Routen
  config/            Städte-Registry, Verstoß-Katalog, Admin-Konfiguration
  db/                Verbindung, Schema, Migrations-Runner, Session-Store
  middleware/        Authentifizierung, View-Daten
  routes/            HTTP-Routen (auth, reports, intake, admin, geo, tiles, …)
  services/          Fachlogik (ALPR, PDF, Mail, Geocoding, Bilder, EXIF, …)
  views/             EJS-Templates
migrations/          Nummerierte SQL-Migrationen
resources/           districts.csv, PDF-Formular, GeoJSON-Grenzen
public/              Statische Assets (CSS, JS, selbst gehostete Vendor-Libs)
docker/              Dockerfiles (node, alpr) und Caddyfile
data/                Persistente Volumes (mysql, uploads, pdfs, photon)  – nicht im Repo
```

---

## Deployment

Deploy läuft direkt auf dem Server: In der Dev-Arbeitskopie **`./deploy.sh`**
ausführen — das rsynct den Stand ins Prod-Verzeichnis, führt
`docker compose up -d --build --force-recreate` aus und macht einen Health-Check.
`data/` und `.env` in Prod bleiben unberührt. Der GitHub-Actions-Workflow
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) ist nur noch
ein manueller Fallback (`workflow_dispatch`); gepusht wird trotzdem — als
Backup und Referenzstand.

Details, Pflichtwerte und der Smoke-Test nach jedem Deploy: **[DEPLOY.md](DEPLOY.md)**.

Healthcheck für Monitoring: `GET /health` → `{"ok":true}`.


## Qualitätsprüfungen

```bash
npm run check   # TypeScript inkl. Tests, Browser-JS und EJS-Syntax
npm test        # Regressionstests mit eigener MariaDB und Mailpit (Docker nötig)
```

Die Testumgebung ist flüchtig, verwendet keine vorhandenen Daten oder `.env` und
hat keinen Internetzugang für Mailversand. Die CI unter
`.github/workflows/check.yml` führt dieselben Prüfungen aus.
Die Entwicklungs-App mit DB/Mailpit läuft wieder; Kartendienste/ALPR sind separat zu starten.

Versandfehler und Wiederaufnahme: [docs/VERSANDBETRIEB.md](docs/VERSANDBETRIEB.md).
Umsetzungsstand: [docs/FEHLERBEHEBUNG-2026-10-06.md](docs/FEHLERBEHEBUNG-2026-10-06.md).
