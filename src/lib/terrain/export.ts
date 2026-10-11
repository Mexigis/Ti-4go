/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Export vectorial de la escena — SVG 1.1 y PDF 1.4 (§6.2 del roadmap 0 GPU).
 *
 * La escena del visor ya es 100 % vectorial (curvas de nivel, cauces,
 * divisorias, malla, marco INEGI), de modo que el export no rasteriza NADA:
 * reconstruye la lista de primitivas del último cuadro con la MISMA
 * proyección, el MISMO culling y la MISMA paleta del motor y la serializa a
 * dos formatos abiertos sin una sola dependencia:
 *
 *  - SVG 1.1 (string): texto plano, editable en Illustrator/Inkscape/QGIS.
 *  - PDF 1.4 (Blob): escritor propio con flujos de contenido sin comprimir
 *    o FlateDecode vía CompressionStream nativo (fallback honesto), fuentes
 *    base-14 (Courier/Helvetica) y metadatos de marca.
 *
 * WYSIWYG estricto: el intervalo efectivo (LOD o forzado), la variante
 * ligera (ATOM-03), el rango de elevación, el modo E-Ink y la cámara del
 * último cuadro son los que manda `ExportScene`. La exportación es
 * determinista: misma escena ⇒ mismo archivo byte a byte.
 */

import type { Poly } from './contours';
import { sampleGrid, type TerrainModel } from './generator';
import { COLORS, DAY_COLORS, EINK_COLORS, type ExportScene } from './engine';
import { formatDegMin, inegiCodesJoin } from './inegi';
import { packRegionSeed } from './seedpack';
import { BRAND, DEVELOPER, QUALITY_SEAL, SDK_VERSION } from '@/lib/branding';
import { buildLehmannSegs, lehmannStride } from './lehmann';
import {
  frictionPlacement,
  FRICTION_LEN_PX,
  frictionClassOf,
} from '../ingest/friction';

/* ------------------------------------------------------------------ */
/* Lista de despliegue — primitivas neutras compartidas por los 2      */
/* serializadores (una sola fuente de geometría)                       */
/* ------------------------------------------------------------------ */

/** Subtrayectoria: puntos planos [x,y,…] + bandera de cierre. */
export interface Sub {
  p: number[];
  z: boolean;
}

export type ExportOp =
  | {
      op: 'path';
      subs: Sub[];
      stroke?: string;
      fill?: string;
      width?: number;
      dash?: number[];
      alpha?: number;
    }
  | {
      op: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      r: number;
      fill?: string;
      stroke?: string;
      width?: number;
      alpha?: number;
    }
  | {
      op: 'text';
      x: number;
      y: number;
      str: string;
      size: number;
      color: string;
      align: 'left' | 'center' | 'right';
      baseline: 'middle' | 'bottom';
      mono: boolean;
      weight: number;
      halo?: string;
      alpha?: number;
    };

export interface DisplayList {
  ops: ExportOp[];
  /** Segmentos de curvas de nivel emitidos (misma métrica que el HUD). */
  segs: number;
  /** F5-03 · hachures emitidos (0 cuando la capa está apagada). */
  hachures?: number;
  /** FR-5 · D12: trazos de trama de fricción emitidos (0 sin capa). */
  frictionSegs?: number;
}

/** Constructor de subtrayectorias con culling por polilínea. */
class VecPath {
  subs: Sub[] = [];
  private cur: Sub | null = null;

  moveTo(x: number, y: number): void {
    this.cur = { p: [x, y], z: false };
    this.subs.push(this.cur);
  }

  lineTo(x: number, y: number): void {
    if (!this.cur) this.moveTo(x, y);
    else this.cur.p.push(x, y);
  }

  close(): void {
    if (this.cur) this.cur.z = true;
  }

  get empty(): boolean {
    for (const s of this.subs) if (s.p.length >= 4) return false;
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Proyección — idéntica al motor (sx/sy con az/el/zoom/pan del frame) */
/* ------------------------------------------------------------------ */

interface Proj {
  S: number;
  c: number;
  s: number;
  es: number;
  ec: number;
  w: number;
  h: number;
  w2: number;
  h2: number;
  sx: (x: number, y: number) => number;
  sy: (x: number, y: number, z: number) => number;
}

function makeProj(scene: ExportScene): Proj {
  const { az, el, panX, panY, pxPerM, w, h } = scene.cam;
  const S = pxPerM;
  const c = Math.cos(az);
  const s = Math.sin(az);
  const es = Math.sin(el);
  const ec = Math.cos(el);
  const w2 = w / 2 + panX;
  const h2 = h / 2 + panY;
  return {
    S,
    c,
    s,
    es,
    ec,
    w,
    h,
    w2,
    h2,
    sx: (x, y) => w2 + (x * c - y * s) * S,
    sy: (x, y, z) => h2 - ((x * s + y * c) * es + z * ec) * S,
  };
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

/** Redondeo a 0.01 px sin ceros colgantes (tamaño de archivo mínimo). */
function r2(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Descompone '#rgb' | '#rrggbb' | 'rgb(…)' | 'rgba(…)' a 0–1 + alpha. */
function parseColor(
  s: string
): { r: number; g: number; b: number; a: number } {
  if (s.charCodeAt(0) === 35 /* # */) {
    const h = s.slice(1);
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16) / 255,
        g: parseInt(h[1] + h[1], 16) / 255,
        b: parseInt(h[2] + h[2], 16) / 255,
        a: 1,
      };
    }
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a: 1,
    };
  }
  const m = s.match(/[\d.]+/g);
  const n = m ? m.map(Number) : [0, 0, 0];
  return { r: n[0] / 255, g: n[1] / 255, b: n[2] / 255, a: m && m.length > 3 ? Number(m[3]) : 1 };
}

const fmt2 = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Ancho aproximado de texto para centrar en PDF (métricas base-14). */
function approxTextWidth(str: string, size: number, mono: boolean): number {
  return str.length * size * (mono ? 0.6 : 0.5);
}

/* ------------------------------------------------------------------ */
/* buildDisplayList — espejo exacto del pipeline draw() del motor      */
/* ------------------------------------------------------------------ */

