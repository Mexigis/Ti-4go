/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Motor DEM Real — construcción del modelo de terreno desde un GeoTIFF
 * decodificado (roadmap 0 GPU, Task 18).
 *
 * Sustituye el MDT procedural por el raster REAL:
 *   1. Ancla el extent de la región sobre el CRS del DEM:
 *        · geográfico → lineal local m/deg en el centro de la región
 *        · UTM        → forward UTM (WGS84, series de Krüger/Snyder)
 *        · métrico    → se asume unidad = metro, anclado por centro
 *   2. Reamuestrea bilinealmente el raster nativo a la rejilla 161×161
 *      del motor (misma célula que buildTerrain procedural); celdas fuera
 *      de cobertura o NODATA → NaN → relleno por dilatación (plateau).
 *   3. Cauces por descenso más pronunciado desde máximos locales reales.
 *   4. Divisorias paramétricas del catálogo (blobRadius) con COTAS del
 *      MDT real — el trazado paramétrico queda documentado en meta.notes.
 *   5. Curvas de nivel reales vía buildContours (marching squares intacto).
 *
 * 0 GPU: todo en CPU dentro del worker de terreno; determinista (mismo
 * archivo + misma región ⇒ mismo modelo bit a bit).
 */

import { buildContours, type Contours } from './contours';
import type { BasinInfo, Grid, TerrainModel, TerrainStats } from './generator';
import { sampleGrid, Terrain } from './generator';
import type { DecodedDem } from '@/lib/ingest/geotiff-dem';
import type { RegionDef } from './regions';

export const REAL_GRID_N = 161; // vértices por lado (idéntico a generator.N)

export interface RealDemMeta {
  fileName: string;
  /** % de vértices de la rejilla con valor real (resto: dilatación) */
  coveragePct: number;
  crsLabel: string;
  compression: string;
  sampleLabel: string;
  nativeW: number;
  nativeH: number;
  /** resolución nativa aproximada en metros */
  nativeCellM: number;
  decodeMs: number;
  resampleMs: number;
  nodataCount: number;
  notes: string[];
}

export type RealTerrainResult =
  | { ok: true; model: TerrainModel; contours: Contours; meta: RealDemMeta }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Anclaje geográfico                                                  */
/* ------------------------------------------------------------------ */

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const UTM_K0 = 0.9996;

/** metros por grado de latitud/longitud en φ (series estándar, ±0.01 %) */
function metersPerDegree(latDeg: number): { mLat: number; mLon: number } {
  const φ = (latDeg * Math.PI) / 180;
  const mLat =
    111132.92 - 559.82 * Math.cos(2 * φ) + 1.175 * Math.cos(4 * φ) - 0.0023 * Math.cos(6 * φ);
  const mLon = 111412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ) + 0.118 * Math.cos(5 * φ);
  return { mLat, mLon };
}

