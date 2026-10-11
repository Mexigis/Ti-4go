/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Breadcrumb A-8 — migas de pan del brigadista ancladas al terreno (FR-W1).
 *
 * Visión (checkpoint de ingeniería):
 * el breadcrumb «se siente paso» — migas a CADENCIA DE FIX (cada stepM
 * metros, como los pasos del brigadista) y SIEMPRE ancladas al terreno:
 * la z de cada miga es la del MDT activo (muestreo honesto de gps.sampleGridZ,
 * null fuera ⇒ la miga no existe: nada inventado, lección vigente).
 *
 * La ruta A-8 es una DEMO de laboratorio (FR-W1, siempre etiquetada):
 * waypoints sintéticos en metros de escena dentro de la Cuenca de la
 * Soledad, con_switchback que asciende hacia la Subcuenca El Mirador. La
 * validación con dispositivo real permanece en la columna del propietario
 * (FR-9 / FR-9 dispositivo).
 *
 * 0 dependencias · determinista · testeable en bun (forense_breadcrumb).
 */

import { sampleGridZ } from './gps';
import type { Grid } from './generator';

/** Identificador de la ruta demo (verbatim de la referencia de campo). */
export const BREADCRUMB_ROUTE = 'A-8';

/** Cadencia de migas: 1 miga cada 25 m — «se siente paso» (paso de brigadista). */
export const BREADCRUMB_STEP_M = 25;

/** Techo de migas por trail (presupuesto determinista; el path es corto pero
 *  la regla protege el presupuesto de dibujo si se amplía la ruta). */
export const BREADCRUMB_MAX_PTS = 400;

/**
 * Waypoints de la A-8 en metros de escena (X=este, Y=norte, origen = centro
 * de la región). Switchback de 4 tramos (~2.1 km) que asciende hacia la
 * Subcuenca El Mirador — todo dentro del extent de la Soledad (±3,200 m).
 */
export const A8_WAYPOINTS: ReadonlyArray<readonly [number, number]> = [
  [-200, 600],
  [200, 900],
  [600, 700], // switchback
  [950, 1100],
  [1200, 1500], // cabeza — ladera de El Mirador
];

export interface BreadcrumbTrail {
  /** xyz (m de escena) — z = MDT real del grid activo en cada miga. */
  pts: Float32Array;
  /** Migas válidas (= pts.length/3). */
  n: number;
  /** Cabeza del trail (última miga — posición del brigadista). */
  headX: number;
  headY: number;
  headZ: number;
  /** Longitud recorrida a lo largo de la ruta (m). */
  lenM: number;
  /** Migas descartadas por caer fuera del MDT (honesto, se informa). */
  dropped: number;
  routeId: string;
  source: 'simulacion';
}

/**
 * Construye el trail A-8 sobre el grid activo: interpola los waypoints a
 * cadencia BREADCRUMB_STEP_M, muestrea la z del MDT en cada miga y descarta
 * (contando) las que caen fuera de cobertura. Determinista.
 *
 * null si NINGUNA miga cae dentro del MDT (ruta sin terreno ⇒ sin demo —
 * nunca un trail plano inventado).
 */
export function buildBreadcrumbTrail(
  grid: Grid,
  stepM: number = BREADCRUMB_STEP_M,
  maxPts: number = BREADCRUMB_MAX_PTS
): BreadcrumbTrail | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  let len = 0;
  let dropped = 0;

  const push = (x: number, y: number): void => {
    const z = sampleGridZ(grid, x, y);
    if (z === null) {
      dropped++;
      return;
    }
    if (xs.length >= maxPts) return; // presupuesto: se conserva el tramo inicial
    xs.push(x);
    ys.push(y);
    zs.push(z);
  };

  for (let w = 0; w < A8_WAYPOINTS.length; w++) {
    const [x0, y0] = A8_WAYPOINTS[w];
    if (w === 0) {
      push(x0, y0);
      continue;
    }
    const [px, py] = A8_WAYPOINTS[w - 1];
    const segLen = Math.hypot(x0 - px, y0 - py);
    const steps = Math.max(1, Math.round(segLen / stepM));
    len += segLen;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      push(px + (x0 - px) * t, py + (y0 - py) * t);
    }
  }

  if (xs.length === 0) return null;
  const n = xs.length;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = xs[i];
    pts[i * 3 + 1] = ys[i];
    pts[i * 3 + 2] = zs[i];
  }
  const last = (n - 1) * 3;
  return {
    pts,
    n,
    // La cabeza se lee del array f32: coherencia bit a bit con lo dibujado.
    headX: pts[last],
    headY: pts[last + 1],
    headZ: pts[last + 2],
    lenM: len,
    dropped,
    routeId: BREADCRUMB_ROUTE,
    source: 'simulacion',
  };
}
