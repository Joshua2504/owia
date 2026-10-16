# Deployment & Go-Live-Checkliste

Entwickelt und deployt wird direkt auf dem Server: Die Dev-Arbeitskopie liegt in
`/root/owia/owia-codebase` (eigener Compose-Stack, erreichbar
über `dev.<domain>` / `dev-mail.<domain>` am Prod-Caddy, Basic Auth: Benutzer
`dev`, Passwort in `/root/.owia-dev-basicauth`). Deploy nach Prod
(`/root/owia/owia`) per **`./deploy.sh`** in der Arbeitskopie:

1. `npm run check` (Typecheck, Syntax, Lint, Unit-Tests; `SKIP_CHECK=1` überspringt).
2. Überträgt den **committeten Stand** (`git archive HEAD`, nie den Working
   Tree) per `rsync --checksum --delete` und schreibt die Commit-ID nach
   `REVISION`. `data/`, `.env` und `.env.*` (Backups) im Ziel bleiben unberührt.
3. `chown 1000:1000` für `data/pdfs` + `data/uploads`, Netz `owia-proxy` anlegen.
4. `docker compose up -d --build --force-recreate --remove-orphans` – den
   Dienst `portal` aber **nicht**, solange dort ein Versand läuft (`GET /busy`).
   Images werden nur mit `PULL=1` neu gezogen (alle Tags sind gepinnt).
5. Health-Check auf `127.0.0.1:3000/health`.

Kleiner Weg ohne Rebuild (nur `src/`, `public/`, `resources/`, `migrations/`
geändert): `git archive HEAD | tar -x -C <tmp>`, von dort `rsync -a --checksum`
nach Prod, dann `docker compose restart app` – Migrationen laufen beim Boot.
Ein Voll-Rebuild (Änderungen an `package*.json`, `docker/`, Compose) dauert
über 7 Minuten; als Hintergrundprozess starten.

Der frühere GitHub-Actions-Auto-Deploy bei Push ist deaktiviert
(`deploy.yml`, nur noch manuell per `workflow_dispatch`); nach GitHub gepusht
wird trotzdem — als Backup und Referenzstand, die CI prüft jeden Push.

## Prod-`.env` — Pflichtwerte (vor dem ersten Go-Live prüfen!)

```
NODE_ENV=production            # sonst: /dev/inbound-mail offen, Cookie ohne Secure-Flag
SESSION_SECRET=<openssl rand -hex 32>   # App verweigert Start mit Platzhalter
APP_URL=https://owia.net       # muss https sein (App verweigert Start sonst)
COMPOSE_PROFILES=production    # startet Caddy (HTTPS)
APP_DOMAIN=owia.net
ACME_EMAIL=<mail für Let's Encrypt>

TSX_WATCH=                     # leer = kein Hot-Reload-Watcher in Produktion
APP_BIND=127.0.0.1:3000        # Port 3000 nicht öffentlich (Traffic über Caddy)
MAILPIT_BIND=127.0.0.1:8025    # Mailpit-UI nicht öffentlich

DB_PASSWORD / DB_ROOT_PASSWORD # stark; VOR dem ersten Start setzen (Volume-Init)

MAIL_DRIVER=smtp               # Pflicht in Produktion; falscher Wert verhindert den Start
MAIL_HOST= / MAIL_PORT=587     # 587/STARTTLS oder 465/SMTPS (secure wird bei 465 automatisch gesetzt)
MAIL_USER= / MAIL_PASS=
MAIL_FROM=owia@treudler.net    # Absender = Antwort-Postfach

IMAP_HOST= / IMAP_USER=owia@treudler.net / IMAP_PASS=   # leer = keine Amts-Antworten in der App
# REPLY_TRUSTED_DOMAINS nicht setzen: Default = alle freigeschalteten Städte

ADMIN_EMAILS=<admin@...>       # leer = NIEMAND kann Anzeigen freigeben!
```

Die Amts-Empfänger kommen aus `resources/districts.csv` über
`src/services/districts.ts`; `MAIL_TO_FRANKFURT` wird vom aktuellen Code nicht
ausgewertet. Empfänger für jede freigeschaltete Stadt vor Versand prüfen.
`REPLY_TRUSTED_DOMAINS` (leer = Default aller freigeschalteten Städte in
`services/mailInbox.ts`) muss die Amts-Domains abdecken, wenn Antworten ohne
Message-ID-Bezug automatisch per Aktenzeichen zugeordnet werden sollen – ein
gesetzter Wert ersetzt die Liste.
Zusätzlich muss der eigene Mailserver die Mail positiv authentifiziert haben:
Ausgewertet wird nur der OBERSTE `Authentication-Results`-Header, und nur wenn
er die authserv-id `MAIL_AUTHSERV_ID` trägt (leer = `IMAP_HOST`; Prod/Mailcow:
`mail.treudler.net`) und `dmarc=pass` bzw. ausgerichtetes `dkim=pass`/`spf=pass`
für die From-Domain meldet. Sonst landet die Mail als „nicht zugeordnet“ beim
Admin (`services/mailInbox.ts`, `senderAuthenticated`).

