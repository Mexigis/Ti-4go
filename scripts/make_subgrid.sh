#!/usr/bin/env bash
# make_subgrid.sh — Unidad RECORTADOR: sub-grid de misión desde un MDT/CEM.
#
# Patrón geoid (GPS-ORTO): preparación CON RED, campo con POCOS MB. Recorta
# una ventana métrica (extent_m) alrededor de (lon, lat) del raster de
# entrada, la aplana a STRIPS Deflate sin predictor (guía EX-005 de
# geotiff-dem.ts — el visor rechaza tiled/COG y Predictor 3 con mensaje
# accionable) y la empaca como entregable del patrón topopack: ZIP SIN
# manifest con 1× .tif — la ruta 'demzip' del visor lo ingesta directo al
# Motor DEM Real (re-muestreo del terreno → curvas reales).
#
# Uso:
#   bash scripts/make_subgrid.sh <input.tif> <out.zip> <lon> <lat> <extent_m> [nombre]
#
# Ejemplo (CEM 3.0 → sub-grid La Soledad):
#   bash scripts/make_subgrid.sh e11_cem_r15_v4.tif soledad_subgrid.zip \
#        -101.3248 21.0518 6400 soledad_cem15
#
# Requisitos: gdal_translate ≥ 3 · python3 (stdlib zip) · bun (el bbox
# exacto se calcula con el converso Snyder FR-1 del repo, mismo estándar
# del GeoJSON dual — nada de aproximaciones planas locales).
set -euo pipefail
IN=${1:?input.tif}; OUT=${2:?out.zip}; LON=${3:?lon}; LAT=${4:?lat}; EXT=${5:?extent_m}
NAME=${6:-subgrid}
cd "$(dirname "$0")/.."

BBOX=$(LON="$LON" LAT="$LAT" EXT="$EXT" bun -e '
import { wgs84ToUtm14n, utm14nToWgs84 } from "./src/lib/ingest/geojson";
const lon = Number(process.env.LON);
const lat = Number(process.env.LAT);
const ext = Number(process.env.EXT);
const c = wgs84ToUtm14n(lon, lat);
if (!c) throw new Error("centro fuera del dominio UTM 14N (FR-1)");
const h = ext / 2;
const esquinas = [
  utm14nToWgs84(c[0] - h, c[1] + h),
  utm14nToWgs84(c[0] + h, c[1] + h),
  utm14nToWgs84(c[0] - h, c[1] - h),
  utm14nToWgs84(c[0] + h, c[1] - h),
];
if (esquinas.some((e) => !e)) throw new Error("ventana fuera del dominio UTM 14N (FR-1)");
const lons = esquinas.map((e) => e![0]);
const lats = esquinas.map((e) => e![1]);
console.log([Math.min(...lons), Math.max(...lats), Math.max(...lons), Math.min(...lats)].join(" "));
')
read -r W N E S <<< "$BBOX"
echo "[make_subgrid] bbox (Snyder FR-1): W=$W N=$N E=$E S=$S"

TMP="$(mktemp --suffix=.tif)"
trap 'rm -f "$TMP"' EXIT
gdal_translate -q -projwin "$W" "$N" "$E" "$S" -projwin_srs EPSG:4326 \
  -co TILED=NO -co COMPRESS=DEFLATE -co PREDICTOR=1 \
  "$IN" "$TMP"

python3 - "$TMP" "$OUT" "$NAME" <<'PY'
import hashlib, os, sys, zipfile
src, out, name = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    z.write(src, f"{name}.tif")
h = hashlib.sha256(open(out, "rb").read()).hexdigest()
print(f"[make_subgrid] {out} <- {name}.tif ({os.path.getsize(out)/1e6:.2f} MB)")
print(f"[make_subgrid] sha256 (custodia §9): {h}")
PY
