/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * gps.ts — muestreo del MDT para el breadcrumb (FR-W1).
 *
 * TRANSPLANTE INVERSO (directiva del propietario, opción A): módulo
 * REDUCIDO del linaje local — aquí vive SOLO `sampleGridZ`, la
 * dependencia de `src/lib/terrain/breadcrumb.ts`.
 * El GPS-ORTO completo del linaje local (resolveCota · startGps ·
 * wgs84ToScene · curvasConsistency · simulateFixAt, con geoid propio) NO
 * se trasplantó: el árbol resuelve la cota por su propia ruta (FR-7,
 * `src/lib/gps/*` + `src/lib/ingest/geoid.ts`). El linaje local queda
 * custodiado íntegro en su linaje; su re-activación es decisión del
 * propietario.
 */
import { sampleGrid, type Grid } from './generator';

/** z del MDT en (x,y) de escena; null fuera del recorte (honesto: un fix
 *  fuera del MDT NO se ancla al borde — distinto de sampleGrid del motor,
 *  que clampea para el render). */
export function sampleGridZ(grid: Grid, x: number, y: number): number | null {
  const half = ((grid.n - 1) / 2) * grid.cell;
  if (x < -half || x > half || y < -half || y > half) return null;
  const z = sampleGrid(grid, x, y);
  return Number.isFinite(z) ? z : null;
}
