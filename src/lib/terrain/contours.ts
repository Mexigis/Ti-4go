/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extracción de curvas de nivel por marching squares — versión optimizada.
 *
 * Optimizaciones aplicadas (ronda de exploración de optimizaciones, medidas
 * con scripts/diag-terrain.ts; salida bit a bit equivalente a la versión
 * serial clásica cuando simplifyTol = 0):
 *
 *  1. Barrido "cell-major" con rango de niveles por celda: en lugar de
 *     visitar TODAS las celdas por CADA isovalor (O(niveles × celdas)),
 *     cada celda se visita una vez y solo se procesan los niveles que
 *     cruzan estrictamente su rango [min(esquinas), max(esquinas)]
 *     (mn < v ≤ mx). Con celda de 40 m y pendiente ~14 %, esto reduce las
 *     evaluaciones de celda×nivel en más de un orden de magnitud.
 *  2. Early-out por código de caso: celdas triviales (0/15) se descartan
 *     con un solo entero; cálculo de cruces perezoso (solo las aristas que
 *     el caso empuja), igual que en la versión de referencia.
 *  3. Enlace de segmentos con claves ENTERAS (rejilla de 0.1 m indexada)
 *     en lugar de claves string: sin hashing de cadenas ni concatenaciones
 *     en el camino caliente. Misma cuantización ⇒ mismas polilíneas.
 *  4. Buffers por nivel asignados de forma perezosa y compactados al final
 *     (sin objetos por celda; solo arrays numéricos).
 *  5. Simplificación Douglas–Peucker opcional por polilínea (simplify.ts),
 *     activada por defecto con tolerancia de 1 m (≈ sub-píxel en vista
 *     general; reduce puntos/segmentos sin cambiar la forma perceptible).
 *  6. Variante ligera adaptativa (ATOM-03 del roadmap): cada nivel
 *     menor genera además `polysLight` con tolerancia gruesa
 *     (LIGHT_SIMPLIFY_TOL, 8 m). El motor la usa solo cuando su tolerancia
 *     es sub-píxel (tol · pxPerM < 1) ⇒ desviación garantizada < 1 px con
 *     ~60 % menos segmentos en vista general y móviles.
 *
 * Las curvas intermedias siguen siendo cada 1 m y las maestras cada 25 m.
 * Cada nivel produce polílineas enlazadas (world X,Y + cota del nivel) con
 * bounding box precalculado para culling rápido en el render.
 */

import type { Grid } from './generator';
import { simplifyPolyline } from './simplify';

export interface Poly {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** puntos [x,y] consecutivos en el plano horizontal */
  pts: Float32Array;
  n: number;
  closed: boolean;
}

export interface Level {
  /** cota en m s.n.m. */
  v: number;
  maestra: boolean;
  polys: Poly[];
  segs: number;
  /** variante ligera (tol gruesa sub-píxel, ATOM-03): solo niveles menores */
  polysLight?: Poly[];
  segsLight?: number;
}

export interface Contours {
  levels: Level[];
  minV: number;
  maxV: number;
  totalSegs: number;
  maestraCount: number;
  /** total de vértices tras simplificación (diagnóstico) */
  totalPts: number;
  /** tolerancia efectiva de la variante ligera; 0 = no generada */
  lightTol: number;
  /** segmentos de la variante ligera (solo menores; diagnóstico) */
  totalSegsLight: number;
}

const STEP_MINOR = 1;
const STEP_MAJOR = 25;

/** Tolerancia Douglas–Peucker por defecto (metros). 0 = sin simplificar. */
export const DEFAULT_SIMPLIFY_TOL = 1;

/**
 * Tolerancia de la variante ligera (ATOM-03): 8 m ⇒ desviación < 1 px
 * siempre que el motor la seleccione solo cuando tol · pxPerM < 1.
 */
export const LIGHT_SIMPLIFY_TOL = 8;

export interface BuildContoursOpts {
  /** tolerancia de simplificación en metros; 0 desactiva (bit-exacto) */
  simplifyTol?: number;
  /** tolerancia de la variante ligera; 0 desactiva; default LIGHT_SIMPLIFY_TOL */
  lightTol?: number;
}

/**
 * Genera las curvas. Nota de desempeño: corre UNA vez por modelo
 * (~10-30 ms tras optimización, antes ~300 ms); el render posterior solo
 * proyecta puntos ya precalculados.
 */
