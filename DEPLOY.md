# Deployment & Go-Live-Checkliste

Entwickelt und deployt wird direkt auf dem Server: Die Dev-Arbeitskopie liegt in
`/root/owia/owia-codebase` (eigener Compose-Stack, erreichbar
über `dev.<domain>` / `dev-mail.<domain>` am Prod-Caddy, Basic Auth: Benutzer
`dev`, Passwort in `/root/.owia-dev-basicauth`). Deploy nach Prod
(`/root/owia/owia`) per **`./deploy.sh`** in der Arbeitskopie: rsync + 
`docker compose up -d --build --force-recreate --remove-orphans` + Health-Check.
`data/` und `.env` in Prod werden nie überschrieben. Der frühere
GitHub-Actions-Auto-Deploy bei Push ist deaktiviert (nur noch manuell per
`workflow_dispatch` als Fallback); nach GitHub gepusht wird trotzdem — als
Backup und Referenzstand.

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
REPLY_TRUSTED_DOMAINS=stadt-frankfurt.de

ADMIN_EMAILS=<admin@...>       # leer = NIEMAND kann Anzeigen freigeben!
```

Die Amts-Empfänger kommen aus `resources/districts.csv` über
`src/services/districts.ts`; `MAIL_TO_FRANKFURT` wird vom aktuellen Code nicht
ausgewertet. Empfänger für jede freigeschaltete Stadt vor Versand prüfen.
`REPLY_TRUSTED_DOMAINS` muss die gewünschten Amts-Domains abdecken, wenn
Antworten ohne Message-ID-Bezug automatisch per Aktenzeichen zugeordnet werden
sollen. Der obige Frankfurt-Wert ist nur ein Beispiel.

## Einmalig auf dem Server einrichten

1. **Backups**: Der Nutzer hat am 06.10.2026 bestätigt, dass die gesamte VM
   regelmäßig gesichert wird. Ein Restore wurde durch Codex nicht getestet. Wichtig: `data/mysql`,
   `data/uploads` und `data/pdfs` müssen abgedeckt sein — für einen konsistenten
   DB-Stand idealerweise per `mariadb-dump` statt Datei-Kopie des laufenden
   `data/mysql`.
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

1. `curl -s https://<domain>/health` → `{"ok":true,"jobs":{…},"warnungen":[]}` –
   `warnungen` muss leer sein (sonst: Job-Runner steht, alte Jobs warten oder
   Fehlschläge in der letzten Stunde). `…/health?voll=1` pingt zusätzlich
   Portal- und ALPR-Dienst.
2. `docker compose logs app --tail 20` → keine Fehler, „Posteingang: IMAP-Polling aktiv"
3. Login per Magic-Link funktioniert (Mail kommt an!)
4. Eine Test-Anzeige einreichen → Admin-Mail kommt, unter `/admin/anzeigen` sichtbar
5. Freigabe ausschließlich mit kontrolliertem Testempfänger bzw. in Dev/Mailpit
   prüfen; keinen Test an ein echtes Ordnungsamt schicken. Frankfurt läuft
   über `/versand` (Portal): dort nur bis zur Zusammenfassung testen und
   abbrechen. Bad Soden-Salmünster und Hanau erhalten Beweisfotos und ggf. Karte.
6. `docker compose ps portal` → healthy (Browser-Container für das Frankfurter Portal).

`/health` prüft App und DB-Verbindung, aber weder SMTP/IMAP noch Geocoding,
Karten oder die fachliche Richtigkeit eines Versands. Der manuelle
GitHub-Actions-Fallback enthält derzeit keinen entsprechenden Healthcheck.

## Bewusst offene Punkte (nachrangig)

- Admin kann Anzeigen nur freigeben/ablehnen, nicht selbst korrigieren
- jpeg-Dekodierung läuft synchron im Node-Prozess (sehr große Bilder blockieren kurz)
- Migrationen laufen ohne Transaktion; Fehler beim Boot → Container-Restart-Loop
  (bewusst laut); vor Migrations-Deploys Backup prüfen
- Verwaiste offene Foto-Import-Batches werden nicht automatisch aufgeräumt
- Dockerfile läuft als root und installiert devDependencies mit


## Vor Deployment der Fehlerbehebung vom 06.10.2026

- `npm run check` und `npm test` ausführen; Tests verwenden ihre eigene Compose-Datei.
- Migration `0032_report_dispatch.sql` ist additiv (zwei neue Spalten in `reports`).
  Sie wurde am 06.10.2026 auch in Produktion erfolgreich angewandt.
- Datenbanksicherung und Sicherung der zugehörigen Upload-/PDF-Dateien verifizieren.
  Ein tatsächlicher Restore wurde in dieser Aufgabe nicht durchgeführt.
- Produktionskonfiguration benötigt `MAIL_DRIVER=smtp`, `MAIL_HOST`, `MAIL_FROM`.
- Änderungen committen und erst im Rahmen eines Deployment-Auftrags nach Prod übernehmen.
- Bei einem späteren Code-Rollback dürfen gesperrte Versandvorgänge nicht durch alten
  Code bearbeitet werden: der alte Code kennt `versand_status` nicht.

Zustände und Wiederaufnahme: [docs/VERSANDBETRIEB.md](docs/VERSANDBETRIEB.md).

## Härtung vom 08.10.2026 – was beim nächsten Deploy zu beachten ist

- **Voll-Rebuild nötig** (`docker compose up -d --build`, >7 min, als
  Hintergrund-Task): `package.json` (Fastify 5, Plugins, nodemailer 10 –
  `npm audit`: 0 Lücken), `docker/node/Dockerfile` (läuft als `node`),
  `docker/portal/server.mjs` (idempotente Lauf-IDs), `docker-compose.yml`.
- **Rechte:** `chown -R 1000:1000 data/pdfs data/uploads` im Deploy-Ziel –
  `deploy.sh` macht das jetzt selbst. Ohne chown meldet der Start
  „Datenverzeichnis nicht beschreibbar“ und Uploads/PDFs scheitern.
- **Env:** Der App-Container bekommt nur noch die in `docker-compose.yml`
  gelisteten Variablen (kein `env_file`). Alle bisherigen Prod-Werte sind
  abgedeckt; `DB_ROOT_PASSWORD`/`ACME_EMAIL` sieht die App nicht mehr.
  `REPLY_TRUSTED_DOMAINS` hat jetzt alle fünf Städte als Default.
- **Speichergrenzen:** app 2 GB, db 1,5 GB, photon 1,5 GB
  (alpr 2 GB, portal 1,5 GB wie bisher). Summe liegt unter den 8 GB des Hosts.
- **Verhalten:** Abmelden ist POST; Magic-Link zeigt erst eine
  Bestätigungsseite; Cross-Site-POSTs werden mit 403 abgewiesen; CSP ohne
  `unsafe-inline` für Scripts; öffentliche Karten-Koordinaten auf 3
  Nachkommastellen gerundet; Sticker-Scans zählen keine Bots/Link-Vorschauen.
