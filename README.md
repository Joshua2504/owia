# 🚗 OWiA-Anzeiger

Web-Anwendung, mit der Bürger:innen **Ordnungswidrigkeiten im ruhenden Verkehr**
(Falschparken, blockierte Rad-/Gehwege, Behindertenparkplätze usw.) rechtssicher
beim zuständigen Ordnungsamt anzeigen können. Aus hochgeladenen Beweisfotos,
GPS-/EXIF-Daten und einer Karten-Verortung entsteht eine vollständige Anzeige,
die – je nach Stadt – als amtliches PDF-Formular oder als strukturierte E-Mail
ans Ordnungsamt versendet wird.

Aktuell freigeschaltet: **Frankfurt am Main** (amtliches PDF-Formular) und
**Bad Soden-Salmünster** (E-Mail-Versand). Weitere Städte lassen sich über eine
zentrale Registry ergänzen (siehe [Neue Stadt freischalten](#neue-stadt-freischalten)).

---

## Funktionsumfang

- **Anmeldung per Magic-Link** – kein Passwort; Login-Link kommt per E-Mail.
- **Anzeige erstellen** – Beweisfotos hochladen (inkl. HEIC-Konvertierung),
  Tatort per Adresssuche oder Kartenklick verorten, Verstoß und Fahrzeugdaten
  erfassen.
- **Automatische Kennzeichenerkennung** (ALPR, YOLOv11 + PaddleOCR) – befüllt
  das Kennzeichen-Feld aus dem Beweisfoto vor. Läuft lokal, die Fotos verlassen
  den Host nie.
- **EXIF-/GPS-Auswertung** – Aufnahmezeitpunkt und Position aus den Fotos.
- **Foto-Import in Serie** – viele Fotos auf einmal hochladen und gruppiert zu
  mehreren Anzeigen verarbeiten (Bulk-Intake).
- **Karten** – Adresssuche (Photon), Reverse-Geocoding und selbst gehostete
  OSM-Kacheln, alles same-origin ohne externe Requests.
- **Prüf-Workflow** – eingereichte Anzeigen landen bei Admins, die sie freigeben
  (Versand ans Ordnungsamt) oder ablehnen.
- **Amts-Antworten in der App** – Antworten des Ordnungsamts werden per IMAP
  abgeholt und der passenden Anzeige zugeordnet (über Aktenzeichen / Message-ID).
- **PDF-Generierung** – amtliches Frankfurter Formular wird per `pdf-lib` befüllt.
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
| Geodaten         | Photon (Geocoding), OSM-Tileserver (Kacheln) |
| Kennzeichen      | eigener ALPR-Dienst (YOLOv11 + PaddleOCR, CPU-only) |
| Reverse-Proxy    | Caddy (automatisches HTTPS via Let's Encrypt, nur Produktion) |
| Orchestrierung   | Docker Compose |

### Dienste (Docker Compose)

- **app** – die Node/Fastify-Anwendung (Port 3000)
- **db** – MariaDB, initialisiert aus `src/db/schema.sql`
- **mail** – Mailpit (Dev-Mailserver mit Web-UI auf Port 8025)
- **photon** – OSM-Geocoder für die Adresssuche (lädt beim ersten Start den
  Deutschland-Index, mehrere GB)
- **tileserver** – OSM-Raster-Tileserver (Hessen); importiert beim ersten Start
  automatisch die Render-DB (~10–30 Min)
- **alpr** – Kennzeichenerkennung (Produktion automatisch, Dev opt-in)
- **caddy** – Reverse-Proxy mit HTTPS (nur Produktions-Profil)

---

## Schnellstart (Entwicklung)

Voraussetzung: Docker + Docker Compose.

```bash
# 1. Konfiguration anlegen
cp .env.example .env
#    In der .env für lokale Entwicklung mindestens setzen/prüfen:
#      NODE_ENV=development
#      ADMIN_EMAILS=deine@mail.de   (sonst kann niemand Anzeigen freigeben)

# 2. Stack starten
docker compose up -d --build

# 3. App öffnen
open http://localhost:3000
```

In der Entwicklung werden E-Mails **nicht** wirklich versendet, sondern landen
in **Mailpit**: <http://localhost:8025>. Dort findet man auch den Magic-Link zum
Anmelden.

### Optional in der Entwicklung

- **Kennzeichenerkennung** einschalten: `COMPOSE_PROFILES=alpr` und
  `ALPR_ENABLED=on` in der `.env`, dann Stack neu starten.
- **Karten-Kacheln** – der Tileserver braucht einmalig einen Import:
  ```bash
  docker compose run --rm tileserver import
  ```
  Bis der Import fertig ist, liefert `/tiles` leere Kacheln (die App blockiert nicht).
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
- **Geodaten** – `PHOTON_URL`, `TILESERVER_URL`
- **Kennzeichen** – `ALPR_URL`, `ALPR_ENABLED`, `ALPR_MIN_CONFIDENCE`
- **E-Mail-Versand** – `MAIL_DRIVER` (`mailpit` | `smtp`), `MAIL_HOST`,
  `MAIL_PORT` (587/STARTTLS), `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`, `MAIL_FROM_NAME`
- **E-Mail-Posteingang (IMAP)** – `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`,
  `IMAP_PASS`, `IMAP_POLL_SECONDS`, `REPLY_TRUSTED_DOMAINS`
- **Admins** – `ADMIN_EMAILS` (kommagetrennt; leer = niemand kann freigeben)

> ⚠️ **Produktion:** `NODE_ENV=production` ist Pflicht – sonst sind Dev-Endpoints
> offen und das Session-Cookie hat kein `Secure`-Flag. Die App **verweigert den
> Start**, wenn `SESSION_SECRET` ein Platzhalter ist oder `APP_URL` nicht `https://`
> ist. `MAIL_DRIVER` muss exakt `smtp` lauten – jeder andere Wert fällt still auf
> Mailpit zurück, und keine Mail erreicht echte Empfänger.

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
- Städte **mit** `pdfForm` bekommen das amtliche Formular als PDF-Anhang
  (Frankfurt), Städte **ohne** eine strukturierte E-Mail mit Beweisfotos +
  Tatort-Karte.

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

Deploy erfolgt automatisch: Push auf `main` → GitHub Actions
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) rsynct den Stand
auf den Server und führt `docker compose up -d --build` aus. `data/` und `.env`
auf dem Server bleiben unberührt.

Details, Pflichtwerte und der Smoke-Test nach jedem Deploy: **[DEPLOY.md](DEPLOY.md)**.

Healthcheck für Monitoring: `GET /health` → `{"ok":true}`.
