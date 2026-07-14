# Deployment & Go-Live-Checkliste

Deploy läuft automatisch: Push auf `main` → GitHub Actions rsynct den Stand auf
den Server und führt `docker compose up -d --build --force-recreate --remove-orphans` aus.
`data/` und `.env` auf dem Server werden nie überschrieben.

## Prod-`.env` — Pflichtwerte (vor dem ersten Go-Live prüfen!)

```
NODE_ENV=production            # sonst: /dev/inbound-mail offen, Cookie ohne Secure-Flag
SESSION_SECRET=<openssl rand -hex 32>   # App verweigert Start mit Platzhalter
APP_URL=https://owia.treudler.net       # muss https sein (App verweigert Start sonst)
COMPOSE_PROFILES=production    # startet Caddy (HTTPS)
APP_DOMAIN=owia.treudler.net
ACME_EMAIL=<mail für Let's Encrypt>

TSX_WATCH=                     # leer = kein Hot-Reload-Watcher in Produktion
APP_BIND=127.0.0.1:3000        # Port 3000 nicht öffentlich (Traffic über Caddy)
MAILPIT_BIND=127.0.0.1:8025    # Mailpit-UI nicht öffentlich

DB_PASSWORD / DB_ROOT_PASSWORD # stark; VOR dem ersten Start setzen (Volume-Init)

MAIL_DRIVER=smtp               # exakt "smtp" – alles andere fällt still auf Mailpit zurück!
MAIL_HOST= / MAIL_PORT=587     # 587/STARTTLS; Port 465 wird nicht unterstützt
MAIL_USER= / MAIL_PASS=
MAIL_FROM=owia@treudler.net    # Absender = Antwort-Postfach
MAIL_TO_FRANKFURT=<VERIFIZIERTE Adresse des Ordnungsamts>  # sonst greift der Code-Fallback –
                               # falsche Adresse = Anzeigen verschwinden lautlos!

IMAP_HOST= / IMAP_USER=owia@treudler.net / IMAP_PASS=   # leer = keine Amts-Antworten in der App
REPLY_TRUSTED_DOMAINS=stadt-frankfurt.de

ADMIN_EMAILS=<admin@...>       # leer = NIEMAND kann Anzeigen freigeben!
```

## Einmalig auf dem Server einrichten

1. **Backup-Cron** (Pflicht — ohne Backup ist ein Plattendefekt Totalverlust aller
   Anzeigen und Beweisfotos):
   ```
   30 3 * * * cd /pfad/zum/projekt && BACKUP_DIR=/var/backups/owia ./scripts/backup.sh >> /var/log/owia-backup.log 2>&1
   ```
   `BACKUP_DIR` sollte auf einem anderen Datenträger liegen oder anschließend
   extern gesynct werden (rsync/rclone).
2. **Firewall**: nur 80/443 öffentlich; 3000/8025 sind mit den Bindings oben
   ohnehin nur noch lokal erreichbar.
3. Optional: externes Uptime-Monitoring auf `https://<domain>/health`.

## Smoke-Test nach jedem Deploy

1. `curl -s https://<domain>/health` → `{"ok":true}`
2. `docker compose logs app --tail 20` → keine Fehler, „Posteingang: IMAP-Polling aktiv"
3. Login per Magic-Link funktioniert (Mail kommt an!)
4. Eine Test-Anzeige einreichen → Admin-Mail kommt, unter `/admin/anzeigen` sichtbar
5. Freigeben → Mail (mit PDF) beim Ordnungsamt-Postfach-Test bzw. in Kopie beim Nutzer

## Bewusst offene Punkte (nachrangig)

- Admin kann Anzeigen nur freigeben/ablehnen, nicht selbst korrigieren
- jpeg-Dekodierung läuft synchron im Node-Prozess (sehr große Bilder blockieren kurz)
- Migrationen laufen ohne Transaktion; Fehler beim Boot → Container-Restart-Loop
  (bewusst laut); vor Migrations-Deploys Backup prüfen
- Verwaiste offene Foto-Import-Batches werden nicht automatisch aufgeräumt
- Dockerfile läuft als root und installiert devDependencies mit
