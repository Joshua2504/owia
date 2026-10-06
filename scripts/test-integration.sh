#!/usr/bin/env bash
# Keine Produktions-.env laden. Nur die explizite Test-Compose-Datei verwenden.
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_PROJECT="owia-tests-${CI_JOB_ID:-$$}"
compose=(docker compose --env-file /dev/null -p "$TEST_PROJECT" -f compose.test.yml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null; }
trap cleanup EXIT
"${compose[@]}" run --rm tests
