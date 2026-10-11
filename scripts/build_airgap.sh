#!/usr/bin/env bash
# build_airgap.sh — #4 opción (b) · build de export estático air-gap
# (directriz del propietario; prioridad elevada: independencia de custodia
#  respecto de la continuidad del entorno de desarrollo).
#
# Qué hace (determinista, re-ejecutable):
#   1. RETIENE src/app/api (mv atómico + trap EXIT que SIEMPRE restaura).
#   2. Construye con AIRGAP_EXPORT=1: distDir aislado (.next-airgap) — el
#      build NUNCA toca .next del dev server — y output: "export" (out/).
#   3. Sella el artefacto: LEEME-CLASIFICACION.txt ([RESTRIGIDO]) + manifiesto
#      SHA-256 interno (formato `sha256sum -c`).
#   4. Mueve el artefacto a downloads/airgap-export/ (reemplaza el anterior).
#   5. Regenera EX-006 (downloads cambió) y emite la huella del repo.
#
# Uso: bash scripts/build_airgap.sh
set -euo pipefail

cd "$(dirname "$0")/.."

STAMP="$(date -u '+%Y%m%d-%H%M%S')"
API_DIR="src/app/api"
HELD=".airgap-held/api"
OUT="out"
DEST_ROOT="downloads/airgap-export"

echo "[airgap] #4 opción (b) — build de export estático air-gap (${STAMP})"

# ── 1. retención del endpoint /api/ingest (degradación aprobada) ──
if [ -d "$API_DIR" ]; then
  mkdir -p .airgap-held
  rm -rf "$HELD"
  mv "$API_DIR" "$HELD"
fi
restore_api() {
  if [ -d "$HELD" ] && [ ! -d "$API_DIR" ]; then
    mv "$HELD" "$API_DIR"
    echo "[airgap] /api restaurada tras el build"
  fi
  rm -rf .airgap-held
}
trap restore_api EXIT

# ── 2. build aislado ──
rm -rf .next-airgap "$OUT"
AIRGAP_EXPORT=1 AIRGAP_DISTDIR=.next-airgap ./node_modules/.bin/next build

# ── 3. sellado del artefacto ──
# Next ≤15 exporta a out/; Next ≥16 con distDir propio exporta DENTRO de
# .next-airgap (sin subdir out/). Detección por prueba de index.html:
if [ -f "$OUT/index.html" ]; then
  ARTIFACT="$OUT"
elif [ -f ".next-airgap/index.html" ]; then
  ARTIFACT=".next-airgap"
else
  echo "[airgap] ERROR: no se encontró el export (ni out/ ni .next-airgap/)" >&2
  exit 1
fi
echo "[airgap] export detectado en: $ARTIFACT"

# ── 2b. FR-8 · custodia + precache del SW (spec §3.6 — ANTES del sellado,
#        para que el MANIFIESTO cubra sw.js parcheado + custodia.json) ──
PIN="$(git rev-parse --short=12 HEAD)"
HEAD_FULL="$(git rev-parse HEAD)"
STAMP_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cat > "$ARTIFACT/custodia.json" <<EOF
{"pin":"${PIN}","head":"${HEAD_FULL}","stampUtc":"${STAMP_UTC}","generator":"Ti-4GO SDK v1.0.0"}
EOF
echo "[airgap] custodia.json: pin ${PIN} (S6 — enlaza repo-manifiesto + cadena snapshot)"

# Precache (§3.6.2): shell + static + identidad + custodia + fixtures sintéticas.
# Presupuesto duro: ≤ 60 archivos / ≤ 25 MB (R2) — el build FALLA si se excede.
PRECACHE_LIST="$(cd "$ARTIFACT" && {
  for f in index.html 404.html logo.svg manifest.webmanifest custodia.json \
           lzw.tif deflate.tif uncompressed_le.tif; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  find _next/static -type f 2>/dev/null || true
} | LC_ALL=C sort -u)"
PRECACHE_COUNT="$(printf '%s\n' "$PRECACHE_LIST" | grep -c . || true)"
if [ "$PRECACHE_COUNT" -gt 60 ]; then
  echo "[airgap] ERROR: precache ${PRECACHE_COUNT} archivos > presupuesto 60 (R2)" >&2
  exit 1
fi
PRECACHE_BYTES="$(cd "$ARTIFACT" && printf '%s\n' "$PRECACHE_LIST" | xargs -d '\n' du -cb 2>/dev/null | tail -1 | cut -f1)"
if [ "${PRECACHE_BYTES:-0}" -gt $((25 * 1024 * 1024)) ]; then
  echo "[airgap] ERROR: precache $((PRECACHE_BYTES / 1024 / 1024)) MB > presupuesto 25 MB (R2)" >&2
  exit 1
