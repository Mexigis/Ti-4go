#!/usr/bin/env bash
# make_roads_vectorpack.sh — EX-vectorial: puerto de capas de carreteras al
# patrón del visor (directiva checkpoint «Agenda §2 ACEPTADA», trace
# , unidad a).
#
# EX-005 vectorial: la reproyección pesada (LCC⇒UTM14N / geográfico⇒UTM14N)
# vive AQUÍ (ogr2ogr / PROJ — preparación CON RED), JAMÁS en el navegador.
# El producto es una unidad de campo pequeña (ZIP patrón topopack:
# .shp+.shx+.dbf+.prj+.cpg en UTM 14N) que el canal 'vectorpack' del visor
# ingesta, convierte vértice a vértice con el converso Snyder FR-1 del repo
# (ingest/geojson.ts) y DRAPEA sobre el MDT real (DRAPE-1) — verificación
# cruzada de las curvas: una carretera no trepa el valle; la tríada completa
# queda visible en el visor (CEM ✓ + vectorial ✓ + GPS/orto ✓).
#
# DOS MODOS según el insumo:
#   A) Shapefile estatal (p. ej. Red de Carreteras INEGI e11, LCC-2SP
#      ITRF92): iconv del .prj latin-1⇒UTF-8 (el prj crudo rompe PROJ),
#      reproyección completa LCC⇒EPSG:32614 y recorte con -clipsrc rect.
#      GUARD honesto: si la fuente trae registros NULL-shape (hallazgo
#      2026-10-02: e11 v4 trae 17 en la cuenca — atributos sin geometría),
#      ABORTA sin empacar nada.
#   B) GeoPackage nacional (p. ej. RNC 2025 `red_vial`, EPSG:6365
#      geográfico — el MISMO datum del CEM 3.0): un solo ogr2ogr con -spat
#      (bbox en grados, Snyder FR-1) + -t_srs EPSG:32614. Los segmentos
#      viajan COMPLETOS (sin clip de geometría) para que Σ aristas ≈
#      Σ LONGITUD sea una verificación cruzada real de la ficha.
#
# Uso:
#   bash scripts/make_roads_vectorpack.sh <dir_shp | capa.gpkg | capa.zip> \
#        <out.zip> [nombre] [lon] [lat] [extent_m] [capa_gpkg]
#
# Ejemplos:
#   # A — estatal e11 (LCC): 17 registros sin geometría ⇒ aborta honesto
#   bash scripts/make_roads_vectorpack.sh upload/pointlinrs/conjunto_de_datos \
#        out.zip soledad_carreteras -101.3248 21.0518 6400
#   # B — RNC 2025 nacional (geográfico): red_vial real de la cuenca
#   bash scripts/make_roads_vectorpack.sh upload/pointlinrs/794551163030_gpk.zip \
#        upload/soledad_carreteras_vectorpack.zip soledad_carreteras \
#        -101.3248 21.0518 6400 red_vial
#
# Requisitos: ogr2ogr ≥ 3 · iconv · bun (bbox Snyder FR-1 con el converso
# del repo) · python3 (stdlib zip, STORED).
set -euo pipefail
IN=${1:?insumo: dir_shp | capa.gpkg | capa.zip}
OUT=${2:?out.zip}
NAME=${3:-carreteras}
LON=${4:--101.3248}
LAT=${5:-21.0518}
EXT=${6:-6400}
GPKGLAYER=${7:-}
cd "$(dirname "$0")/.."

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

# bbox geográfico de misión — converso Snyder FR-1 del repo (mismo
# estándar que make_subgrid: nada de aproximaciones planas locales)
read -r W N E S <<< "$(LON="$LON" LAT="$LAT" EXT="$EXT" bun -e '
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
')"
echo "[ex-vectorial] bbox (Snyder FR-1): W=$W N=$N E=$E S=$S"