export function buildDisplayList(scene: ExportScene): DisplayList {
  const { model, contours, opts, cam, step, useLight, bucketColor, fogIdx } = scene;
  const pal = opts.eink ? EINK_COLORS : opts.day ? DAY_COLORS : COLORS;
  const P = makeProj(scene);
  const dl: DisplayList = { ops: [], segs: 0 };
  const [rMin, rMax] = opts.elevRange;
  const monoFont = { mono: true };

  /* —— fondo —— */
  dl.ops.push({ op: 'rect', x: 0, y: 0, w: P.w, h: P.h, r: 0, fill: pal.bg });

  /* —— malla base + marco del recorte (drawMesh) —— */
  const g = model.grid;
  const n = g.n;
  const half = (n - 1) / 2;
  if (opts.mesh) {
    const mp = new VecPath();
    const st = 8;
    for (let j = 0; j < n; j += st) {
      const y = (j - half) * g.cell;
      mp.moveTo(P.sx(-half * g.cell, y), P.sy(-half * g.cell, y, g.h[j * n]));
      for (let i = 1; i < n; i++) {
        const x = (i - half) * g.cell;
        mp.lineTo(P.sx(x, y), P.sy(x, y, g.h[j * n + i]));
      }
    }
    for (let i = 0; i < n; i += st) {
      const x = (i - half) * g.cell;
      mp.moveTo(P.sx(x, -half * g.cell), P.sy(x, -half * g.cell, g.h[i]));
      for (let j = 1; j < n; j++) {
        const y = (j - half) * g.cell;
        mp.lineTo(P.sx(x, y), P.sy(x, y, g.h[j * n + i]));
      }
    }
    dl.ops.push({ op: 'path', subs: mp.subs, stroke: pal.mesh, width: 1 });
  }

  /* —— marco del recorte a cota mínima (siempre, como el motor) —— */
  {
    const e = half * g.cell;
    const zmin = g.min;
    const fp = new VecPath();
    fp.moveTo(P.sx(-e, -e), P.sy(-e, -e, zmin));
    fp.lineTo(P.sx(e, -e), P.sy(e, -e, zmin));
    fp.lineTo(P.sx(e, e), P.sy(e, e, zmin));
    fp.lineTo(P.sx(-e, e), P.sy(-e, e, zmin));
    fp.close();
    dl.ops.push({ op: 'path', subs: fp.subs, stroke: pal.frame, width: 1 });
  }

  /* —— F5-03 · hachurado de pendiente (tramas Lehmann, bajo todo el
        linework). FR-5: la geometría sale del NÚCLEO LEHMANN puro
        (lehmann.ts) — el MISMO que el motor; la paridad byte-idéntica del
        camino pendiente queda exigida por test (forense_lehmann).
        Determinista: muestreo en rejilla entera, diferencias centradas
        CLAMPEADAS (G-1/F19), dirección de máximo descenso, longitud de
        pantalla ∝ pendiente, 1 sola op de path. —— */
  let hachures = 0;
  if (opts.hachures) {
    const metersPerPx = 1 / (cam.pxPerM || 0.08);
    const k = lehmannStride(n, g.cell, 11, metersPerPx, 20000);
    const built = buildLehmannSegs(g.h, n, {
      k,
      cellXm: g.cell,
      cellYm: g.cell,
      originI: -half,
      originJ: -half,
      originX: 0,
      originY: 0,
      metersPerPx,
      maxCount: 20000,
      lenPx: (_v, s) => Math.min(1.5 + s * 24, 9),
      skip: (_v, s) => s < 0.04,
      zPair: (v, s, hm) => [v + s * hm, v - s * hm],
    });
    const hp = new VecPath();
    for (let i = 0; i < built.count; i++) {
      const x0 = built.segs[i * 6];
      const y0 = built.segs[i * 6 + 1];
      const z0 = built.segs[i * 6 + 2];
      const x1 = built.segs[i * 6 + 3];
      const y1 = built.segs[i * 6 + 4];
      const z1 = built.segs[i * 6 + 5];
      // Culling por extremos (contrato F5-03 del forense): el inicio se
      // recorta estricto en lienzo + pad 24 px y el extremo admite pad 48 px
      // (los segmentos miden ≤ 9 px en pantalla — cap Lehmann —, así el
      // extremo jamás supera el pad 48 del contrato).
      const sx0 = P.sx(x0, y0);
      const sy0 = P.sy(x0, y0, z0);
      const sx1 = P.sx(x1, y1);
      const sy1 = P.sy(x1, y1, z1);
      if (sx0 < -24 || sx0 > P.w + 24 || sy0 < -24 || sy0 > P.h + 24) continue;
      if (sx1 < -48 || sx1 > P.w + 48 || sy1 < -48 || sy1 > P.h + 48) continue;
      hp.moveTo(sx0, sy0);
      hp.lineTo(sx1, sy1);
      hachures++;
    }
    if (hachures > 0) {
      dl.ops.push({ op: 'path', subs: hp.subs, stroke: pal.hachure, width: 0.7 });
    }
  }
  /* Contrato del DisplayList (§86): «0 cuando la capa está apagada» — la
     métrica se emite SIEMPRE (undefined jamás). */
  dl.hachures = hachures;

  /* —— FR-5 · D12 · tramas del campo de fricción (bajo todo el linework;
        WYSIWYG estricto: el MISMO núcleo Lehmann que el motor, con el
        MISMO drapeado sobre el grid del modelo y la MISMA paleta). —— */
  if (opts.friction && scene.friction) {
    const fr = scene.friction;
    const pl = frictionPlacement(fr.field, fr.anchor);
    const metersPerPx = 1 / (cam.pxPerM || 0.08);
    const cellRef = Math.min(Math.abs(pl.cellXm), Math.abs(pl.cellYm)) || 10;
    let k = Math.max(1, Math.round((14 * metersPerPx) / cellRef));
    while (
      (Math.floor((fr.field.w - 1) / k) + 1) * (Math.floor((fr.field.h - 1) / k) + 1) >
      20000
    )
      k *= 2;
    const built = buildLehmannSegs(fr.field.data, fr.field.w, {
      k,
      cellXm: pl.cellXm,
      cellYm: pl.cellYm,
      originI: 0,
      originJ: 0,
      originX: pl.originX,
      originY: pl.originY,
      metersPerPx,
      maxCount: 20000,
      lenPx: (v) => FRICTION_LEN_PX[frictionClassOf(v, fr.field.vmin, fr.field.vmax)],
      skip: (v, s) => s < 1e-9 || frictionClassOf(v, fr.field.vmin, fr.field.vmax) === 0,
      zPair: (_v, _s, _hm, _ux, _uy, x, y) => {
        const z = sampleGrid(g, x, y);
        return [z, z];
      },
      nodata: (v) =>
        Number.isNaN(v) ||
        (fr.field.nodata !== null && (v === fr.field.nodata || Number.isNaN(fr.field.nodata))),
    });
    const fp = new VecPath();
    let frictionSegs = 0;
    for (let i = 0; i < built.count; i++) {
      const x0 = built.segs[i * 6];
      const y0 = built.segs[i * 6 + 1];
      const z0 = built.segs[i * 6 + 2];
      const x1 = built.segs[i * 6 + 3];
      const y1 = built.segs[i * 6 + 4];
      const z1 = built.segs[i * 6 + 5];
      const xc = (x0 + x1) / 2;
      const yc = (y0 + y1) / 2;
      const zc = (z0 + z1) / 2;
      const px = P.w2 + (xc * P.c - yc * P.s) * P.S;
      const py = P.h2 - ((xc * P.s + yc * P.c) * P.es + zc * P.ec) * P.S;
      if (px < -24 || px > P.w + 24 || py < -24 || py > P.h + 24) continue;
      fp.moveTo(P.sx(x0, y0), P.sy(x0, y0, z0));
      fp.lineTo(P.sx(x1, y1), P.sy(x1, y1, z1));
      frictionSegs++;
    }
    if (frictionSegs > 0) {
      dl.ops.push({ op: 'path', subs: fp.subs, stroke: pal.hachure, width: 0.7 });
    }
    dl.frictionSegs = frictionSegs;
  }

  /* —— culling idéntico al motor (AABB proyectada, pad 60 px) —— */
  const cull = (p: Poly, z: number): boolean => {
    const pad = 60;
    let minSx = Infinity;
    let maxSx = -Infinity;
    let minSy = Infinity;
    let maxSy = -Infinity;
    for (let xi = 0; xi < 2; xi++) {
      const x = xi === 0 ? p.minX : p.maxX;
      for (let yi = 0; yi < 2; yi++) {
        const y = yi === 0 ? p.minY : p.maxY;
        const px = P.w2 + (x * P.c - y * P.s) * P.S;
        const py = P.h2 - ((x * P.s + y * P.c) * P.es + z * P.ec) * P.S;
        if (px < minSx) minSx = px;
        if (px > maxSx) maxSx = px;
        if (py < minSy) minSy = py;
        if (py > maxSy) maxSy = py;
      }
    }
    return maxSx < -pad || minSx > P.w + pad || maxSy < -pad || minSy > P.h + pad;
  };

  /* —— marco cartográfico INEGI (drawInegiFrame) —— */
  if (opts.inegi) {
    const r = model.region;
    const zmin = g.min;
    const rad = (r.centerLat * Math.PI) / 180;
    const mPerLon = 111320 * Math.cos(rad);
    const dLon = half * g.cell / mPerLon;
    const dLat = (half * g.cell) / 111320;
    const inegi = new VecPath();

    const cullPt = (px: number, py: number): boolean =>
      px < -80 || px > P.w + 80 || py < -80 || py > P.h + 80;

    // Crucetas de esquina
    for (const [x, y] of [
      [-half * g.cell, -half * g.cell],
      [half * g.cell, -half * g.cell],
      [half * g.cell, half * g.cell],
      [-half * g.cell, half * g.cell],
    ]) {
      const px = P.sx(x, y);
      const py = P.sy(x, y, zmin);
      if (cullPt(px, py)) continue;
      const ex = x < 0 ? 1 : -1;
      const ey = y < 0 ? 1 : -1;
      const a = { x: P.sx(x + ex * 40, y), y: P.sy(x + ex * 40, y, zmin) };
      const b = { x: P.sx(x, y + ey * 40), y: P.sy(x, y + ey * 40, zmin) };
      let d1x = a.x - px;
      let d1y = a.y - py;
      const l1 = Math.hypot(d1x, d1y) || 1;
      d1x /= l1;
      d1y /= l1;
      let d2x = b.x - px;
      let d2y = b.y - py;
      const l2 = Math.hypot(d2x, d2y) || 1;
      d2x /= l2;
      d2y /= l2;
      inegi.moveTo(px, py);
      inegi.lineTo(px + d1x * 14, py + d1y * 14);
      inegi.moveTo(px, py);
      inegi.lineTo(px + d2x * 14, py + d2y * 14);
    }

    // Ticks minutales
    const edgeTicks = (from: number, to: number, isLon: boolean): void => {
      const stepMin = 1 / 60;
      const start = Math.ceil(from * 60 - 1e-6) / 60;
      for (let v = start; v <= to + 1e-9; v += stepMin) {
        if (v <= from + 1e-9 || v >= to - 1e-9) continue;
        for (const edge of [-half * g.cell, half * g.cell]) {
          const x = isLon ? (v - r.centerLon) * mPerLon : edge;
          const y = isLon ? edge : (v - r.centerLat) * 111320;
          const px = P.sx(x, y);
          const py = P.sy(x, y, zmin);
          if (cullPt(px, py)) continue;
          const dxw = isLon ? x + 30 : x;
          const dyw = isLon ? y : y + 30;
          let ex = P.sx(dxw, dyw) - px;
          let ey = P.sy(dxw, dyw, zmin) - py;
          const l = Math.hypot(ex, ey) || 1;
          ex /= l;
          ey /= l;
          let nx = -ey;
          let ny = ex;
          const toC = P.w / 2 - px;
          const tcY = P.h / 2 - py;
          if (nx * toC + ny * tcY < 0) {
            nx = -nx;
            ny = -ny;
          }
          inegi.moveTo(px, py);
          inegi.lineTo(px + nx * 8, py + ny * 8);
        }
      }
    };
    edgeTicks(r.centerLon - dLon, r.centerLon + dLon, true);
    edgeTicks(r.centerLat - dLat, r.centerLat + dLat, false);

    dl.ops.push({ op: 'path', subs: inegi.subs, stroke: pal.inegiFrame, width: 1 });

    // Coordenadas geográficas de las esquinas
    const label = (x: number, y: number, lat: number, lon: number): void => {
      const px = P.sx(x, y);
      const py = P.sy(x, y, zmin);
      if (cullPt(px, py)) return;
      let ox = px - P.w / 2;
      let oy = py - P.h / 2;
      const l = Math.hypot(ox, oy) || 1;
      ox /= l;
      oy /= l;
      const txt = `${formatDegMin(lat)} ${lat >= 0 ? 'N' : 'S'} · ${formatDegMin(lon)} ${
        lon < 0 ? 'W' : 'E'
      }`;
      dl.ops.push({
        op: 'text',
        x: px + ox * 42,
        y: py + oy * 42,
        str: txt,
        size: 9,
        color: pal.inegiText,
        align: 'center',
        baseline: 'middle',
        weight: 500,
        ...monoFont,
      });
    };
    label(-half * g.cell, -half * g.cell, r.centerLat - dLat, r.centerLon - dLon);
    label(half * g.cell, -half * g.cell, r.centerLat - dLat, r.centerLon + dLon);
    label(half * g.cell, half * g.cell, r.centerLat + dLat, r.centerLon + dLon);
    label(-half * g.cell, half * g.cell, r.centerLat + dLat, r.centerLon - dLon);
  }

  /* —— curvas intermedias (paintMinors): buckets de gris, rango e intervalo —— */
  if (opts.minor) {
    const forced = opts.forcedStep > 0;
    let runBucket = -1;
    let run: VecPath | null = null;
    const flush = (): void => {
      if (run && !run.empty) {
        dl.ops.push({
          op: 'path',
          subs: run.subs,
          stroke: opts.eink ? pal.minor : bucketColor[runBucket] ?? pal.minor,
          /* F5-02 WYSIWYG: con niebla profunda el trazo también se afina */
          width: fogIdx >= 2 ? 0.8 : 1,
        });
      }
      run = null;
    };
    for (let li = 0; li < contours.levels.length; li++) {
      const lvl = contours.levels[li];
      if (lvl.maestra) continue;
      if (lvl.v < rMin || lvl.v > rMax) continue;
      /* Filtro efectivo del motor (Task 19): con step > 1 se filtran los
         niveles no múltiplos; step 1 pasa todo. Equivalente exacto a
         `(lodIdx > 0 || forced) && lvl.v % step !== 0` porque step == 1
         implica lodIdx == 0 sin forzado. */
      if (step > 1 && lvl.v % step !== 0) continue;

      const bucket = Math.min(7, Math.max(0, Math.round(((lvl.v - contours.minV) / Math.max(1, contours.maxV - contours.minV)) * 8 - 0.5)));
      if (bucket !== runBucket || !run) {
        flush();
        runBucket = bucket;
        run = new VecPath();
      }

      const light = useLight && lvl.polysLight !== undefined;
      const polys = light ? (lvl.polysLight as Poly[]) : lvl.polys;
      for (const p of polys) {
        if (cull(p, lvl.v)) continue;
        dl.segs += p.n - 1;
        run.moveTo(P.sx(p.pts[0], p.pts[1]), P.sy(p.pts[0], p.pts[1], lvl.v));
        for (let i = 1; i < p.n; i++) {
          run.lineTo(P.sx(p.pts[i * 2], p.pts[i * 2 + 1]), P.sy(p.pts[i * 2], p.pts[i * 2 + 1], lvl.v));
        }
      }
    }
    flush();
  }

  /* —— curvas maestras + cotas (paintMasters) —— */
  if (opts.major) {
    const mp = new VecPath();
    const cotas: Array<{ x: number; y: number; v: number }> = [];
    for (let li = 0; li < contours.levels.length; li++) {
      const lvl = contours.levels[li];
      if (!lvl.maestra) continue;
      if (lvl.v < rMin || lvl.v > rMax) continue;
      let drawn = false;
      for (const p of lvl.polys) {
        if (cull(p, lvl.v)) continue;
        dl.segs += p.n - 1;
        drawn = true;
        mp.moveTo(P.sx(p.pts[0], p.pts[1]), P.sy(p.pts[0], p.pts[1], lvl.v));
        for (let i = 1; i < p.n; i++) {
          mp.lineTo(P.sx(p.pts[i * 2], p.pts[i * 2 + 1]), P.sy(p.pts[i * 2], p.pts[i * 2 + 1], lvl.v));
        }
      }
      if (drawn && opts.cotas && cam.zoom > 0.4 && lvl.polys.length > 0) {
        // polilínea más larga del nivel (labelPoly del motor)
        let best = 0;
        for (let pi = 1; pi < lvl.polys.length; pi++) {
          if (lvl.polys[pi].n > lvl.polys[best].n) best = pi;
        }
        const lp = lvl.polys[best];
        const mx = (lp.minX + lp.maxX) / 2;
        const my = (lp.minY + lp.maxY) / 2;
        const px = P.w2 + (mx * P.c - my * P.s) * P.S;
        const py = P.h2 - ((mx * P.s + my * P.c) * P.es + lvl.v * P.ec) * P.S;
        if (px > 40 && px < P.w - 40 && py > 24 && py < P.h - 24) {
          cotas.push({ x: px, y: py, v: lvl.v });
        }
      }
    }
    if (!mp.empty) dl.ops.push({ op: 'path', subs: mp.subs, stroke: pal.major, width: 1.6 });

    if (cotas.length > 0) {
      cotas.sort((a, b) => a.x - b.x);
      const filtered: Array<{ x: number; y: number; v: number }> = [];
      for (const ct of cotas) {
        const last = filtered[filtered.length - 1];
        if (!last || ct.x - last.x > 64 || Math.abs(ct.y - last.y) > 40) filtered.push(ct);
      }
      for (const ct of filtered) {
        dl.ops.push({
          op: 'text',
          x: ct.x,
          y: ct.y,
          str: ct.v.toLocaleString('es-MX'),
          size: 10,
          color: pal.cotaText,
          align: 'center',
          baseline: 'middle',
          weight: 600,
          halo: pal.halo,
          ...monoFont,
        });
      }
    }
  }

  /* —— red de drenaje (drawStreams) —— */
  if (opts.streams) {
    const sp = new VecPath();
    for (const st of model.streams) {
      sp.moveTo(P.sx(st[0], st[1]), P.sy(st[0], st[1], st[2]));
      for (let i = 1; i < st.length / 3; i++) {
        sp.lineTo(P.sx(st[i * 3], st[i * 3 + 1]), P.sy(st[i * 3], st[i * 3 + 1], st[i * 3 + 2]));
      }
    }
    dl.ops.push({ op: 'path', subs: sp.subs, stroke: pal.stream, width: 1 });
  }

  /* —— divisorias + salidas (drawDivides) —— */
  if (opts.divides) {
    const dp = new VecPath();
    for (const b of model.basins) {
      const m = b.ring.length / 3;
      dp.moveTo(P.sx(b.ring[0], b.ring[1]), P.sy(b.ring[0], b.ring[1], b.ring[2]));
      for (let i = 1; i < m; i++) {
        dp.lineTo(
          P.sx(b.ring[i * 3], b.ring[i * 3 + 1]),
          P.sy(b.ring[i * 3], b.ring[i * 3 + 1], b.ring[i * 3 + 2])
        );
      }
      dp.close();
    }
    dl.ops.push({ op: 'path', subs: dp.subs, stroke: pal.divide, width: 1.6, dash: [7, 5] });

    const out = new VecPath();
    for (const b of model.basins) {
      const px = P.sx(b.outlet.x, b.outlet.y);
      const py = P.sy(b.outlet.x, b.outlet.y, b.outlet.z);
      if (px < -20 || px > P.w + 20 || py < -20 || py > P.h + 20) continue;
      out.moveTo(px, py - 5);
      out.lineTo(px + 5, py);
      out.lineTo(px, py + 5);
      out.lineTo(px - 5, py);
      out.close();
    }
    dl.ops.push({ op: 'path', subs: out.subs, fill: pal.major });
  }

  /* —— nodos del MDT (drawNodes): cuadros de 2.4 px, rejilla 6 —— */
  if (opts.nodes) {
    const np = new VecPath();
    const size = 2.4;
    for (let j = 0; j < n; j += 6) {
      const y = (j - half) * g.cell;
      for (let i = 0; i < n; i += 6) {
        const x = (i - half) * g.cell;
        const px = P.sx(x, y);
        const py = P.sy(x, y, g.h[j * n + i]);
        if (px < 0 || px > P.w || py < 0 || py > P.h) continue;
        np.moveTo(px - size / 2, py - size / 2);
        np.lineTo(px + size / 2, py - size / 2);
        np.lineTo(px + size / 2, py + size / 2);
        np.lineTo(px - size / 2, py + size / 2);
        np.close();
      }
    }
    dl.ops.push({ op: 'path', subs: np.subs, fill: pal.node });
  }

  /* —— etiquetas de subcuencas (drawBasinLabels) —— */
  if (opts.labels) {
    for (const b of model.basins) {
      const z = sampleGrid(g, b.cx, b.cy) + 42;
      const px = P.sx(b.cx, b.cy);
      const py = P.sy(b.cx, b.cy, z);
      if (px < 0 || px > P.w || py < 0 || py > P.h) continue;
      dl.ops.push({
        op: 'text',
        x: px,
        y: py,
        str: b.name,
        size: 10.5,
        color: pal.label,
        align: 'center',
        baseline: 'bottom',
        weight: 600,
        halo: pal.haloSoft,
        mono: false,
      });
    }
  }

  /* —— gizmo de ejes (drawGizmo) —— */
  {
    const gx = P.w - 52;
    const gy = P.h - 76;
    const r = 30;
    const c = P.c;
    const s = P.s;
    const es = P.es;
    const ec = P.ec;
    dl.ops.push({
      op: 'rect',
      x: gx - r - 12,
      y: gy - r - 12,
      w: (r + 12) * 2,
      h: (r + 12) * 2,
      r: r + 12,
      fill: pal.gizmoBg,
      stroke: pal.stampBorder,
      width: 1,
    });
    const axes: Array<{ dx: number; dy: number; label: string; color: string }> = [
      { dx: c, dy: -s * es, label: 'E', color: pal.axisX },
      { dx: -s, dy: -c * es, label: 'N', color: pal.axisY },
      { dx: 0, dy: -ec, label: 'Z', color: pal.axisZ },
    ];
    for (const a of axes) {
      const len = Math.hypot(a.dx, a.dy) || 1;
      const ux = a.dx / len;
      const uy = a.dy / len;
      dl.ops.push({
        op: 'path',
        subs: [{ p: [gx, gy, gx + ux * r, gy + uy * r], z: false }],
        stroke: a.color,
        width: 1.6,
      });
      dl.ops.push({
        op: 'path',
        subs: [{ p: [gx, gy, gx - ux * r * 0.6, gy - uy * r * 0.6], z: false }],
        stroke: a.color,
        width: 1.6,
        alpha: 0.35,
      });
      dl.ops.push({
        op: 'text',
        x: gx + ux * (r + 6),
        y: gy + uy * (r + 6),
        str: a.label,
        size: 9,
        color: a.color,
        align: 'center',
        baseline: 'middle',
        weight: 700,
        ...monoFont,
      });
    }
  }

  /* —— barra de escala (drawScaleBar) —— */
  {
    const pxPerM = P.S;
    const targetPx = 120;
    const rawM = targetPx / pxPerM;
    const pow = Math.pow(10, Math.floor(Math.log10(rawM)));
    let nice = pow;
    for (const m of [5, 2, 1]) {
      if (rawM >= m * pow) {
        nice = m * pow;
        break;
      }
    }
    const px = nice * pxPerM;
    const x0 = 18;
    const y0 = P.h - 112;
    dl.ops.push({
      op: 'path',
      subs: [
        { p: [x0, y0 - 4, x0, y0, x0 + px, y0, x0 + px, y0 - 4], z: false },
        { p: [x0 + px / 2, y0, x0 + px / 2, y0 - 3], z: false },
      ],
      stroke: pal.scale,
      width: 1.5,
    });
    const label =
      nice >= 1000
        ? `${(nice / 1000).toLocaleString('es-MX')} km`
        : `${nice.toLocaleString('es-MX')} m`;
    dl.ops.push({
      op: 'text',
      x: x0,
      y: y0 - 7,
      str: label,
      size: 9.5,
      color: pal.scale,
      align: 'left',
      baseline: 'bottom',
      weight: 600,
      ...monoFont,
    });
  }

  /* —— sello del marco INEGI (drawInegiStamp, espacio de pantalla) —— */
  if (opts.inegi) {
    const r = model.region;
    const compact = P.w < 560;
    const size = compact ? 8.5 : 10;
    const pre = 'INEGI · ';
    const codes = compact ? inegiCodesJoin('·') : inegiCodesJoin(' · ');
    const line2 = `MTN 1:50 000 · ${Math.abs(r.centerLat).toFixed(4)}° N ${Math.abs(
      r.centerLon
    ).toFixed(4)}° W`;
    const wPre = approxTextWidth(pre, size, true);
    const wCodes = approxTextWidth(codes, size, true);
    const w2t = approxTextWidth(line2, size, true);
    const boxW = Math.ceil(Math.max(wPre + wCodes, w2t)) + 20;
    const boxH = 36;
    const x0 = (P.w - boxW) / 2;
    const y0 = 10;
    dl.ops.push({
      op: 'rect',
      x: x0,
      y: y0,
      w: boxW,
      h: boxH,
      r: 6,
      fill: pal.stampBg,
      stroke: pal.stampBorder,
      width: 1,
    });
    dl.ops.push({
      op: 'text',
      x: x0 + 10,
      y: y0 + 12,
      str: pre,
      size,
      color: pal.inegiText,
      align: 'left',
      baseline: 'middle',
      weight: 500,
      ...monoFont,
    });
    dl.ops.push({
      op: 'text',
      x: x0 + 10 + wPre,
      y: y0 + 12,
      str: codes,
      size,
      color: pal.inegiAccent,
      align: 'left',
      baseline: 'middle',
      weight: 500,
      ...monoFont,
    });
    dl.ops.push({
      op: 'text',
      x: x0 + 10,
      y: y0 + 25,
      str: line2,
      size,
      color: pal.stampSub,
      align: 'left',
      baseline: 'middle',
      weight: 500,
      ...monoFont,
    });
  }

  /* —— cajetín del plano (ficha técnica del export, análogo a CadWatermark) —— */
  drawCajetin(dl, scene, pal);

  return dl;
}

