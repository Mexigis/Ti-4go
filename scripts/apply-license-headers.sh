#!/usr/bin/env bash
# apply-license-headers.sh — estampado idempotente del header SPDX Apache 2.0
# en los fuentes TypeScript/TSX del árbol (src/ y tests/).
# Nota de diseño: header SPDX corto (sin URL) — los contratos forenses del
# árbol prohíben URLs en fuentes (S1/forense_pwa); LICENSE lleva el texto
# íntegro de Apache 2.0. Artefactos generados excluidos.
set -euo pipefail
cd "$(dirname "$0")/.."

stamped=0; skipped=0
while IFS= read -r f; do
  case "$f" in
    src/wc/wc-chrome.ts) continue ;;  # generado por build:wc — header propio
  esac
  if grep -q 'SPDX-License-Identifier: Apache-2.0' "$f"; then
    skipped=$((skipped+1)); continue
  fi
  printf '/*\n * Copyright 2026 PPcoyente Group \xc2\xb7 MexiGIS Labs\n * SPDX-License-Identifier: Apache-2.0\n */\n\n' | cat - "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  stamped=$((stamped+1))
done < <(find src tests -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path 'src/wc/wc-chrome.ts')
echo "estampados: $stamped · ya tenían: $skipped"
