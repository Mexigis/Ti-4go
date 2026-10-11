/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generador del modelo digital de terreno (MDT) procedural.
 *
 * Estrategia:
 *  1. Rejilla 161x161 (celda ~40 m) con fBm + ridged noise como relieve base.
 *  2. Cada subcuenca se esculpe con: anillo de cumbres (borde divisorio),
 *     depresión interior (embudo hacia la salida) y muesca de salida.
 *  3. Cauces: trazado por descenso más pronunciado (steepest descent).
 *  4. Divisorias: anillo paramétrico por subcuenca, muestreado sobre el MDT.
 *
 * Coordenadas en metros; origen en el centro del recorte. X=este, Y=norte.
 */

import { clamp, fbm, ridged, smoothstep } from './noise';
import type { BasinDef, RegionDef } from './regions';

export interface Grid {
  n: number; // vértices por lado
  cell: number; // tamaño de celda en m
  h: Float32Array; // alturas (m s.n.m.), índice j*n+i
  min: number;
  max: number;
}

export interface BasinInfo {
  name: string;
  cx: number;
  cy: number;
  r: number;
  outlet: { x: number; y: number; z: number };
  /** Anillo divisorio muestreado [x,y,z]x96 (cerrado) */
  ring: Float32Array;
}

export interface TerrainStats {
  areaModelHa: number;
  dividePerimeterKm: number;
  desnivel: number;
  slopePct: number;
  nodes: number;
  streams: number;
}

export interface TerrainModel {
  region: RegionDef;
  grid: Grid;
  basins: BasinInfo[];
  /** Cauces: polílineas [x,y,z] (no cerradas) */
  streams: Float32Array[];
  stats: TerrainStats;
}

const N = 161;
const RING_PTS = 96;

export class Terrain {
  private region: RegionDef;
  private wobbleSeed: number;
  private tmp: Float32Array | null = null;

  constructor(region: RegionDef) {
    this.region = region;
    this.wobbleSeed = region.seed ^ 0x9e3779b9;
  }

  /** Radio del borde divisorio de una subcuenca en la dirección theta */
  blobRadius(b: BasinDef, theta: number): number {
    const w = fbm(Math.cos(theta) * 1.9 + 9.3, Math.sin(theta) * 1.9 + 4.7, this.wobbleSeed, 3);
    return b.r * (1 + (w - 0.5) * 0.5);
  }

  /** Superficie de una subcuenca aproximada (km²) */
  basinArea(b: BasinDef): number {
    let sum = 0;
    for (let i = 0; i < 16; i++) {
      const th = (i / 16) * Math.PI * 2;
      const r = this.blobRadius(b, th);
      sum += r * r * Math.cos(th) * Math.sin(th);
    }
    return Math.abs(sum) * Math.PI * 0.5 * 1e-6;
  }

  isInsideAnyBasin(x: number, y: number): boolean {
    for (const b of this.region.basins) {
      const dx = x - b.cx;
      const dy = y - b.cy;
      const d = Math.hypot(dx, dy);
      if (d < this.blobRadius(b, Math.atan2(dy, dx))) return true;
    }
    return false;
  }

  /** Altura en un punto continuo (m s.n.m.) — misma función que puebla la rejilla */
  heightAt(x: number, y: number): number {
    const r = this.region;
    const ext = r.extent;
    const freq = 2.4 / ext;

    // Relieve base montañoso (rasgos amplios; octavas altas casi nulas)
    let t = fbm(x * freq, y * freq, r.seed, 5, 0.34) * 0.55;
    t += ridged(x * freq * 1.3, y * freq * 1.3, r.seed + 555, 2) * 0.22;

    // Borde del recorte elevado (marco montañoso)
    const dEdge = Math.min(ext / 2 - Math.abs(x), ext / 2 - Math.abs(y));
    t += smoothstep(300, 0, dEdge) * 0.16;

    // Esculturas por subcuenca
    let bowl = 0;
    let ridge = 0;
    let notch = 0;
    for (const b of r.basins) {
      const dx = x - b.cx;
      const dy = y - b.cy;
      const d = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const rb = this.blobRadius(b, th);

      // Anillo de cumbres sobre el borde divisorio
      const dRing = Math.abs(d - rb);
      ridge += Math.exp(-(dRing * dRing) / (2 * 340 * 340)) * 0.18;

      // Depresión interior (cuenca)
      if (d < rb) {
        const s = clamp(d / rb, 0, 1);
        bowl += Math.pow(1 - s * s, 1.5) * 0.3;
      }

      // Muesca de salida (veta hacia el embalse)
      const ox = b.cx + Math.cos(b.outletAz) * rb * 0.94;
      const oy = b.cy + Math.sin(b.outletAz) * rb * 0.94;
      const dOut2 = (x - ox) * (x - ox) + (y - oy) * (y - oy);
      notch += Math.exp(-dOut2 / (2 * 420 * 420)) * 0.26;
    }

    t = clamp(t + ridge - bowl - notch, 0, 1);
    // Compresión de amplitud: pendientes medias ~10-16 % (como la cuenca real)
    return r.elevMin + (0.1 + 0.68 * t) * (r.elevMax - r.elevMin);
  }