/** Forward UTM (WGS84) — series de Snyder; devuelvo [E, N] en metros. */
export function forwardUtm(lonDeg: number, latDeg: number, zone: number, south: boolean): [number, number] {
  const a = WGS84_A;
  const f = WGS84_F;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const φ = (latDeg * Math.PI) / 180;
  const λ = (lonDeg * Math.PI) / 180;
  const λ0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);

  const sinφ = Math.sin(φ);
  const cosφ = Math.cos(φ);
  const tanφ = Math.tan(φ);
  const N = a / Math.sqrt(1 - e2 * sinφ * sinφ);
  const T = tanφ * tanφ;
  const C = ep2 * cosφ * cosφ;
  const A = cosφ * (λ - λ0);

  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const M =
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * φ -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * φ) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * φ) -
      ((35 * e6) / 3072) * Math.sin(6 * φ));

  const E =
    UTM_K0 *
      N *
      (A +
        ((1 - T + C) * A * A * A) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000;
  let Nn =
    UTM_K0 *
    (M +
      N *
        tanφ *
        ((A * A) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (south) Nn += 10000000;
  return [E, Nn];
}

/* ------------------------------------------------------------------ */
/* Muestreo del DEM nativo                                             */
/* ------------------------------------------------------------------ */

/**
 * Elevación del DEM nativo en coordenadas CRS (bilíneal). Devuelve NaN
 * fuera de cobertura o en NODATA (enteros: comparación con el valor).
 */
function sampleCrs(dem: DecodedDem, x: number, y: number): number {
  const xf = (x - dem.tieX) / dem.scaleX - 0.5;
  const yf = (dem.tieY - y) / dem.scaleY - 0.5;
  const i = Math.floor(xf);
  const j = Math.floor(yf);
  if (i < 0 || j < 0 || i >= dem.w - 1 || j >= dem.h - 1) return NaN;
  const fx = xf - i;
  const fy = yf - j;
  const d = dem.data;
  const v00 = d[j * dem.w + i] as number;
  const v10 = d[j * dem.w + i + 1] as number;
  const v01 = d[(j + 1) * dem.w + i] as number;
  const v11 = d[(j + 1) * dem.w + i + 1] as number;
  const nd = dem.nodata;
  const bad = (v: number): boolean =>
    Number.isNaN(v) || (nd !== null && !Number.isNaN(nd) && v === nd);
  if (bad(v00) || bad(v10) || bad(v01) || bad(v11)) return NaN;
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

/** Rejilla NaN → dilatación por anillos (plateau suave, sin acantilados) */
function fillNaN(grid: Float32Array, n: number): number {
  let filled = 0;
  for (let pass = 0; pass < 8; pass++) {
    const copy = pass === 0 ? grid.slice() : null;
    const src = copy ?? grid;
    let changed = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (!Number.isNaN(src[k])) continue;
        let sum = 0;
        let cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const jj = j + dj;
            const ii = i + di;
            if (jj < 0 || ii < 0 || jj >= n || ii >= n || (di === 0 && dj === 0)) continue;
            const v = src[jj * n + ii];
            if (!Number.isNaN(v)) {
              sum += v;
              cnt++;
            }
          }
        }
        if (cnt > 0) {
          grid[k] = sum / cnt;
          changed++;
        }
      }
    }
    filled += changed;
    if (changed === 0) break;
  }
  // lo que siga en NaN (esquinas aisladas): mínimo global
  let min = Infinity;
  for (let k = 0; k < grid.length; k++) if (!Number.isNaN(grid[k]) && grid[k] < min) min = grid[k];
  for (let k = 0; k < grid.length; k++) if (Number.isNaN(grid[k])) grid[k] = Number.isFinite(min) ? min : 0;
  return filled;
}

/* ------------------------------------------------------------------ */
/* Cauces reales (descenso más pronunciado sobre el MDT real)          */
/* ------------------------------------------------------------------ */

function traceRealStream(g: Grid, sx: number, sy: number): Float32Array | null {
  const step = g.cell * 0.45;
  const pts: number[] = [];
  let x = sx;
  let y = sy;
  let z = sampleGrid(g, x, y);
  pts.push(x, y, z);
  let flatRun = 0;
  const half = ((g.n - 1) / 2) * g.cell;
  for (let s = 0; s < 1200; s++) {
    const e = g.cell * 0.3;
    const gx = (sampleGrid(g, x + e, y) - sampleGrid(g, x - e, y)) / (2 * e);
    const gy = (sampleGrid(g, x, y + e) - sampleGrid(g, x, y - e)) / (2 * e);
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-5) {
      flatRun++;
      if (flatRun > 10) break; // fondo de valle/laguna
    } else {
      flatRun = 0;
      x -= (gx / gl) * step;
      y -= (gy / gl) * step;
    }
    x = Math.max(-half, Math.min(half, x));
    y = Math.max(-half, Math.min(half, y));
    const nz = sampleGrid(g, x, y);
    if (nz > z + 0.01) break; // empezó a subir: cauce cerrado
    z = nz;
    pts.push(x, y, z);
  }
  if (pts.length < 10 * 3) return null;
  return new Float32Array(pts);
}

