#!/usr/bin/env bash
# Lokales Deploy: überträgt den COMMITTETEN Stand (git archive HEAD) dieser
# Arbeitskopie nach $DEPLOY_TARGET und startet den Prod-Stack neu. Ersetzt den
# früheren GitHub-Actions-Auto-Deploy (der Workflow existiert nur noch als
# manueller Fallback).
#
# Uncommittete Änderungen (auch WIP paralleler Sitzungen) gelangen so nie nach
# Prod. .env, .env.* (Backups) und data/ im Ziel werden nie angefasst; Dateien,
# die es im Commit nicht mehr gibt, werden im Ziel gelöscht (rsync --delete).
#
#   ./deploy.sh              Prüfen (npm run check), übertragen, neu starten
#   SKIP_CHECK=1 ./deploy.sh ohne npm run check (z. B. Notfall-Rollback)
#   PULL=1 ./deploy.sh       zusätzlich gepinnte Images neu ziehen
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_TARGET="${DEPLOY_TARGET:-/root/owia/owia}"

if [ "$SRC" = "$DEPLOY_TARGET" ]; then
  echo "Abbruch: deploy.sh läuft bereits im Deploy-Ziel ($DEPLOY_TARGET)." >&2
  echo "Das Script gehört in der Dev-Arbeitskopie ausgeführt." >&2
  exit 1
fi

REVISION="$(git -C "$SRC" rev-parse --short HEAD)"
if [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]; then
  echo "Hinweis: uncommittete Änderungen werden NICHT deployt (nur $REVISION):" >&2
  git -C "$SRC" status --short --untracked-files=no >&2
fi

if [ "${SKIP_CHECK:-0}" != "1" ]; then
  echo "==> npm run check"
  (cd "$SRC" && npm run --silent check)
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$SRC" archive HEAD | tar -x -C "$STAGE"
echo "$REVISION" > "$STAGE/REVISION"

echo "==> Sync $REVISION -> $DEPLOY_TARGET"
mkdir -p "$DEPLOY_TARGET"
# --checksum: git archive setzt alle mtimes auf die Commit-Zeit, ohne Prüfsumme
# würden geänderte Dateien gleicher Größe übersehen.
rsync -a --checksum --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.claude/' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --filter='protect .env.*' \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='mobile/' \
  "$STAGE"/ "$DEPLOY_TARGET"/

echo "==> Stack neu starten"
cd "$DEPLOY_TARGET"
mkdir -p data/mysql data/pdfs data/uploads data/photon
# Die App läuft im Container als Nutzer node (UID 1000) – Upload-/PDF-Verzeichnisse
# müssen ihm gehören, sonst „Datenverzeichnis nicht beschreibbar" beim Start.
chown -R 1000:1000 data/pdfs data/uploads
docker network create owia-proxy 2>/dev/null || true

# Images sind in docker-compose.yml auf feste Versionen gepinnt – ein Pull bei
# jedem Deploy ist daher unnötig und würde (bei Tag-Änderungen) ungeplant
# Downloads anstoßen. Nur auf ausdrücklichen Wunsch: PULL=1 ./deploy.sh
if [ "${PULL:-0}" = "1" ]; then
  echo "==> Images aktualisieren (PULL=1)"
  docker compose pull --quiet --ignore-buildable || echo "Warnung: docker compose pull fehlgeschlagen (weiter)." >&2
fi

# Läuft im Portal-Container gerade ein Vorgang (Playwright füllt/sendet ein
# Online-Formular, docker/portal/server.mjs), würde das Recreate ihn
# abbrechen – womöglich nach „Absenden", mit unklarem Ergebnis. Der Dienst hat
# keinen Endpunkt für „aktive Läufe": /health meldet nur die Zahl aller im
# Speicher gehaltenen (auch fertigen) Läufe. Deshalb ein POST /runs ohne
# payload als Sonde – der Server prüft ZUERST das Limit (MAX_ACTIVE = 1) und
# antwortet bei laufendem Vorgang 429, sonst 400 „payload fehlt"; angelegt wird
# dabei nie ein Lauf. Ändert sich diese Reihenfolge im Portal-Server, hier
# nachziehen. Nicht erreichbar/nicht gestartet ⇒ nicht beschäftigt.
portal_beschaeftigt() {
  # Neuer Dienst: GET /busy liefert {busy, aktiv}. Ältere Portal-Images kennen
  # /busy nicht (404) – dann die alte Sonde: POST /runs ohne payload antwortet
  # 429, solange ein Lauf den einzigen Platz belegt, sonst 400 (legt nie einen
  # Lauf an). Nicht erreichbar ⇒ gilt als nicht beschäftigt.
  local status
  status="$(docker compose exec -T portal node -e "
    fetch('http://localhost:8080/busy').then(async r => {
      if (r.ok) return console.log((await r.json()).busy ? 'busy' : 'frei')
      const p = await fetch('http://localhost:8080/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      console.log(p.status === 429 ? 'busy' : 'frei')
    }).catch(() => console.log('fehler'))" 2>/dev/null | tr -d '[:space:]')" || status=''
  [ "$status" = "busy" ]
}

PORTAL_UEBERSPRUNGEN=0
if portal_beschaeftigt; then
  PORTAL_UEBERSPRUNGEN=1
  echo "WARNUNG: Im Portal-Container läuft gerade ein Vorgang (Online-Formular)." >&2
  echo "         Der Portal-Dienst wird NICHT neu erstellt, damit nichts abbricht." >&2
  echo "         Alle anderen Dienste werden aktualisiert." >&2
  # Dienste der aktiven Profile ohne portal (Compose-Syntaxfehler = Abbruch via set -e).
  DIENSTE="$(docker compose config --services | grep -vx portal)"
  # shellcheck disable=SC2086 # bewusst Wortteilung: ein Dienstname je Zeile
  docker compose up -d --build --force-recreate --remove-orphans $DIENSTE
else
  docker compose up -d --build --force-recreate --remove-orphans
fi

echo "==> Smoke-Test /health"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "OK: App ist gesund."
    if [ "$PORTAL_UEBERSPRUNGEN" = "1" ]; then
      echo "WARNUNG: Portal-Dienst wurde NICHT neu erstellt (Vorgang lief) – Änderungen an docker/portal/" >&2
      echo "         und Portal-Code gelten erst nach: cd $DEPLOY_TARGET && docker compose up -d --build --force-recreate portal" >&2
    fi
    exit 0
  fi
  sleep 2
done
echo "FEHLER: /health antwortet nicht – docker compose logs app prüfen!" >&2
exit 1