/** Cajetín CAD del export: ficha técnica vectorial (abajo derecha). */
function drawCajetin(
  dl: DisplayList,
  scene: ExportScene,
  pal: typeof COLORS
): void {
  const { model, contours, cam } = scene;
  const r = model.region;
  const st = model.stats;
  const W = 264;
  const X0 = cam.w - W - 12;
  const Y1 = cam.h - 12;
  const fmt = (v: number, d = 0): string =>
    v.toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d });

  // Filas: cabecera, coords, 6 celdas dobles (la 6ª = datum, FR-7 · GGM25), INEGI, firma
  const H_ROW = 20;
  const H = 20 + 15 + 6 * H_ROW + 15 + 15;
  const Y0 = Y1 - H;
  const ink = pal.inegiText;
  const sub = pal.stampSub;
  const grid: VecPath = new VecPath();

  // Rejilla exterior + separadores horizontales
  grid.moveTo(X0, Y0);
  grid.lineTo(X0 + W, Y0);
  grid.lineTo(X0 + W, Y1);
  grid.lineTo(X0, Y1);
  grid.close();
  let yy = Y0 + 20;
  grid.moveTo(X0, yy);
  grid.lineTo(X0 + W, yy);
  yy += 15;
  grid.moveTo(X0, yy);
  grid.lineTo(X0 + W, yy);
  for (let i = 0; i < 6; i++) {
    yy += H_ROW;
    grid.moveTo(X0, yy);
    grid.lineTo(X0 + W, yy);
  }
  yy += 15;
  grid.moveTo(X0, yy);
  grid.lineTo(X0 + W, yy);
  // Separador vertical de las filas dobles
  const xMid = X0 + W / 2;
  for (let i = 0; i < 6; i++) {
    const yTop = Y0 + 35 + i * H_ROW;
    grid.moveTo(xMid, yTop);
    grid.lineTo(xMid, yTop + H_ROW);
  }
  dl.ops.push({ op: 'path', subs: grid.subs, stroke: pal.frame, width: 1 });

  const cell = (
    x: number,
    y: number,
    label: string,
    value: string,
    accent = false
  ): void => {
    dl.ops.push({
      op: 'text',
      x,
      y,
      str: label,
      size: 7,
      color: sub,
      align: 'left',
      baseline: 'middle',
      weight: 500,
      ...{ mono: false },
    });
    dl.ops.push({
      op: 'text',
      x,
      y: y + 9,
      str: value,
      size: 9,
      color: accent ? pal.inegiAccent : ink,
      align: 'left',
      baseline: 'middle',
      weight: 500,
      ...{ mono: true },
    });
  };

  // Cabecera: región + superficie
  dl.ops.push({
    op: 'text',
    x: X0 + 8,
    y: Y0 + 10,
    str: r.name.toUpperCase(),
    size: 9,
    color: ink,
    align: 'left',
    baseline: 'middle',
    weight: 600,
    mono: false,
  });
  dl.ops.push({
    op: 'text',
    x: X0 + W - 8,
    y: Y0 + 10,
    str: `${fmt(r.areaHa)} ha ${r.areaApprox ? '· aprox' : '· SMAOT'}`,
    size: 9,
    color: sub,
    align: 'right',
    baseline: 'middle',
    weight: 500,
    ...{ mono: true },
  });
  // Coordenadas del centro
  dl.ops.push({
    op: 'text',
    x: X0 + 8,
    y: Y0 + 27,
    str: `${Math.abs(r.centerLat).toFixed(4)}° N · ${Math.abs(r.centerLon).toFixed(4)}° W`,
    size: 9,
    color: sub,
    align: 'left',
    baseline: 'middle',
    weight: 500,
    ...{ mono: true },
  });
  // Ficha técnica (2 columnas)
  const rows: Array<[string, string, string, string]> = [
    ['Sup. modelo', st ? `${fmt(st.areaModelHa)} ha` : '—', 'Perímetro', st ? `${fmt(st.dividePerimeterKm, 1)} km` : '—'],
    ['Desnivel', st ? `${fmt(st.desnivel)} m` : '—', 'Pendiente', st ? `${fmt(st.slopePct, 1)} %` : '—'],
    ['Niveles', fmt(contours.levels.length), 'Maestras', fmt(contours.maestraCount)],
    ['Segmentos', fmt(contours.totalSegs), 'Cauces', st ? fmt(st.streams) : '—'],
    ['Motor', 'CPU · 0 GPU', 'MXP1', `${packRegionSeed(r).length}c · semilla ${r.seed}`],
    /* FR-7 · GGM25 (contrato de aceptación de la unidad): la fila de datum
       declara el datum vertical vigente — sin geoides, el honesto
       «WGS84 (elipsoidal)»; con geoides ingestado, «GGM25 (ortométrica)»
       (la cota del GPS pasa a ortométrica con toOrthometric). */
    ['Datum', scene.verticalDatum ?? 'WGS84 (elipsoidal)', 'Geoid', scene.verticalDatum ? 'ortométrica' : '—'],
  ];
  for (let i = 0; i < rows.length; i++) {
    const yTop = Y0 + 35 + i * H_ROW;
    cell(X0 + 8, yTop + 5, rows[i][0], rows[i][1]);
    cell(xMid + 8, yTop + 5, rows[i][2], rows[i][3]);
  }
  // Marco INEGI (acento)
  dl.ops.push({
    op: 'text',
    x: X0 + 8,
    y: Y1 - 22,
    str: `INEGI MTN 1:50 000 · ${inegiCodesJoin(' · ')}`,
    size: 9,
    color: pal.inegiAccent,
    align: 'left',
    baseline: 'middle',
    weight: 500,
    ...{ mono: true },
  });
  // Firma de marca
  dl.ops.push({
    op: 'text',
    x: X0 + 8,
    y: Y1 - 7,
    str: `${BRAND} v${SDK_VERSION}`,
    size: 8,
    color: sub,
    align: 'left',
    baseline: 'middle',
    weight: 500,
    ...{ mono: true },
  });
  dl.ops.push({
    op: 'text',
    x: xMid,
    y: Y1 - 7,
    str: `Sello ${QUALITY_SEAL}`,
    size: 8,
    color: sub,
    align: 'center',
    baseline: 'middle',
    weight: 500,
    ...{ mono: true },
  });
  dl.ops.push({
    op: 'text',
    x: X0 + W - 8,
    y: Y1 - 7,
    str: DEVELOPER,
    size: 8,
    color: sub,
    align: 'right',
    baseline: 'middle',
    weight: 500,
    ...{ mono: true },
  });
}