fi
if [ ! -f "$ARTIFACT/sw.js" ]; then
  echo "[airgap] ERROR: falta sw.js en el artefacto (public/sw.js no exportado)" >&2
  exit 1
fi
PRECACHE_JSON="$(printf '%s\n' "$PRECACHE_LIST" | awk 'BEGIN{printf "["} {printf "%s\"/%s\"", (NR>1?",":""), $0} END{printf "]"}')"
awk -v pin="$PIN" -v pre="$PRECACHE_JSON" \
  '{ gsub(/__CACHE_PIN__/, pin); gsub(/__PRECACHE__/, pre); print }' \
  "$ARTIFACT/sw.js" > "$ARTIFACT/sw.js.tmp" && mv "$ARTIFACT/sw.js.tmp" "$ARTIFACT/sw.js"
echo "[airgap] sw.js parcheado: cache ti4go-a-${PIN} · precache ${PRECACHE_COUNT} archivos ($((PRECACHE_BYTES / 1024)) KiB — A8-1)"

# ── 2c. E2E DORADO · fixture del pack completo (fuera del precache del SW —
#        whitelist §3.4 intacta; lo sirve el http.server estático) ──
FIXTURE_SRC="downloads/qa-fixtures/mision_fr5_completa.zip"
FIXTURE_DST="$ARTIFACT/qa/mision_fr5_completa.zip"
if [ -f "$FIXTURE_SRC" ]; then
  mkdir -p "$ARTIFACT/qa"
  cp "$FIXTURE_SRC" "$FIXTURE_DST"
  echo "[airgap] fixture E2E dorado → /qa/mision_fr5_completa.zip ($(du -k "$FIXTURE_DST" | awk '{print $1}') KiB)"
else
  echo "[airgap] AVISO: fixture $FIXTURE_SRC ausente — el E2E dorado quedará sin pack (check 3 FAIL)" >&2
fi

cat > "$ARTIFACT/LEEME-CLASIFICACION.txt" <<EOF
ARTEFACTO AIR-GAP — Ti-4GO · Visor isométrico de microcuencas (Guanajuato)
==========================================================================
Licencia Apache 2.0 — PPcoyente Group · MexiGIS Labs
  Distribución pública bajo LICENSE (repo Ti-4GO).
Generado: ${STAMP} UTC · GeneratorVersion: Ti-4GO SDK v1.0.0 · scripts/build_airgap.sh

QUÉ ES
  Export estático puro (HTML/JS/CSS, sin servidor): 0 GPU · solo vectores ·
  render determinista por CPU. Verificación de terceros vía build air-gap +
  manifiesto SHA-256 — nunca vía publicación (charter §8).

DEGRADACIÓN DECLARADA (aprobada en checkpoint de ingeniería)
  /api/ingest EXCLUIDA del artefacto: la bitácora de auditoría no está
  disponible y la UI lo declara («air-gap · bitácora no disp.»). El parseo
  GIS/CAD sigue siendo 100 % local (Web Worker, 0 subidas).

VERIFICACIÓN (sin red)
  sha256sum -c MANIFIESTO_SHA256.txt      # desde esta carpeta

REGENERACIÓN
  bash scripts/build_airgap.sh            # desde la raíz del repo
EOF

(
  cd "$ARTIFACT"
  find . -type f ! -name 'MANIFIESTO_SHA256.txt' | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
    sha256sum -- "$f"
  done > MANIFIESTO_SHA256.txt
)
echo "[airgap] manifiesto interno: $(wc -l < "$ARTIFACT/MANIFIESTO_SHA256.txt" | tr -d ' ') archivos"

# ── 4. entrega a downloads/airgap-export ──
rm -rf "$DEST_ROOT"
mkdir -p "$(dirname "$DEST_ROOT")"
mv "$ARTIFACT" "$DEST_ROOT"
echo "[airgap] artefacto sellado → $DEST_ROOT ($(du -sh "$DEST_ROOT" | awk '{print $1}'))"

# ── 5. restauración ANTES de los manifiestos (el manifiesto del repo debe
#      incluir src/app/api; el trap queda como red de seguridad) ──
restore_api

# ── 6. huella del repo PRIMERO (excluye downloads/ ⇒ sin ciclo) y EX-006
#      después (incluye el REPO_MANIFIESTO ya estable) ──
bash downloads/tools/make_repo_manifest.sh || true
bash downloads/tools/make_manifest.sh

# ── 7. salud del dev server (el build aislado no debe haberlo tocado) ──
sleep 2
if curl -sf -o /dev/null "http://localhost:3000/"; then
  echo "[airgap] dev server :3000 OK — el preview no fue afectado"
else
  echo "[airgap] AVISO: dev server no responde en :3000 (revisar dev.log)" >&2
fi

echo "[airgap] COMPLETE — verificación: (cd downloads/airgap-export && sha256sum -c MANIFIESTO_SHA256.txt)"