## Einmalig auf dem Server einrichten

1. **Backups**: siehe [Betriebsentscheidungen](#betriebsentscheidungen).
2. **Firewall**: nur 80/443 öffentlich; 3000/8025 sind mit den Bindings oben
   ohnehin nur noch lokal erreichbar.
3. **Shared-Proxy-Netz**: `docker network create owia-proxy` (macht `deploy.sh`
   automatisch). Darüber erreicht der Prod-Caddy die Dev-Container. Die
   Containernamen im Caddyfile (`owia-app-1`, `ffm-owianzeiger-app-1`, …)
   leiten sich aus dem Compose-Projektnamen ab: Prod = Verzeichnisname `owia`,
   Dev = per `COMPOSE_PROJECT_NAME=ffm-owianzeiger` in der Dev-`.env` gepinnt
   (hält auch die benannten Volumes stabil).
4. **DNS** für die Dev-Instanz: A-Records `dev.<domain>` und `dev-mail.<domain>`
   auf die Server-IP; Caddy holt die Zertifikate dann automatisch.
5. Optional: externes Uptime-Monitoring auf `https://<domain>/health`.

## Smoke-Test nach jedem Deploy

1. `curl -s http://127.0.0.1:3000/health` (auf dem Server; von außen liefert
   `/health` nur `{"ok":true}`) → `{"ok":true,"jobs":{…},"warnungen":[]}` –
   `warnungen` muss leer sein (sonst: Job-Runner steht, alte Jobs warten oder
   Fehlschläge in der letzten Stunde). `…/health?voll=1` pingt zusätzlich
   Portal- und ALPR-Dienst.
2. `docker compose logs app --tail 20` → keine Fehler, „Posteingang: IMAP-Polling aktiv"
3. Login per Magic-Link funktioniert (Mail kommt an!)
4. Eine Test-Anzeige einreichen → Admin-Mail kommt, unter `/admin/anzeigen` sichtbar
5. Freigabe ausschließlich mit kontrolliertem Testempfänger bzw. in Dev/Mailpit
   prüfen; keinen Test an ein echtes Ordnungsamt schicken. Portal-Städte
   (Frankfurt, Wiesbaden, Hanau, Mainz, Hamburg) laufen über `/versand`: dort
   nur bis zur Zusammenfassung testen und abbrechen. Bad Soden-Salmünster
   erhält nur Beweisfotos (ohne Karte, Anschrift im Mailtext).
6. `docker compose ps portal` → healthy (Browser-Container für alle Portal-Städte).
7. `cat REVISION` im Prod-Verzeichnis = erwarteter Commit.

`/health` prüft App und DB-Verbindung, aber weder SMTP/IMAP noch Geocoding,
Karten oder die fachliche Richtigkeit eines Versands. Der manuelle
GitHub-Actions-Fallback enthält derzeit keinen entsprechenden Healthcheck.

## Bewusst offene Punkte (nachrangig)

- Admin kann Anzeigen nur freigeben/ablehnen, nicht selbst korrigieren
- Migrationen laufen ohne Transaktion; Fehler beim Boot → Container-Restart-Loop
  (bewusst laut); vor Migrations-Deploys Backup prüfen
- Verwaiste offene Foto-Import-Batches werden nicht automatisch aufgeräumt
- Das App-Image installiert devDependencies mit (tsx wird zur Laufzeit gebraucht)
- Code kommt per Bind-Mount, nicht im Image – es gibt kein unveränderliches
  Release-Artefakt; Rollback = älteren Commit deployen (`git checkout <rev>` in
  einem Worktree, dort `./deploy.sh`). Vor einem Rollback hinter Migration 0032
  offene Versandsperren prüfen ([docs/VERSANDBETRIEB.md](docs/VERSANDBETRIEB.md)).

## Betriebsentscheidungen

- **Backups:** Laut Nutzer (06.10.2026) wird die gesamte VM regelmäßig
  gesichert; ein Restore wurde nicht getestet. `data/mysql`, `data/uploads`
  und `data/pdfs` müssen abgedeckt sein (konsistent idealerweise per `mariadb-dump`).
- **Aufbewahrung:** Nach Kontoschließung bleiben Anzeigen, Originalfotos und
  Importdaten erhalten (keine Volllöschung ohne neuen Auftrag).
- **Speichergrenzen** (Host 8 GB): app 2 GB, db 1,5 GB, photon 1,5 GB, alpr 2 GB,
  portal 1,5 GB (`mem_limit` in `docker-compose.yml`).
- **Env:** Der App-Container bekommt nur die in `docker-compose.yml` unter
  `environment:` gelisteten Variablen (kein `env_file`). Änderungen an der
  Prod-`.env` brauchen `docker compose up -d --no-build app` (ein `restart`
  liest die `.env` nicht neu).