/* ------------------------------------------------------------------ */
/* Serializador SVG 1.1                                                */
/* ------------------------------------------------------------------ */

const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS_STACK = 'ui-sans-serif, system-ui, sans-serif';

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pathD(subs: Sub[]): string {
  const out: string[] = [];
  for (const s of subs) {
    if (s.p.length < 4) continue;
    out.push(`M${r2(s.p[0])} ${r2(s.p[1])}`);
    for (let i = 2; i < s.p.length; i += 2) {
      out.push(`L${r2(s.p[i])} ${r2(s.p[i + 1])}`);
    }
    if (s.z) out.push('Z');
  }
  return out.join('');
}

function roundRectD(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return (
    `M${r2(x + rr)} ${r2(y)}H${r2(x + w - rr)}A${r2(rr)} ${r2(rr)} 0 0 1 ${r2(x + w)} ${r2(y + rr)}` +
    `V${r2(y + h - rr)}A${r2(rr)} ${r2(rr)} 0 0 1 ${r2(x + w - rr)} ${r2(y + h)}` +
    `H${r2(x + rr)}A${r2(rr)} ${r2(rr)} 0 0 1 ${r2(x)} ${r2(y + h - rr)}` +
    `V${r2(y + rr)}A${r2(rr)} ${r2(rr)} 0 0 1 ${r2(x + rr)} ${r2(y)}Z`
  );
}

