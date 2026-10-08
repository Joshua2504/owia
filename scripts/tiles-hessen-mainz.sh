#!/bin/bash
# Kartendaten Hessen + Mainz (RLP-Ausschnitt) kombinieren und in ein NEUES Volume
# importieren (owia_osm-tile-data-neu). Prod-Tileserver bleibt währenddessen
# unverändert. Danach tauschen (Karte ~1 min weg):
#   docker compose stop tileserver
#   docker run --rm -v owia_osm-tile-data-neu:/from -v owia_osm-tile-data:/to alpine sh -c "rm -rf /to/* && cp -a /from/. /to/"
#   docker run --rm -v owia_osm-tile-cache:/c alpine sh -c "rm -rf /c/*"
#   docker compose start tileserver
# Speicher begrenzt (Server hat 8 GB): osmium 2,8 GB, Import 2,5 GB / 2 CPUs.
# Erster Lauf 2026-10-08: ~15 min, 11,8 GB.
set -euo pipefail
D=${TILES_WORKDIR:-/root/owia/work/tiles}
mkdir -p "$D"
cd $D
echo "== Download $(date)"
[ -s hessen.osm.pbf ] || curl -sSfL -o hessen.osm.pbf https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf
[ -s rlp.osm.pbf ] || curl -sSfL -o rlp.osm.pbf https://download.geofabrik.de/europe/germany/rheinland-pfalz-latest.osm.pbf
ls -la *.pbf
echo "== Ausschnitt Mainz + Merge $(date)"
docker run --rm --memory 2800m -v $D:/data debian:bookworm-slim bash -c "
  apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null &&
  osmium extract --overwrite -s simple -b 8.05,49.88,8.45,50.10 --set-bounds /data/rlp.osm.pbf -o /data/mainz.osm.pbf &&
  osmium merge --overwrite /data/hessen.osm.pbf /data/mainz.osm.pbf -o /data/combined.osm.pbf &&
  osmium fileinfo /data/combined.osm.pbf | head -20"
echo "== Import in Volume owia_osm-tile-data-neu $(date)"
docker volume create owia_osm-tile-data-neu >/dev/null
docker run --rm --memory 2500m --cpus 2 --shm-size=512m -e THREADS=2 -e "OSM2PGSQL_EXTRA_ARGS=-C 800" -v owia_osm-tile-data-neu:/data/database/ -v $D/combined.osm.pbf:/data/region.osm.pbf \
  overv/openstreetmap-tile-server import
docker run --rm -v owia_osm-tile-data-neu:/d alpine ls -la /d
echo "== Fertig $(date)"