export function buildContours(grid: Grid, opts?: BuildContoursOpts): Contours {
  const tol = opts?.simplifyTol ?? DEFAULT_SIMPLIFY_TOL;
  const lightTol = opts?.lightTol ?? LIGHT_SIMPLIFY_TOL;

  const v0 = Math.ceil(grid.min);
  const v1 = Math.floor(grid.max);
  const nLevels = v1 - v0 + 1;
  const levelSegs: (number[] | null)[] = new Array(nLevels).fill(null);

  const { h, n, cell } = grid;
  const half = (n - 1) / 2;

  for (let j = 0; j < n - 1; j++) {
    const rowJ = j * n;
    const rowJ1 = rowJ + n;
    const y0 = (j - half) * cell;
    const y1 = y0 + cell;
    for (let i = 0; i < n - 1; i++) {
      const a = h[rowJ + i]; // (i, j)     — esquina A (noroeste)
      const b = h[rowJ + i + 1]; // (i+1, j) — esquina B (noreste)
      const d = h[rowJ1 + i]; // (i, j+1)   — esquina D (suroeste)
      const c = h[rowJ1 + i + 1]; // (i+1, j+1) — esquina C (sureste)

      // Rango de niveles que cruzan estrictamente esta celda: mn < v ≤ mx
      const mn = Math.min(a, b, c, d);
      const mx = Math.max(a, b, c, d);
      let lo = Math.floor(mn) + 1;
      if (lo < v0) lo = v0;
      let hi = Math.floor(mx);
      if (hi > v1) hi = v1;
      if (lo > hi) continue;

      const x0 = (i - half) * cell;
      const x1 = x0 + cell;

      for (let v = lo; v <= hi; v++) {
        let code = 0;
        if (a >= v) code |= 1;
        if (b >= v) code |= 2;
        if (c >= v) code |= 4;
        if (d >= v) code |= 8;
        if (code === 0 || code === 15) continue;

        // cruces en aristas (solo los que el caso necesita, sin allocaciones)
        let abx = 0;
        let aby = 0;
        let bcx = 0;
        let bcy = 0;
        let cdx = 0;
        let cdy = 0;
        let dax = 0;
        let day = 0;
        let needsAB = false;
        let needsBC = false;
        let needsCD = false;
        let needsDA = false;

        switch (code) {
          case 1:
          case 14:
          case 5:
            needsDA = true;
            needsAB = true;
            break;
          case 2:
          case 13:
            needsAB = true;
            needsBC = true;
            break;
          case 3:
          case 12:
            needsDA = true;
            needsBC = true;
            break;
          case 4:
          case 11:
            needsBC = true;
            needsCD = true;
            break;
          case 6:
          case 9:
            needsAB = true;
            needsCD = true;
            break;
          case 7:
          case 8:
            needsDA = true;
            needsCD = true;
            break;
          case 10:
            needsAB = true;
            needsBC = true;
            needsCD = true;
            needsDA = true;
            break;
        }

        if (needsAB) {
          const t = (v - a) / (b - a);
          abx = x0 + t * cell;
          aby = y0;
        }
        if (needsBC) {
          const t = (v - b) / (c - b);
          bcx = x1;
          bcy = y0 + t * cell;
        }
        if (needsCD) {
          const t = (v - d) / (c - d);
          cdx = x0 + t * cell;
          cdy = y1;
        }
        if (needsDA) {
          const t = (v - a) / (d - a);
          dax = x0;
          day = y0 + t * cell;
        }

        const arr = levelSegs[v - v0] ?? (levelSegs[v - v0] = []);
        switch (code) {
          case 1:
          case 14:
            arr.push(dax, day, abx, aby);
            break;
          case 2:
          case 13:
            arr.push(abx, aby, bcx, bcy);
            break;
          case 3:
          case 12:
            arr.push(dax, day, bcx, bcy);
            break;
          case 4:
          case 11:
            arr.push(bcx, bcy, cdx, cdy);
            break;
          case 6:
          case 9:
            arr.push(abx, aby, cdx, cdy);
            break;
          case 7:
          case 8:
            arr.push(dax, day, cdx, cdy);
            break;
          case 5:
            arr.push(dax, day, abx, aby);
            arr.push(bcx, bcy, cdx, cdy);
            break;
          case 10:
            arr.push(abx, aby, bcx, bcy);
            arr.push(cdx, cdy, dax, day);
            break;
        }
      }
    }
  }

  const levels: Level[] = [];
  let totalSegs = 0;
  let totalPts = 0;
  let maestraCount = 0;
  let totalSegsLight = 0;

  for (let k = 0; k < nLevels; k++) {
    const segs = levelSegs[k];
    if (segs === null) continue;
    const v = v0 + k;

    const linked = linkSegments(segs);
    const polys =
      tol > 0 ? linked.map((p) => simplifyPoly(p, tol)).filter((p): p is Poly => p !== null) : linked;

    let lvlSegs = 0;
    for (const p of polys) lvlSegs += p.n - 1;
    for (const p of polys) totalPts += p.n;
    totalSegs += lvlSegs;
    const maestra = v % STEP_MAJOR === 0;
    if (maestra) maestraCount++;

    // Variante ligera (ATOM-03): solo niveles menores; las maestras siempre
    // se sirven finas (son la referencia cartográfica y llevan cotas).
    let polysLight: Poly[] | undefined;
    let lvlSegsLight = 0;
    if (lightTol > tol && !maestra) {
      polysLight = linked
        .map((p) => simplifyPoly(p, lightTol))
        .filter((p): p is Poly => p !== null);
      for (const p of polysLight) lvlSegsLight += p.n - 1;
      totalSegsLight += lvlSegsLight;
    }

    const lvl: Level = { v, maestra, polys, segs: lvlSegs };
    if (polysLight) {
      lvl.polysLight = polysLight;
      lvl.segsLight = lvlSegsLight;
    }
    levels.push(lvl);
  }

  const lightActive = lightTol > tol;
  return {
    levels,
    minV: v0,
    maxV: v1,
    totalSegs,
    maestraCount,
    totalPts,
    lightTol: lightActive ? lightTol : 0,
    totalSegsLight: lightActive ? totalSegsLight : 0,
  };
}

