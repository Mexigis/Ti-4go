/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-5 — NÚCLEO LEHMANN como función pura (checkpoint de ingeniería trace
 * , contrato a): UNA sola fuente de geometría de tramas
 * para los DOS consumidores — el motor (engine.ts, canvas interactivo) y
 * el export (export.ts, lista de despliegue SVG/PDF WYSIWYG).
 *
 * Hasta FR-5 el bloque F5-03 (hachurado de pendiente) vivía DUPLICADO —
 * engine.ts lo comentaba como «espejo exacto del bloque Lehmann de
 * export.ts». Este módulo elimina la duplicación: ambos llaman a
 * `buildLehmannSegs` y la paridad byte-idéntica del camino pendiente
 * (hachures) queda EXIGIDA por test (tests/forense_lehmann.test.ts).
 *
 * Semántica (ADR D12 §4): dado un campo escalar muestreado, el núcleo
 * emite segmentos rectos orientados sobre el eje del gradiente (±∇,
 * normalizado unitario — un trazo no tiene punta), con longitud dada por
 * el consumidor (`lenPx`) y cotas dadas por el consumidor (`zPair`):
 *   - pendiente (legacy F5-03): v = elevación, longitud ∝ pendiente,
 *     trazo pegado al plano local (z0 = zC + slope·halfM).
 *   - fricción (D12): v = costo, longitud por clase de intensidad,
 *     trazo drapeado sobre la superficie del terreno activo.
 *
 * Diferencias centradas con índices CLAMPEADOS (fix G-1/F19 heredado):
 * sin clamp, j+k/i+k salen del array cuando (n-1) % k ≠ 0 ⇒ NaN en el
 * path exportado. El divisor usa el espaciado real (iE-iW)/(jN-jS).
 *
 * 0 GPU / CPU puro / determinista: misma entrada ⇒ misma salida byte a
 * byte. Sin asignación en el camino caliente salvo el propio buffer de
 * salida (preasignado a maxCount·6 float32).
 */

import type { RasterTarget } from './linegrammar';

/* ------------------------------------------------------------------ */
/* Tipos                                                              */
/* ------------------------------------------------------------------ */

export interface LehmannOpts {
  /** Paso de muestreo en celdas (calculado con `lehmannStride`). */
  k: number;
  /** Metros-mundo por celda en X e Y (Y puede ser negativo: fila 0=Norte). */
  cellXm: number;
  cellYm: number;
  /** Origen en espacio de NODO (legacy pendiente: −(n−1)/2; fricción: 0). */
  originI: number;
  originJ: number;
  /** Origen en METROS-MUNDO sumado tras la escala (legacy: 0). */
  originX: number;
  originY: number;
  /** píxeles de pantalla por metro — convierte longitudes px → mundo. */
  metersPerPx: number;
  /** Tope duro de segmentos (legacy pendiente: 20000). */
  maxCount: number;
  /** Longitud del trazo en PX de pantalla para la celda (v, |∇v|). */
  lenPx: (v: number, slope: number) => number;
  /** Predicado de omisión de la celda (umbral / clase 0 / llano). */
  skip: (v: number, slope: number) => boolean;
  /** Cotas del trazo [z0, z1] (plano local o drapeado). */
  zPair: (
    v: number,
    slope: number,
    halfM: number,
    ux: number,
    uy: number,
    x: number,
    y: number
  ) => [number, number];
  /** Celda inválida (NODATA): la celda y su stencil se omiten. */
  nodata?: (v: number) => boolean;
}

export interface LehmannSegs {
  /** [x0,y0,z0, x1,y1,z1] × count en metros-mundo. */
  segs: Float32Array;
  count: number;
  buildMs: number;
}

/* ------------------------------------------------------------------ */
/* Stride canónico (misma cuenta que el bloque legacy F5-03)          */
/* ------------------------------------------------------------------ */

/**
 * Paso de muestreo k: espaciado objetivo de PANTALLA entre muestras, con
 * doblado hasta respetar el tope de muestras ((n-1)/k+1)² ≤ maxCount.
 * Determinista; k cambia al cruzar umbrales de zoom ⇒ se reconstruye.
 */
export function lehmannStride(
  n: number,
  cellM: number,
  targetPx: number,
  metersPerPx: number,
  maxCount: number
): number {
  /* Ceil: la separación EN PANTALLA es un MÍNIMO contractual (targetPx) —
     round dejaba 9.6 px < 11 px en la geometría del forense (k=3 vs k=4). */
  let k = Math.max(1, Math.ceil((targetPx * metersPerPx) / cellM));
  while (((Math.floor((n - 1) / k) + 1) ** 2) > maxCount) k *= 2;
  return k;
}