case "$IN" in
  */|*.zip|*.gpkg)
    # ---- MODO B: GeoPackage nacional (geográfico ⇒ UTM 14N) ------------
    case "$IN" in
      *.zip)
        # /vsizip exige la ruta del MIEMBRO gpkg dentro del zip
        MEMBER=$(python3 - "$IN" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
gpkg = [i.filename for i in z.infolist() if i.filename.lower().endswith(".gpkg")]
if not gpkg:
    sys.exit(f"sin .gpkg dentro de {sys.argv[1]}")
print(gpkg[0])
PY
)
        SRC="/vsizip/$IN/$MEMBER"
        echo "[ex-vectorial] miembro gpkg: $MEMBER"
        ;;
      *) SRC="$IN" ;;
    esac
    LAYER=${GPKGLAYER:?modo gpkg: pasa el nombre de la capa (7º arg)}
    echo "[ex-vectorial] modo B · gpkg: $SRC · capa: $LAYER"
    ogr2ogr -q -f "ESRI Shapefile" "$TMPD/$NAME.shp" "$SRC" "$LAYER" \
      -spat "$W" "$S" "$E" "$N" -t_srs EPSG:32614 -lco ENCODING=UTF-8
    # Segmentos COMPLETOS: sin clip de geometría ⇒ Σ aristas ≈ Σ LONGITUD.
    ;;
  *)
    # ---- MODO A: shapefile estatal (LCC ⇒ UTM 14N) ----------------------
    SHP=$(ls "$IN"/*.shp | head -1)
    BASE=$(basename "$SHP" .shp)
    echo "[ex-vectorial] modo A · shapefile: $BASE ($(du -h "$SHP" | cut -f1))"
    mkdir "$TMPD/in"
    cp "$IN/$BASE.shp" "$IN/$BASE.shx" "$IN/$BASE.dbf" "$TMPD/in/"
    iconv -f LATIN1 -t UTF-8 "$IN/$BASE.prj" > "$TMPD/in/$BASE.prj"
    ogr2ogr -q -f "ESRI Shapefile" "$TMPD/utm.shp" "$TMPD/in/$BASE.shp" \
      -t_srs EPSG:32614 -lco ENCODING=UTF-8
    # bbox UTM14N del recorte: las 4 esquinas geográficas ⇒ UTM, min/max
    read -r MIN_E MIN_N MAX_E MAX_N <<< "$(LON="$LON" LAT="$LAT" EXT="$EXT" bun -e '
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
const utms = esquinas.map((e) => {
  if (!e) throw new Error("ventana fuera del dominio UTM 14N (FR-1)");
  const u = wgs84ToUtm14n(e[0], e[1]);
  if (!u) throw new Error("esquina fuera del dominio UTM 14N (FR-1)");
  return u;
});
const Es = utms.map((u) => u[0]);
const Ns = utms.map((u) => u[1]);
console.log(Math.min(...Es), Math.min(...Ns), Math.max(...Es), Math.max(...Ns));
')"
    echo "[ex-vectorial] bbox UTM14N: E $MIN_E…$MAX_E · N $MIN_N…$MAX_N"
    ogr2ogr -q -f "ESRI Shapefile" "$TMPD/$NAME.shp" "$TMPD/utm.shp" \
      -clipsrc "$MIN_E" "$MIN_N" "$MAX_E" "$MAX_N" -lco ENCODING=UTF-8
    ;;
esac

# ---- Guard honesto: nada se empaca vacío ni con geometrías nulas -------
COUNT=$(ogrinfo -so -al "$TMPD/$NAME.shp" 2>/dev/null | sed -n 's/^.*Feature Count: \([0-9][0-9]*\)$/\1/p' | head -1)
NULLS=$(ogrinfo "$TMPD/$NAME.shp" -dialect sqlite -sql "SELECT COUNT(*) AS n FROM ${NAME} WHERE geometry IS NULL" 2>/dev/null | grep -A 1 'n (Integer)' | sed -n 's/^.*= //p' | head -1)
echo "[ex-vectorial] features: ${COUNT:-0} · geometrías nulas: ${NULLS:-0}"
if [ "${COUNT:-0}" -eq 0 ]; then
  echo "[ex-vectorial] FALLO honesto: 0 features en el recorte — revisar bbox/insumo" >&2
  exit 1
fi
if [ "${NULLS:-0}" -gt 0 ]; then
  echo "[ex-vectorial] FALLO honesto: $NULLS registros SIN geometría en la fuente (hallazgo e11 v4: atributos sin línea — nada se empaca ni se inventa)" >&2
  exit 1
fi
ogrinfo -so -al "$TMPD/$NAME.shp" | sed -n '1,12p'

# ---- Empaque patrón topopack (ZIP STORED sin manifest) + sha256 ---------
python3 - "$TMPD" "$NAME" "$OUT" <<'PY'
import hashlib, os, sys, zipfile
d, name, out = sys.argv[1], sys.argv[2], sys.argv[3]
exts = [".shp", ".shx", ".dbf", ".prj", ".cpg"]
with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
    for e in exts:
        p = os.path.join(d, name + e)
        if os.path.exists(p):
            z.write(p, name + e)
h = hashlib.sha256(open(out, "rb").read()).hexdigest()
print(f"[ex-vectorial] {out} ({os.path.getsize(out)/1024:.1f} KB)")
print(f"[ex-vectorial] sha256 (custodia §9): {h}")
PY