export function serializeSvg(dl: DisplayList, scene: ExportScene): string {
  const { model, cam, opts } = scene;
  const pal = opts.eink ? EINK_COLORS : opts.day ? DAY_COLORS : COLORS;
  const r = model.region;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cam.w}" height="${cam.h}" viewBox="0 0 ${cam.w} ${cam.h}">`
  );
  parts.push(
    `<title>${escXml(`${BRAND} · ${r.name} — curvas de nivel 1 m / 25 m`)}</title>`
  );
  parts.push(
    `<desc>${escXml(
      `Export vectorial WYSIWYG del visor isométrico ${BRAND}. Motor CPU 0 GPU determinista ` +
        `· curvas 1 m / maestras 25 m · marco INEGI MTN 1:50 000 · sello ${QUALITY_SEAL} · ${DEVELOPER}. ` +
        `Proyección ortográfica az ${((cam.az * 180) / Math.PI).toFixed(1)}° el ${((cam.el * 180) / Math.PI).toFixed(1)}° zoom ${cam.zoom.toFixed(2)}×.`
    )}</desc>`
  );
  parts.push(
    `<metadata>${escXml(
      `${BRAND} ${SDK_VERSION} · ${QUALITY_SEAL} · ${DEVELOPER} · región ${r.id} · MDT ` +
        (opts.eink ? 'E-Ink B/N' : opts.day ? 'paleta día' : 'paleta estándar') +
        ' · determinista byte a byte'
    )}</metadata>`
  );
  parts.push(`<rect width="${cam.w}" height="${cam.h}" fill="${pal.bg}"/>`);

  for (const op of dl.ops) {
    const alpha = op.alpha !== undefined && op.alpha !== 1 ? ` opacity="${op.alpha}"` : '';
    if (op.op === 'path') {
      const d = pathD(op.subs);
      if (!d) continue;
      if (op.fill) {
        parts.push(`<path d="${d}" fill="${op.fill}" stroke="none"${alpha}/>`);
      } else {
        const dash = op.dash ? ` stroke-dasharray="${op.dash.join(' ')}"` : '';
        parts.push(
          `<path d="${d}" fill="none" stroke="${op.stroke}" stroke-width="${op.width ?? 1}"${dash}${alpha}/>`
        );
      }
    } else if (op.op === 'rect') {
      const d = roundRectD(op.x, op.y, op.w, op.h, op.r);
      const fill = op.fill ? ` fill="${op.fill}"` : ' fill="none"';
      const stroke = op.stroke ? ` stroke="${op.stroke}" stroke-width="${op.width ?? 1}"` : '';
      parts.push(`<path d="${d}"${fill}${stroke}${alpha}/>`);
    } else {
      const anchor = op.align === 'center' ? 'middle' : 'start';
      const domBase = op.baseline === 'middle' ? 'central' : 'text-after-edge';
      const font = op.mono ? MONO_STACK : SANS_STACK;
      const halo = op.halo
        ? ` stroke="${op.halo}" stroke-width="3" paint-order="stroke" stroke-linejoin="round"`
        : '';
      parts.push(
        `<text x="${r2(op.x)}" y="${r2(op.y)}" font-family="${font}" font-size="${op.size}" ` +
          `font-weight="${op.weight}" fill="${op.color}"${halo}${alpha} ` +
          `text-anchor="${anchor}" dominant-baseline="${domBase}">${escXml(op.str)}</text>`
      );
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* Serializador PDF 1.4 — escritor propio, 0 dependencias              */
/* ------------------------------------------------------------------ */

/** Latin-1 (WinAnsi para nuestro alfabeto); fuera de rango → '?'. */
function latin1(s: string): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i] = c < 256 ? c : 63;
  }
  return b;
}