/* ------------------------------------------------------------------ */
/* Núcleo puro                                                        */
/* ------------------------------------------------------------------ */

/**
 * Construye la geometría de tramas de un campo escalar. PURA: no toca
 * canvas, no lee relojes salvo para medir su propio buildMs, no muta
 * entradas. La paridad con el bloque legacy F5-03 (pendiente) es
 * byte-idéntica cuando el llamador pasa los parámetros legacy — test
 * forense lo exige.
 */
export function buildLehmannSegs(
  v: ArrayLike<number>,
  n: number,
  o: LehmannOpts
): LehmannSegs {
  const t0 = performance.now();
  const segs = new Float32Array(o.maxCount * 6);
  let count = 0;
  const nd = o.nodata;
  for (let j = o.k; j < n - 1; j += o.k) {
    for (let i = o.k; i < n - 1; i += o.k) {
      const zC = v[j * n + i];
      if (nd && nd(zC)) continue;
      const iE = Math.min(i + o.k, n - 1);
      const iW = Math.max(i - o.k, 0);
      const jN = Math.min(j + o.k, n - 1);
      const jS = Math.max(j - o.k, 0);
      if (nd && (nd(v[j * n + iE]) || nd(v[j * n + iW]) || nd(v[jN * n + i]) || nd(v[jS * n + i])))
        continue;
      // Diferencias centradas CLAMPEADAS con espaciado real (G-1/F19)
      const dzX = (v[j * n + iE] - v[j * n + iW]) / ((iE - iW) * o.cellXm);
      const dzY = (v[jN * n + i] - v[jS * n + i]) / ((jN - jS) * o.cellYm);
      const slope = Math.hypot(dzX, dzY);
      if (o.skip(zC, slope)) continue;
      const lenPx = o.lenPx(zC, slope);
      const halfM = (lenPx / 2) * o.metersPerPx;
      // Normalización UNITARIA: u = −∇/|∇| (adimensional)
      const inv = 1 / slope;
      const ux = -dzX * inv;
      const uy = -dzY * inv;
      const x = o.originX + (i + o.originI) * o.cellXm;
      const y = o.originY + (j + o.originJ) * o.cellYm;
      const [z0, z1] = o.zPair(zC, slope, halfM, ux, uy, x, y);
      segs[count * 6] = x - ux * halfM;
      segs[count * 6 + 1] = y - uy * halfM;
      segs[count * 6 + 2] = z0;
      segs[count * 6 + 3] = x + ux * halfM;
      segs[count * 6 + 4] = y + uy * halfM;
      segs[count * 6 + 5] = z1;
      count++;
      if (count >= o.maxCount) break;
    }
    if (count >= o.maxCount) break;
  }
  return { segs, count, buildMs: performance.now() - t0 };
}

/* ------------------------------------------------------------------ */
/* Rasterizador B/N de tramas (verificación por píxel, CPU puro)      */
/* ------------------------------------------------------------------ */

function stampDisc(t: RasterTarget, cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(t.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(t.h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) t.ink[y * t.w + x] = 1;
    }
}

/**
 * Estampa la trama (vista PLANTA: eje Y de mundo hacia arriba ⇒ py = oy −
 * y·ppm) en un raster B/N de linegrammar. Determinista; usada por la suite
 * forense para la coexistencia D11 (7 tipos SOBRE fondo tramado) y la
 * verificación E-Ink del campo. `weight` en px (D12: 0.7 como el trazo).
 */
export function rasterizeTramaTop(
  t: RasterTarget,
  segs: Float32Array,
  count: number,
  ppm: number,
  ox: number,
  oy: number,
  weight = 0.7
): void {
  const r = weight / 2;
  for (let s = 0; s < count; s++) {
    const x0 = segs[s * 6];
    const y0 = segs[s * 6 + 1];
    const x1 = segs[s * 6 + 3];
    const y1 = segs[s * 6 + 4];
    const ax = ox + x0 * ppm;
    const ay = oy - y0 * ppm;
    const bx = ox + x1 * ppm;
    const by = oy - y1 * ppm;
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      stampDisc(t, ax + (bx - ax) * f, ay + (by - ay) * f, r);
    }
  }
}
