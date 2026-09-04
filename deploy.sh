#!/usr/bin/env bash
# Lokales Deploy: synct diese Arbeitskopie nach $DEPLOY_TARGET und startet
# den Prod-Stack neu. Ersetzt den früheren GitHub-Actions-Auto-Deploy
# (der Workflow existiert nur noch als manueller Fallback).
#
# .env und data/ im Ziel werden nie angefasst. Ungeachtet dessen gilt:
# nur committete Stände deployen (git status vorher prüfen)!
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_TARGET="${DEPLOY_TARGET:-/root/owia/owia}"

if [ "$SRC" = "$DEPLOY_TARGET" ]; then
  echo "Abbruch: deploy.sh läuft bereits im Deploy-Ziel ($DEPLOY_TARGET)." >&2
  echo "Das Script gehört in der Dev-Arbeitskopie ausgeführt." >&2
  exit 1
fi

if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  echo "Warnung: Arbeitskopie hat uncommittete Änderungen:" >&2
  git -C "$SRC" status --short >&2
  read -r -p "Trotzdem deployen? [y/N] " answer
  [ "$answer" = "y" ] || exit 1
fi

echo "==> Sync $SRC -> $DEPLOY_TARGET"
mkdir -p "$DEPLOY_TARGET"
rsync -az --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.claude/' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='node_modules/' \
  "$SRC"/ "$DEPLOY_TARGET"/

echo "==> Stack neu starten"
cd "$DEPLOY_TARGET"
mkdir -p data/mysql data/pdfs data/uploads data/photon
docker network create owia-proxy 2>/dev/null || true
docker compose pull --quiet 2>/dev/null || true
docker compose up -d --build --force-recreate --remove-orphans

echo "==> Smoke-Test /health"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "OK: App ist gesund."
    exit 0
  fi
  sleep 2
done
echo "FEHLER: /health antwortet nicht – docker compose logs app prüfen!" >&2
exit 1