/** Semillas: máximos locales reales, separados ≥ minSep m, top-K por cota */
function streamSeeds(g: Grid, maxSeeds: number, minSep: number): Array<[number, number, number]> {
  const { h, n, cell } = g;
  const cands: Array<[number, number, number]> = [];
  for (let j = 2; j < n - 2; j++) {
    for (let i = 2; i < n - 2; i++) {
      const v = h[j * n + i];
      let isMax = true;
      for (let dj = -2; dj <= 2 && isMax; dj++) {
        for (let di = -2; di <= 2; di++) {
          if (di === 0 && dj === 0) continue;
          if (h[(j + dj) * n + (i + di)] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) {
        const x = (i - (n - 1) / 2) * cell;
        const y = (j - (n - 1) / 2) * cell;
        cands.push([v, x, y]);
      }
    }
  }
  cands.sort((a, b) => b[0] - a[0]);
  const picked: Array<[number, number, number]> = [];
  for (const c of cands) {
    if (picked.length >= maxSeeds) break;
    let ok = true;
    for (const p of picked) {
      if (Math.hypot(c[1] - p[1], c[2] - p[2]) < minSep) {
        ok = false;
        break;
      }
    }
    if (ok) picked.push(c);
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Construcción del modelo real                                        */
/* ------------------------------------------------------------------ */

export function buildRealTerrain(dem: DecodedDem, region: RegionDef, fileName: string): RealTerrainResult {
  try {
    const resampleT0 = performance.now();
    const n = REAL_GRID_N;
    const cell = region.extent / (n - 1);
    const half = (n - 1) / 2;

    // Ancla región → CRS del DEM
    const anchor: { kind: 'geo' } | { kind: 'crs'; e0: number; n0: number } = (() => {
      if (dem.crs.kind === 'geographic') return { kind: 'geo' };
      if (dem.crs.kind === 'utm' && dem.crs.utmZone) {
        const [e0, n0] = forwardUtm(region.centerLon, region.centerLat, dem.crs.utmZone, dem.crs.utmSouth === true);
        return { kind: 'crs', e0, n0 };
      }
      // métrico/unknown: centro del DEM anclado al centro de la región
      const cx = dem.tieX + ((dem.w - 1) / 2) * dem.scaleX;
      const cy = dem.tieY - ((dem.h - 1) / 2) * dem.scaleY;
      return { kind: 'crs', e0: cx, n0: cy };
    })();

    const grid = new Float32Array(n * n);
    let valid = 0;
    for (let j = 0; j < n; j++) {
      const y = (j - half) * cell; // norte +Y
      for (let i = 0; i < n; i++) {
        const x = (i - half) * cell;
        let v: number;
        if (anchor.kind === 'geo') {
          const { mLat, mLon } = metersPerDegree(region.centerLat + y / 111320);
          v = sampleCrs(dem, region.centerLon + x / mLon, region.centerLat + y / mLat);
        } else {
          v = sampleCrs(dem, anchor.e0 + x, anchor.n0 + y);
        }
        grid[j * n + i] = v;
        if (!Number.isNaN(v)) valid++;
      }
    }
    const coveragePct = (valid / (n * n)) * 100;
    if (valid === 0) {
      return { ok: false, error: 'El GeoTIFF no cubre la región activa (0 % de cobertura)' };
    }
    const nodataCount = n * n - valid;
    const filled = fillNaN(grid, n);
    if (filled > 0) {
      // normaliza tras rellenar
      for (let k = 0; k < grid.length; k++) if (grid[k] < -1040 || grid[k] > 9000) grid[k] = 2000;
    }

    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < grid.length; k++) {
      if (grid[k] < min) min = grid[k];
      if (grid[k] > max) max = grid[k];
    }
    const g: Grid = { n, cell, h: grid, min, max };

    // Suavizado 3×3 (2 pasadas, idéntico al procedural): curvas limpias
    const tmp = new Float32Array(grid.length);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? grid : tmp;
      const dst = pass === 0 ? tmp : grid;
      for (let j = 0; j < n; j++) {
        const jm = j > 0 ? j - 1 : j;
        const jp = j < n - 1 ? j + 1 : j;
        for (let i = 0; i < n; i++) {
          const im = i > 0 ? i - 1 : i;
          const ip = i < n - 1 ? i + 1 : i;
          dst[j * n + i] =
            (src[j * n + i] * 4 +
              src[j * n + im] * 2 +
              src[j * n + ip] * 2 +
              src[jm * n + i] * 2 +
              src[jp * n + i] * 2 +
              src[jm * n + im] +
              src[jm * n + ip] +
              src[jp * n + im] +
              src[jp * n + ip]) /
            16;
        }
      }
    }
    min = Infinity;
    max = -Infinity;
    for (let k = 0; k < grid.length; k++) {
      if (grid[k] < min) min = grid[k];
      if (grid[k] > max) max = grid[k];
    }

    // Divisorias paramétricas del catálogo con cotas REALES
    const t = new Terrain(region);
    const basins: BasinInfo[] = region.basins.map((b) => {
      const RING_PTS = 96;
      const ring = new Float32Array(RING_PTS * 3);
      for (let i = 0; i < RING_PTS; i++) {
        const th = (i / RING_PTS) * Math.PI * 2;
        const rb = t.blobRadius(b, th);
        const x = b.cx + Math.cos(th) * rb;
        const y = b.cy + Math.sin(th) * rb;
        ring[i * 3] = x;
        ring[i * 3 + 1] = y;
        ring[i * 3 + 2] = sampleGrid(g, x, y);
      }
      const ox = b.cx + Math.cos(b.outletAz) * t.blobRadius(b, b.outletAz) * 0.94;
      const oy = b.cy + Math.sin(b.outletAz) * t.blobRadius(b, b.outletAz) * 0.94;
      return {
        name: b.name,
        cx: b.cx,
        cy: b.cy,
        r: b.r,
        outlet: { x: ox, y: oy, z: sampleGrid(g, ox, oy) },
        ring,
      };
    });

    // Cauces reales desde máximos locales
    const seeds = streamSeeds(g, 8, Math.max(1000, region.extent * 0.18));
    const streams: Float32Array[] = [];
    for (const [, sx, sy] of seeds) {
      const st = traceRealStream(g, sx, sy);
      if (st) streams.push(st);
    }

    // Estadísticas reales
    let slopeSum = 0;
    let slopeN = 0;
    let inside = 0;
    for (let j = 1; j < n - 1; j += 2) {
      for (let i = 1; i < n - 1; i += 2) {
        const x = (i - half) * cell;
        const y = (j - half) * cell;
        if (t.isInsideAnyBasin(x, y)) inside++;
        const gx = (grid[j * n + i + 1] - grid[j * n + i - 1]) / (2 * cell);
        const gy = (grid[(j + 1) * n + i] - grid[(j - 1) * n + i]) / (2 * cell);
        slopeSum += Math.hypot(gx, gy);
        slopeN++;
      }
    }
    let per = 0;
    for (const bi of basins) {
      for (let i = 0; i < 96; i++) {
        const j2 = (i + 1) % 96;
        per += Math.hypot(bi.ring[j2 * 3] - bi.ring[i * 3], bi.ring[j2 * 3 + 1] - bi.ring[i * 3 + 1]);
      }
    }
    const cellArea = cell * cell;
    const stats: TerrainStats = {
      areaModelHa: (inside * cellArea) / 1e4,
      dividePerimeterKm: per / 1000,
      desnivel: max - min,
      slopePct: (slopeSum / Math.max(1, slopeN)) * 100,
      nodes: n * n,
      streams: streams.length,
    };

    const resampleMs = performance.now() - resampleT0;

    const notes: string[] = [];
    if (dem.crs.kind === 'metric' || dem.crs.kind === 'unknown') {
      notes.push('CRS no geográfico: alineado por centro (unidad = metro asumida)');
    }
    if (nodataCount > 0) {
      notes.push(`${nodataCount} vértices sin cobertura/NODATA rellenados por dilatación`);
    }
    notes.push('Divisorias paramétricas del catálogo con cotas del MDT real');

    const meta: RealDemMeta = {
      fileName,
      coveragePct: Math.round(coveragePct * 10) / 10,
      crsLabel: dem.crs.label,
      compression: dem.compression,
      sampleLabel: dem.sampleLabel,
      nativeW: dem.w,
      nativeH: dem.h,
      nativeCellM:
        dem.crs.kind === 'geographic'
          ? Math.round(dem.scaleY * metersPerDegree(region.centerLat).mLat)
          : Math.round(dem.scaleX),
      decodeMs: Math.round(dem.decodeMs * 10) / 10,
      resampleMs: Math.round(resampleMs * 10) / 10,
      nodataCount,
      notes,
    };

    const model: TerrainModel = { region, grid: g, basins, streams, stats };
    const contours = buildContours(g);
    return { ok: true, model, contours, meta };
  } catch (err) {
    return { ok: false, error: `DEM real: ${String(err instanceof Error ? err.message : err)}` };
  }
}