/** Caracteres CP1252 (WinAnsi) fuera de Latin-1 → byte alto. */
const CP1252_HIGH: Record<string, number> = {
  '\u2014': 0x97, // — em dash
  '\u2013': 0x96, // – en dash
  '\u2018': 0x91,
  '\u2019': 0x92,
  '\u201C': 0x93,
  '\u201D': 0x94,
  '\u2026': 0x85,
  '\u20AC': 0x80,
};

function escPdfStr(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '(' || ch === ')' || ch === '\\') {
      out += '\\' + ch;
    } else {
      const c = ch.codePointAt(0) ?? 63;
      if (c < 256) out += ch;
      else if (CP1252_HIGH[ch] !== undefined) out += String.fromCharCode(CP1252_HIGH[ch]);
      else out += '?';
    }
  }
  return out;
}

/** FlateDecode (zlib RFC 1950) con CompressionStream nativo; null si no hay. */
async function deflateZlib(s: string): Promise<Uint8Array | null> {
  try {
    if (typeof CompressionStream === 'undefined') return null;
    const cs = new CompressionStream('deflate');
    const stream = new Blob([latin1(s)]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** roundRect como trayectoria PDF (curvas Bézier, k = 0.5523). */
function pdfRoundRect(
  out: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  const k = rr * 0.5523;
  const seg = (n: number): string => fmt2(n);
  out.push(
    `${seg(x + rr)} ${seg(y)} m`,
    `${seg(x + w - rr)} ${seg(y)} l`,
    `${seg(x + w - rr + k)} ${seg(y)} ${seg(x + w)} ${seg(y + rr - k)} ${seg(x + w)} ${seg(y + rr)} c`,
    `${seg(x + w)} ${seg(y + h - rr)} l`,
    `${seg(x + w)} ${seg(y + h - rr + k)} ${seg(x + w - rr + k)} ${seg(y + h)} ${seg(x + w - rr)} ${seg(y + h)} c`,
    `${seg(x + rr)} ${seg(y + h)} l`,
    `${seg(x + rr - k)} ${seg(y + h)} ${seg(x)} ${seg(y + h - rr + k)} ${seg(x)} ${seg(y + h - rr)} c`,
    `${seg(x)} ${seg(y + rr)} l`,
    `${seg(x)} ${seg(y + rr - k)} ${seg(x + rr - k)} ${seg(y)} ${seg(x + rr)} ${seg(y)} c`,
    'h'
  );
}

export async function serializePdf(
  dl: DisplayList,
  scene: ExportScene
): Promise<Blob> {
  const { model, cam, opts } = scene;
  const r = model.region;
  const W = cam.w;
  const H = cam.h;

  /* —— flujo de contenido —— */
  const c: string[] = [];
  // CTM global: coordenadas de lienzo (Y hacia abajo) → espacio de página
  c.push(`q 1 0 0 -1 0 ${fmt2(H)} cm`);
  const alphas = new Map<number, string>();
  const gsFor = (a: number): string => {
    const key = Math.round(a * 100) / 100;
    let name = alphas.get(key);
    if (!name) {
      name = `/GS${alphas.size}`;
      alphas.set(key, name);
    }
    return `${name} gs`;
  };
  const colRG = (s: string): string => {
    const p = parseColor(s);
    return `${fmt2(p.r)} ${fmt2(p.g)} ${fmt2(p.b)} RG`;
  };
  const colRGFill = (s: string): string => {
    const p = parseColor(s);
    return `${fmt2(p.r)} ${fmt2(p.g)} ${fmt2(p.b)} rg`;
  };

  for (const op of dl.ops) {
    const alphaPre = op.alpha !== undefined && op.alpha !== 1 ? gsFor(op.alpha) + '\n' : '';
    if (op.op === 'path') {
      const segs: string[] = [];
      for (const s of op.subs) {
        if (s.p.length < 4) continue;
        segs.push(`${r2(s.p[0])} ${r2(s.p[1])} m`);
        for (let i = 2; i < s.p.length; i += 2) {
          segs.push(`${r2(s.p[i])} ${r2(s.p[i + 1])} l`);
        }
        if (s.z) segs.push('h');
      }
      if (segs.length === 0) continue;
      c.push(alphaPre + segs.join('\n'));
      if (op.fill) {
        c.push(`${colRGFill(op.fill)} f`);
      } else {
        const dash = op.dash ? `[${op.dash.join(' ')}] 0 d` : '[] 0 d';
        c.push(
          `${fmt2(op.width ?? 1)} w\n${dash}\n${colRG(op.stroke ?? '#000')} S`
        );
      }
    } else if (op.op === 'rect') {
      if (op.fill && !op.stroke) {
        c.push(`${alphaPre}${colRGFill(op.fill)} rg`);
        c.push(`${fmt2(op.x)} ${fmt2(op.y)} ${fmt2(op.w)} ${fmt2(op.h)} re f`);
      } else {
        c.push(alphaPre);
        const segs: string[] = [];
        pdfRoundRect(segs, op.x, op.y, op.w, op.h, op.r);
        c.push(segs.join('\n'));
        if (op.fill) c.push(`${colRGFill(op.fill)} rg f`);
        if (op.stroke) {
          c.push(`${fmt2(op.width ?? 1)} w ${colRG(op.stroke)} S`);
        }
      }
    } else {
      // Texto: dentro del CTM volteado, Tm [1 0 0 -1 x y] endereza los glifos
      const fontRef = op.mono ? (op.weight >= 600 ? '/F3' : '/F1') : op.weight >= 600 ? '/F4' : '/F2';
      let tx = op.x;
      let ty = op.y;
      if (op.align === 'center') tx -= approxTextWidth(op.str, op.size, op.mono) / 2;
      if (op.baseline === 'middle') ty += op.size * 0.35;
      else ty -= op.size * 0.21;
      const head = `BT /${fontRef.slice(1)} ${op.size} Tf ${colRGFill(op.color)} rg`;
      const halo = op.halo ? ` 2 Tr ${fmt2(3)} w ${colRG(op.halo)} RG` : '';
      c.push(
        `${alphaPre}${head}${halo} 1 0 0 -1 ${fmt2(tx)} ${fmt2(ty)} Tm (${escPdfStr(op.str)}) Tj ET`
      );
    }
  }
  c.push('Q');
  const streamStr = c.join('\n');

  const compressed = await deflateZlib(streamStr);
  const streamBody = compressed ?? latin1(streamStr);
  const streamHead = compressed
    ? `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`
    : `<< /Length ${streamBody.length} >>\nstream\n`;

  /* —— objetos del documento —— */
  const now = new Date();
  const p2 = (v: number): string => String(v).padStart(2, '0');
  const dStr = `D:${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(
    now.getUTCDate()
  )}${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}'00'`;
  const azDeg = ((cam.az * 180) / Math.PI).toFixed(1);
  const elDeg = ((cam.el * 180) / Math.PI).toFixed(1);

  // Numeración fija: 1 Cat, 2 Pages, 3 Page, 4 Contenido, 5-8 fuentes, 9 Info, 10.. GS
  const gsObjNums = alphas.size > 0 ? ` /ExtGState << ${[...alphas.entries()].map(([, name], i) => `${name.slice(1)} ${10 + i} 0 R`).join(' ')} >>` : '';

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt2(W)} ${fmt2(H)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >>${gsObjNums} >> /Contents 4 0 R >>`,
    streamHead, // marcador especial: cuerpo binario aparte
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${escPdfStr(`${BRAND} · ${r.name} — curvas de nivel 1 m / 25 m`)}) /Author (${escPdfStr(DEVELOPER)}) /Producer (${escPdfStr(`${BRAND} · ${QUALITY_SEAL} SDK ${SDK_VERSION} — Motor CPU 0 GPU determinista`)}) /Creator (${escPdfStr('Visor isométrico de microcuencas de Guanajuato')}) /Subject (${escPdfStr(`Export vectorial WYSIWYG · az ${azDeg}° el ${elDeg}° · INEGI MTN 1:50 000`)}) /Keywords (${escPdfStr('INEGI, curvas de nivel, MDT, Guanajuato, 0 GPU, vectorial')}) /CreationDate (${dStr}) >>`,
  ];
  for (const [a, name] of alphas.entries()) {
    objects.push(`<< /Type /ExtGState /CA ${Math.round(a * 100) / 100} /ca ${Math.round(a * 100) / 100} >>`);
  }

  /* —— ensamblado con tabla xref exacta —— */
  const parts: Uint8Array[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (b: Uint8Array): void => {
    parts.push(b);
    offset += b.length;
  };

  push(latin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
  for (let i = 0; i < objects.length; i++) {
    const num = i + 1;
    offsets.push(offset);
    if (i === 3) {
      // objeto 4: contenido (string de cabecera + cuerpo binario + endstream)
      push(latin1(`${num} 0 obj\n${objects[i]}`));
      push(streamBody);
      push(latin1('\nendstream\nendobj\n'));
      continue;
    }
    push(latin1(`${num} 0 obj\n${objects[i]}\nendobj\n`));
  }

  const xrefStart = offset;
  const total = objects.length + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${total} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  push(latin1(xref));

  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

/* ------------------------------------------------------------------ */
/* Descarga                                                            */
/* ------------------------------------------------------------------ */

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
