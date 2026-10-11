# Contribuir a Ti-4GO

¡Gracias por tu interés! Ti-4GO es un motor determinista: **el determinismo es el contrato** — el mismo estado de vista debe producir píxel-idéntico el mismo terreno, siempre.

## Flujo

1. Fork + rama descriptiva (`feat/...`, `fix/...`).
2. `bun install` · `cp .env.example .env` · `bun run db:push`.
3. Desarrolla con `bun run dev`.
4. **Gate antes de proponer**: `bun run lint` (0 errores) + `bun test` (0 FAIL).

## Reglas del motor

- **Determinismo primero**: ningún `Math.random()` sin semilla, ningún estado global no-regenerable, ninguna dependencia de hora/red en el render.
- **Presupuesto de CPU**: el motor vive bajo presupuesto por cuadro (idle-stop, 0 trabajo en reposo). No introducir trabajo por cuadro sin medirlo.
- **Parseo 100 % local**: la ingesta corre en Web Worker; nada sale de la máquina. Los parsers aceptan formatos hostiles con rechazo explicado (nunca «fingir» decodificación).
- **Contratos tipados**: los packs/semillas tienen formatos versionados con checksum — romper un contrato rompe tests conocidos (`tests/`).

## Suite

La suite es forense: vectores conocidos (FIPS, GDAL-paridad), catálogos de ZIPs hostiles, determinismo ×100 y píxel verificado. Si tu cambio toca parsers o motor, añade un test con vector conocido. Los tests marcados `skip` requieren datos reales de custodia que no viajan en el repo por diseño — no los «arregles».

## Estilo

- TypeScript estricto; el lint es ley.
- Componentes UI: shadcn/ui (Radix) — no reintentes ruedas.

## Licencia

Al contribuir aceptas que tus aportaciones se publican bajo Apache 2.0 (ver LICENSE).
