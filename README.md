# Ti-4GO

**Motor de rastreo geoespacial y visualización de campo — visor isométrico de curvas de nivel.**

[![CI](https://github.com/Mexigis/Ti-4go/actions/workflows/ci.yml/badge.svg)](https://github.com/Mexigis/Ti-4go/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Curvas de nivel a 1 m (maestras cada 25 m) renderizadas por CPU — **0 GPU · 0 bandwidth · determinista**. El mismo estado de vista produce píxel-idéntico el mismo terreno, en cualquier máquina, sin servidor de tiles: el terreno viaja como semilla procedural comprimida (~200 caracteres) y el motor lo reconstruye localmente en un Web Worker.

Desarrollado por **PPcoyente Group · MexiGIS Labs**. Licencia **Apache 2.0**.

## Qué hay aquí

| Pieza | Ruta | Descripción |
|---|---|---|
| Motor de terreno | `src/lib/terrain/` | IsoEngine Canvas 2D: generador, contornos, drape GPS, geoid, presupuesto de CPU por cuadro |
| Ingesta GIS/CAD | `src/lib/ingest/` | GeoJSON · KML · Shapefile · GeoTIFF · packs ZIP — parseo **100 % local** en Web Worker (nada sale de la máquina) |
| Visor embebible | `src/wc/` + `public/wc/` | Web Component autosuficiente (shadow DOM con chrome incluido) + `ti4go-viewer.d.ts` |
| UI de campo | `src/components/terrain/` | HUD experto, Modo Campo, GPS, export SVG/PDF, PWA air-gap |
| Suite forense | `tests/` | 570 tests: contratos de parsers, golden vectors, determinismo píxel, firewall de formatos hostiles |

## Arranque rápido

```bash
bun install
cp .env.example .env        # SQLite local (bitácora de ingesta — solo metadatos)
bun run db:push
bun run dev                 # http://localhost:3000
bun test                    # suite forense
bun run lint
```

## Componente web embebible

El visor completo (lienzo + HUD + paneles + tipografía del chrome) viaja dentro del shadow DOM: **un solo `<script type="module">` y un custom element**. Ver `GUIA-EMBED.md` y `public/wc/ti4go-viewer.d.ts`:

```html
<script type="module" src="./ti4go-viewer.js"></script>
<ti4go-viewer seed="MXP1-..." theme="dark" height="420"></ti4go-viewer>
```

Kit de embed listo para terceros con demo y guía: **[releases](https://github.com/Mexigis/Ti-4go/releases)**.

## Demo en vivo

GitHub Pages monta el visor con las **4 semillas sintéticas** (temas dark / day / eink + campo):
**https://mexigis.github.io/Ti-4go/**

## Política de datos (diseño)

- **Nada sale de tu máquina**: la ingesta GIS/CAD parsea en Web Worker; el backend solo registra metadatos de auditoría (nombre/CRS/tamaño — nunca binarios).
- **Cero datos reales en el repo**: las semillas son procedurales; INEGI es referencial sin datos (ver `NOTICES`). Los datos oficiales se obtienen de [inegi.org.mx](https://www.inegi.org.mx/).
- **PWA air-gap**: `scripts/build_airgap.sh` produce un export estático sin servidor, sellado con manifiesto SHA-256.

## CI

`.github/workflows/ci.yml` corre en cada push/PR: `bun install` → `prisma generate` → `lint` → **suite forense** (570 tests · 7 skips honestos que requieren datos reales de custodia, fuera del repo por diseño) → `next build`.

## Licencia

Apache 2.0 — ver [LICENSE](LICENSE) y [NOTICES](NOTICES).