/** Simplifica una polilínea y recalcula su bbox; null si queda degenerada. */
function simplifyPoly(p: Poly, tol: number): Poly | null {
  const pts = simplifyPolyline(p.pts, tol);
  const n = pts.length / 2;
  if (n < 2) return null;
  if (pts === p.pts) return p; // sin cambios: reutilizar
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, pts, n, closed: p.closed };
}

/** Enlaza segmentos sueltos en polílineas usando claves enteras (rejilla 0.1 m) */
function linkSegments(segs: number[]): Poly[] {
  // rango garantizado hasta ±5000 m (extensión máxima del proyecto: 9,200 m)
  const K = 50000;
  const keyOf = (x: number, y: number): number =>
    (Math.round(x * 10) + K) * 100000 + (Math.round(y * 10) + K);

  const adj = new Map<number, number[]>();
  const m = segs.length / 4;
  for (let s = 0; s < m; s++) {
    const k0 = keyOf(segs[s * 4], segs[s * 4 + 1]);
    const k1 = keyOf(segs[s * 4 + 2], segs[s * 4 + 3]);
    (adj.get(k0) ?? adj.set(k0, []).get(k0)!).push(s * 2);
    (adj.get(k1) ?? adj.set(k1, []).get(k1)!).push(s * 2 + 1);
  }

  const used = new Uint8Array(m);
  const polys: Poly[] = [];
  const out: number[] = [];

  for (let s0 = 0; s0 < m; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    out.length = 0;
    out.push(segs[s0 * 4], segs[s0 * 4 + 1], segs[s0 * 4 + 2], segs[s0 * 4 + 3]);

    // extender hacia adelante desde el extremo final
    for (let dir = 0; dir < 2; dir++) {
      while (true) {
        const ei = dir === 0 ? out.length - 2 : 0;
        const k = keyOf(out[ei], out[ei + 1]);
        const cands = adj.get(k);
        let found = -1;
        let fend: 0 | 1 = 0;
        if (cands) {
          for (let ci = 0; ci < cands.length; ci++) {
            const packed = cands[ci];
            const si = packed >>> 1;
            if (!used[si]) {
              found = si;
              fend = (packed & 1) as 0 | 1;
              break;
            }
          }
        }
        if (found < 0) break;
        used[found] = 1;
        const ox = segs[found * 4 + (1 - fend) * 2];
        const oy = segs[found * 4 + (1 - fend) * 2 + 1];
        if (dir === 0) out.push(ox, oy);
        else out.unshift(ox, oy);
      }
    }

    const n = out.length / 2;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < out.length; i += 2) {
      const x = out[i];
      const y = out[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const closed = n > 3 && keyOf(out[0], out[1]) === keyOf(out[out.length - 2], out[out.length - 1]);
    polys.push({ minX, minY, maxX, maxY, pts: new Float32Array(out), n, closed });
  }
  return polys;
}