  buildGrid(): Grid {
    const h = new Float32Array(N * N);
    let min = Infinity;
    let max = -Infinity;
    const half = (N - 1) / 2;
    for (let j = 0; j < N; j++) {
      const y = (j - half) * this.gridCell();
      for (let i = 0; i < N; i++) {
        const x = (i - half) * this.gridCell();
        const v = this.heightAt(x, y);
        h[j * N + i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    // Suavizado 3x3 (2 pasadas): elimina pozos/picos de ruido fino y produce
    // curvas de nivel limpias, como en cartografía real
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? h : this.tmp!;
      const dst = pass === 0 ? (this.tmp ??= new Float32Array(h.length)) : h;
      for (let j = 0; j < N; j++) {
        const jm = j > 0 ? j - 1 : j;
        const jp = j < N - 1 ? j + 1 : j;
        for (let i = 0; i < N; i++) {
          const im = i > 0 ? i - 1 : i;
          const ip = i < N - 1 ? i + 1 : i;
          dst[j * N + i] =
            (src[j * N + i] * 4 +
              src[j * N + im] * 2 +
              src[j * N + ip] * 2 +
              src[jm * N + i] * 2 +
              src[jp * N + i] * 2 +
              src[jm * N + im] +
              src[jm * N + ip] +
              src[jp * N + im] +
              src[jp * N + ip]) /
            16;
        }
      }
    }
    min = Infinity;
    max = -Infinity;
    for (let k = 0; k < h.length; k++) {
      if (h[k] < min) min = h[k];
      if (h[k] > max) max = h[k];
    }
    return { n: N, cell: this.gridCell(), h, min, max };
  }

  gridCell(): number {
    return this.region.extent / (N - 1);
  }

  gridN(): number {
    return N;
  }
}

/** Muestreo bilineal de la rejilla */
export function sampleGrid(g: Grid, x: number, y: number): number {
  const half = (g.n - 1) / 2;
  const fx = clamp(x / g.cell + half, 0, g.n - 1.001);
  const fy = clamp(y / g.cell + half, 0, g.n - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const a = g.h[j * g.n + i];
  const b = g.h[j * g.n + i + 1];
  const c = g.h[(j + 1) * g.n + i];
  const d = g.h[(j + 1) * g.n + i + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Trazado de cauce por descenso más pronunciado */
function traceStream(t: Terrain, g: Grid, sx: number, sy: number, outlet: { x: number; y: number }): Float32Array | null {
  const step = g.cell * 0.45;
  const pts: number[] = [];
  let x = sx;
  let y = sy;
  let z = sampleGrid(g, x, y);
  pts.push(x, y, z);
  let flatRun = 0;
  for (let s = 0; s < 1200; s++) {
    const e = g.cell * 0.3;
    const gx = (sampleGrid(g, x + e, y) - sampleGrid(g, x - e, y)) / (2 * e);
    const gy = (sampleGrid(g, x, y + e) - sampleGrid(g, x, y - e)) / (2 * e);
    const gl = Math.hypot(gx, gy);
    if (gl < 1e-5) {
      flatRun++;
      if (flatRun > 10) break;
    } else {
      flatRun = 0;
      x -= (gx / gl) * step;
      y -= (gy / gl) * step;
    }
    const half = (g.n - 1) / 2 * g.cell;
    x = clamp(x, -half, half);
    y = clamp(y, -half, half);
    const nz = sampleGrid(g, x, y);
    if (nz > z + 0.01) break; // empezó a subir: toco fondo o cresta
    z = nz;
    pts.push(x, y, z);
    const dOut = Math.hypot(x - outlet.x, y - outlet.y);
    if (dOut < step * 1.2) {
      pts.push(outlet.x, outlet.y, sampleGrid(g, outlet.x, outlet.y));
      break;
    }
  }
  if (pts.length < 8 * 3) return null;
  return new Float32Array(pts);
}

export function buildTerrain(region: RegionDef): TerrainModel {
  const t = new Terrain(region);
  const grid = t.buildGrid();
  const half = (N - 1) / 2;

  const basins: BasinInfo[] = region.basins.map((b) => {
    const ring = new Float32Array(RING_PTS * 3);
    let outletZ = 0;
    for (let i = 0; i < RING_PTS; i++) {
      const th = (i / RING_PTS) * Math.PI * 2;
      const rb = t.blobRadius(b, th);
      const x = b.cx + Math.cos(th) * rb;
      const y = b.cy + Math.sin(th) * rb;
      const z = sampleGrid(grid, x, y);
      ring[i * 3] = x;
      ring[i * 3 + 1] = y;
      ring[i * 3 + 2] = z;
    }
    const ox = b.cx + Math.cos(b.outletAz) * t.blobRadius(b, b.outletAz) * 0.94;
    const oy = b.cy + Math.sin(b.outletAz) * t.blobRadius(b, b.outletAz) * 0.94;
    const cxo = clamp(Math.round((ox / grid.cell) + half), 0, N - 1);
    const cyo = clamp(Math.round((oy / grid.cell) + half), 0, N - 1);
    outletZ = grid.h[cyo * N + cxo];
    return {
      name: b.name,
      cx: b.cx,
      cy: b.cy,
      r: b.r,
      outlet: { x: ox, y: oy, z: outletZ },
      ring,
    };
  });

  // Cauces: 3 fuentes por subcuenca sobre la ladera alta
  const streams: Float32Array[] = [];
  for (const b of region.basins) {
    const angles = [b.outletAz + Math.PI, b.outletAz + 2.35, b.outletAz - 2.35];
    for (const a of angles) {
      const rb = t.blobRadius(b, a) * 0.9;
      const sx = b.cx + Math.cos(a) * rb;
      const sy = b.cy + Math.sin(a) * rb;
      const outlet = basins.find((bi) => bi.name === b.name)?.outlet ?? basins[0].outlet;
      const s = traceStream(t, grid, sx, sy, outlet);
      if (s) streams.push(s);
    }
  }

  // Estadísticas
  let inside = 0;
  let slopeSum = 0;
  let slopeN = 0;
  for (let j = 1; j < N - 1; j += 2) {
    for (let i = 1; i < N - 1; i += 2) {
      const x = (i - half) * grid.cell;
      const y = (j - half) * grid.cell;
      if (t.isInsideAnyBasin(x, y)) inside++;
      const gx = (grid.h[j * N + i + 1] - grid.h[j * N + i - 1]) / (2 * grid.cell);
      const gy = (grid.h[(j + 1) * N + i] - grid.h[(j - 1) * N + i]) / (2 * grid.cell);
      slopeSum += Math.hypot(gx, gy);
      slopeN++;
    }
  }
  let per = 0;
  for (const bi of basins) {
    for (let i = 0; i < RING_PTS; i++) {
      const j = (i + 1) % RING_PTS;
      const dx = bi.ring[j * 3] - bi.ring[i * 3];
      const dy = bi.ring[j * 3 + 1] - bi.ring[i * 3 + 1];
      per += Math.hypot(dx, dy);
    }
  }

  const cellArea = grid.cell * grid.cell;
  const stats: TerrainStats = {
    areaModelHa: (inside * cellArea) / 1e4,
    dividePerimeterKm: per / 1000,
    desnivel: grid.max - grid.min,
    slopePct: (slopeSum / Math.max(1, slopeN)) * 100,
    nodes: N * N,
    streams: streams.length,
  };

  return { region, grid, basins, streams, stats };
}
