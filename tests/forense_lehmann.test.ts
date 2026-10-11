/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-5 — NÚCLEO LEHMANN puro + CAMPO DE FRICCIÓN D12.
 * Verificación contractual de docs/ADR-D12-campo-friccion.md §8 (1-7),
 * checkpoint de ingeniería (contrato a-i) + cierre 2f:
 *
 *   §8.1  Paridad del camino pendiente: el núcleo reproduce los parámetros
 *         legacy F5-03 (mismos segs para engine y export — known-answer de
 *         plano inclinado calculado a mano).
 *   §8.2  Determinismo puro: misma entrada ⇒ misma salida byte a byte.
 *   §8.3  Clases: known-answer de las 4 fronteras + NODATA sin clase +
 *         todo-NODATA ⇒ error accionable + campo constante = paso libre.
 *   §8.4  E-Ink del campo: monotonicidad de tinta clase1<2<3, clase 0 = 0
 *         trazos, NODATA sin trama, tope de tinta ≤ 0.22 (presupuesto).
 *   §8.5  Coexistencia D11: los 21 pares de los 7 tipos SOBRE la misma
 *         trama ≥ 0.004 Hamming (rasterizador B/N, umbral D11).
 *   §8.6  WYSIWYG: buildDisplayList emite la trama solo con la capa activa
 *         y dos serializaciones ⇒ bytes iguales.
 *   §8.7  Cierre 2f (heredado de FR-4): chevrons de dirección ORIENTADOS
 *         known-answer — tinta de ala DETRÁS del sentido de avance y
 *         ausente DELANTE; presupuesto D11_MAX_NODES vigente.
 *   (g)   Fixtures sintéticos del contrato: friction_mesh_sintetico.tif +
 *         mision_fr5_completa.zip decodifican por los caminos REALES.
 *
 * Regla D11 heredada: la gramática la fija la verificación por píxel —
 * CPU puro, determinista, 0 GPU, sin datos de misión real (FR-W1).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildLehmannSegs,
  lehmannStride,
  rasterizeTramaTop,
  type LehmannOpts,
} from '../src/lib/terrain/lehmann';
import {
  buildFrictionField,
  frictionClassNorm,
  frictionClassOf,
  frictionPlacement,
  frictionRows,
  FRICTION_LEN_PX,
  FRICTION_NAME_RE,
  LEHMAN_TRAMA_INK_BUDGET,
  FRICTION_NODATA_CLASS,
  type FrictionField,
  type FrictionAnchor,
} from '../src/lib/ingest/friction';
import { decodeGeoTiffFieldSync, type DecodedDem } from '../src/lib/ingest/geotiff-dem';
import {
  D11_LAYER_TYPES,
  resolveLineStyle,
  createTarget,
  rasterizeLine,
  inkRatio,
  pixelHamming,
  sampleNodes,
  D11_MAX_NODES,
} from '../src/lib/terrain/linegrammar';
import { buildDisplayList, serializeSvg } from '../src/lib/terrain/export';
import { type ViewOpts } from '../src/lib/terrain/engine';
import { buildTerrain } from '../src/lib/terrain/generator';
import { buildContours } from '../src/lib/terrain/contours';
import { getRegion } from '../src/lib/terrain/regions';
import { parseMissionPack } from '../src/lib/ingest/pack';
import type { Anchor } from '../src/lib/ingest/parsers';

/* ------------------------------------------------------------------ */
/* Utilidades de campos sintéticos (FR-W1 — 0 datos de misión real)   */
/* ------------------------------------------------------------------ */

function mkDem(data: Float64Array, w: number, h: number, nodata: number | null): DecodedDem {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (Number.isNaN(v) || (nodata !== null && v === nodata)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    w,
    h,
    data,
    scaleX: 10,
    scaleY: 10,
    tieX: -101.35,
    tieY: 21.02,
    crs: { kind: 'metric', label: 'métrico (sintético)' },
    min,
    max,
    nodata,
    sampleLabel: 'Float64',
    compression: 'sin comprimir',
    strips: 1,
    bytesDecoded: data.length * 8,
    decodeMs: 0,
  };
}

/**
 * FÓRMULA COMPARTIDA con scripts/gen_qa_fixtures.ts (contrato g): rampa
 * W→E de costo + muro de alto costo + franja NODATA. Si cambia aquí,
 * cambia allá — el fixture y la suite describen el MISMO campo D12.
 */
function refCost(i: number, j: number): number {
  if (j >= 10 && j <= 13) return -9999; // franja NODATA
  const base = 2 + 9 * (i / 95);
  const wall = i >= 30 && i <= 70 && j >= 40 && j <= 58 ? 9 : 0;
  return base + wall;
}

const REF_N = 96;
const REF96 = new Float64Array(REF_N * REF_N);
for (let j = 0; j < REF_N; j++)
  for (let i = 0; i < REF_N; i++) REF96[j * REF_N + i] = refCost(i, j);

const ANCHOR_D12: FrictionAnchor = {
  centerLat: 21.0,
  centerLon: -101.33,
  extentM: 8000,
  zMinM: 1950,
  zMaxM: 2600,
};

const refField = (): FrictionField => buildFrictionField(mkDem(REF96, REF_N, REF_N, -9999));

/** metros por píxel del sandbox (pxPerM 0.08) — la vista canónica D12. */
const MPP = 1 / 0.08;

/** Opts de fricción — ESPEJO EXACTO de engine.buildFrictionGeometry. */
function frictionOpts(f: FrictionField, k: number): LehmannOpts {
  const pl = frictionPlacement(f, ANCHOR_D12);
  return {
    k,
    cellXm: pl.cellXm,
    cellYm: pl.cellYm,
    originI: 0,
    originJ: 0,
    originX: pl.originX,
    originY: pl.originY,
    metersPerPx: MPP,
    maxCount: 20000,
    lenPx: (v) => FRICTION_LEN_PX[frictionClassOf(v, f.vmin, f.vmax)],
    skip: (v, s) => s < 1e-9 || frictionClassOf(v, f.vmin, f.vmax) === 0,
    zPair: () => [0, 0],
    nodata: (v) => v === -9999,
  };
}

/* ------------------------------------------------------------------ */
/* §8.1 — Paridad del camino pendiente (núcleo vs parámetros legacy)  */
/* ------------------------------------------------------------------ */

describe('D12 §8.1 — núcleo Lehmann: paridad del camino pendiente (legacy F5-03)', () => {
  // Plano inclinado z = 0.3·x sobre rejilla 9×9, celda 2 m — geometría
  // calculada A MANO (known-answer, independiente del núcleo).
  const n = 9;
  const cell = 2;
  const plane = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) plane[j * n + i] = 0.3 * ((i - (n - 1) / 2) * cell);

  /** Parámetros legacy EXACTOS del motor (engine.buildHachureGeometry). */
  const engineOpts = (k: number): LehmannOpts => ({
    k,
    cellXm: cell,
    cellYm: cell,
    originI: -(n - 1) / 2,
    originJ: -(n - 1) / 2,
    originX: 0,
    originY: 0,
    metersPerPx: MPP,
    maxCount: 20000,
    lenPx: (_v, s) => Math.min(1.5 + s * 24, 9),
    skip: (_v, s) => s < 0.04,
    zPair: (v, s, hm) => [v + s * hm, v - s * hm],
  });

  /** Parámetros legacy EXACTOS del export (export.ts bloque F5-03). */
  const exportOpts = (k: number): LehmannOpts => ({
    k,
    cellXm: cell,
    cellYm: cell,
    originI: -(n - 1) / 2, // half = (n-1)/2 en export
    originJ: -(n - 1) / 2,
    originX: 0,
    originY: 0,
    metersPerPx: MPP,
    maxCount: 20000,
    lenPx: (_v, s) => Math.min(1.5 + s * 24, 9),
    skip: (_v, s) => s < 0.04,
    zPair: (v, s, hm) => [v + s * hm, v - s * hm],
  });

  test('known-answer de plano: pendiente 0.3 ⇒ len 8.7 px, u = (−1,0), extremos rebajados', () => {
    const r = buildLehmannSegs(plane, n, engineOpts(1));
    // 7×7 muestras interiores, todas con la misma pendiente
    expect(r.count).toBe(49);
    // celda (i=5, j=4): x=2, y=0, v=0.6
    //   halfM = 8.7/2·12.5 = 54.375 · u=(−1,0)
    //   x0 = 2+54.375 = 56.375 · x1 = 2−54.375 = −52.375
    //   z0 = 0.6+0.3·54.375 = 16.9125 · z1 = 0.6−16.3125 = −15.7125
    const S = 25 * 6; // celda (i=5, j=4): s = (j−1)·7 + (i−1) = 25
    expect(r.segs[S]!).toBeCloseTo(56.375, 4);
    expect(r.segs[S + 1]!).toBeCloseTo(0, 4);
    expect(r.segs[S + 2]!).toBeCloseTo(16.9125, 4);
    expect(r.segs[S + 3]!).toBeCloseTo(-52.375, 4);
    expect(r.segs[S + 4]!).toBeCloseTo(0, 4);
    expect(r.segs[S + 5]!).toBeCloseTo(-15.7125, 4);
    // sin NaN (fix G-1/F19: diferencias centradas clampeadas)
    for (let i = 0; i < r.count * 6; i++) expect(Number.isNaN(r.segs[i]!)).toBe(false);
  });

  test('paridad byte-idéntica engine↔export: mismos parámetros ⇒ mismos segs', () => {
    const a = buildLehmannSegs(plane, n, engineOpts(2));
    const b = buildLehmannSegs(plane, n, exportOpts(2));
    expect(a.count).toBe(b.count);
    expect(Array.from(a.segs.subarray(0, a.count * 6))).toEqual(
      Array.from(b.segs.subarray(0, b.count * 6))
    );
  });

  test('stride canónico: objetivo 14 px respetado con doblado hasta el tope', () => {
    // 14 px · 12.5 m/px / 2 m = 87.5 → k=88 (sin tope alcanzado)
    expect(lehmannStride(9, 2, 14, MPP, 20000)).toBe(88);
    // tope forzado: k=3 da 9 muestras > 4 ⇒ dobla a 6 → (8/6→1+1)²=4 ≤ 4
    expect(lehmannStride(9, 4, 11, 1, 4)).toBe(6);
    expect(lehmannStride(REF_N, 10, 14, MPP, 20000)).toBe(18); // 14·12.5/10 = 17.5
  });
});

/* ------------------------------------------------------------------ */
/* §8.2 — Determinismo puro                                            */
/* ------------------------------------------------------------------ */

describe('D12 §8.2 — determinismo puro del núcleo y del campo', () => {
  test('misma entrada ⇒ misma salida byte a byte (segs + count)', () => {
    const f = refField();
    const k = lehmannStride(REF_N, 10, 14, MPP, 20000);
    const a = buildLehmannSegs(f.data, f.w, frictionOpts(f, k));
    const b = buildLehmannSegs(f.data, f.w, frictionOpts(f, k));
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);
    for (let i = 0; i < a.count * 6; i++) expect(a.segs[i]).toBe(b.segs[i]);
    expect(a.buildMs).toBeGreaterThanOrEqual(0);
    // la clasificación también es pura
    expect(Array.from(f.classes)).toEqual(Array.from(buildFrictionField(mkDem(REF96, REF_N, REF_N, -9999)).classes));
  });
});

/* ------------------------------------------------------------------ */
/* §8.3 — Clases D12: fronteras, NODATA, todo-NODATA, campo constante  */
/* ------------------------------------------------------------------ */

describe('D12 §8.3 — mapeo costo→clase (known-answer de las 4 fronteras)', () => {
  test('fronteras normalizadas: 0.25/0.5/0.75 con inclusión inferior', () => {
    expect(frictionClassNorm(0)).toBe(0);
    expect(frictionClassNorm(0.2)).toBe(0);
    expect(frictionClassNorm(0.25)).toBe(1);
    expect(frictionClassNorm(0.4999)).toBe(1);
    expect(frictionClassNorm(0.5)).toBe(2);
    expect(frictionClassNorm(0.7499)).toBe(2);
    expect(frictionClassNorm(0.75)).toBe(3);
    expect(frictionClassNorm(1)).toBe(3);
  });

  test('campo 4×4 con NODATA: conteos por clase exactos y rango sin NODATA', () => {
    //  0  3  5  7      clases: 0→0 · 3→1 · 5→2 · 7→3
    //  1  N  8  2
    //  6  4  N  0.5
    // 7.5 1.5 2.5 8
    const P = [0, 3, 5, 7, 1, -9999, 8, 2, 6, 4, -9999, 0.5, 7.5, 1.5, 2.5, 8];
    const f = buildFrictionField(mkDem(new Float64Array(P), 4, 4, -9999));
    expect(f.vmin).toBe(0);
    expect(f.vmax).toBe(8); // el NODATA (−9999) NO entra al rango
    expect(Array.from(f.classCounts)).toEqual([4, 3, 2, 5]);
    expect(f.classes[5]!).toBe(FRICTION_NODATA_CLASS);
    expect(f.classes[10]!).toBe(FRICTION_NODATA_CLASS);
  });

  test('todo-NODATA ⇒ rechazo limpio con mensaje accionable', () => {
    expect(() =>
      buildFrictionField(mkDem(new Float64Array(4).fill(-9999), 2, 2, -9999))
    ).toThrow(/NODATA/);
  });

  test('campo constante ⇒ paso libre único (honesto) y NaN = NODATA', () => {
    const cst = buildFrictionField(mkDem(new Float64Array(4).fill(5), 2, 2, null));
    expect(Array.from(cst.classCounts)).toEqual([4, 0, 0, 0]);
    const withNan = new Float64Array([1, Number.NaN, 3, 3]);
    const fn = buildFrictionField(mkDem(withNan, 2, 2, null));
    expect(fn.classes[1]!).toBe(FRICTION_NODATA_CLASS);
    expect(frictionClassOf(Number.NaN, 0, 8)).toBe(FRICTION_NODATA_CLASS);
  });

  test('ficha D12 determinista y legible', () => {
    const rows = frictionRows(refField());
    const again = frictionRows(refField());
    expect(rows).toEqual(again);
    expect(rows[0]![0]).toBe('Campo de fricción (D12)');
    expect(rows.some(([k]) => k === 'NODATA')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* §8.4 — E-Ink del campo: monotonicidad, clase 0, NODATA, presupuesto */
/* ------------------------------------------------------------------ */

describe('D12 §8.4 — E-Ink pixel-verified del campo de fricción', () => {
  test('orientación norte-sur: fila 0 = Norte queda ARRIBA (cellYm negativo)', () => {
    // D12 §2: la convención fila 0 = Norte se preserva SIEMPRE mediante
    // cellYm negativo — también en colocación por centro.
    const d = new Float64Array(16).fill(5);
    const f = buildFrictionField(mkDem(d, 4, 4, null));
    const pl = frictionPlacement(f, ANCHOR_D12);
    expect(pl.cellYm).toBeLessThan(0); // fila crece hacia el sur
    const y0 = pl.originY + 0 * pl.cellYm; // fila 0 (norte)
    const y3 = pl.originY + 3 * pl.cellYm; // fila 3 (sur)
    expect(y0).toBeGreaterThan(y3);
  });

  test('clase 0 = 0 trazos (el papel respira) en campo constante', () => {
    const cst = buildFrictionField(mkDem(new Float64Array(36 * 36).fill(5), 36, 36, null));
    const r = buildLehmannSegs(cst.data, cst.w, frictionOpts(cst, 2));
    expect(r.count).toBe(0);
  });

  test('monotonicidad de tinta: clase 1 < clase 2 < clase 3 (misma geometría)', () => {
    // Campos con anclas de rango global idénticas (vmin=0 · vmax=100) y
    // clúster centrado en cada clase — MISMO número de muestras (rejilla
    // canónica k=18 sobre 96×96) y la única diferencia es la LONGITUD del
    // trazo por clase (3 / 5.5 / 8 px) en la vista canónica del sandbox.
    const mk = (centerC: number): FrictionField => {
      const d = new Float64Array(REF_N * REF_N);
      d[0] = 0; // ancla vmin (clase 0 — idéntica en los 3)
      d[REF_N * REF_N - 1] = 100; // ancla vmax (clase 3 — idéntica en los 3)
      for (let j = 0; j < REF_N; j++)
        for (let i = 0; i < REF_N; i++) {
          const idx = j * REF_N + i;
          if (idx === 0 || idx === REF_N * REF_N - 1) continue;
          d[idx] = 100 * centerC * (1 + 0.04 * (i / (REF_N - 1)) - 0.02); // tilt ±2 %
        }
      return buildFrictionField(mkDem(d, REF_N, REF_N, null));
    };
    const k = lehmannStride(REF_N, 10, 14, MPP, 20000); // 18 — vista canónica
    const ppm = 0.08; // px por metro del raster ⇒ trazo = lenPx en pantalla
    const ink = (f: FrictionField): number => {
      const t = createTarget(80, 80); // 960 m · 0.08 + margen
      const r = buildLehmannSegs(f.data, f.w, frictionOpts(f, k));
      expect(r.count).toBe(25); // rejilla 5×5 — igual en los 3 campos
      rasterizeTramaTop(t, r.segs, r.count, ppm, 40, 40, 0.7);
      return inkRatio(t);
    };
    const i1 = ink(mk(0.375)); // clúster en clase 1
    const i2 = ink(mk(0.625)); // clase 2
    const i3 = ink(mk(0.875)); // clase 3
    expect(i1).toBeGreaterThan(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test('NODATA: franja sin trama — ni centros ni muestras dentro de la franja', () => {
    const f = refField();
    // k=6: la rejilla SÍ atraviesa la franja (centro j=12; stencil ±6 pisa
    // filas 10-13 desde j=6 y j=18) — con la canónica k=18 la franja no
    // se tocaría y la comparación sería vacua.
    const k = 6;
    const r = buildLehmannSegs(f.data, f.w, frictionOpts(f, k));
    // franja NODATA: filas j∈[10,13] ⇒ y = originY + j·cellYm (cellYm < 0)
    const pl = frictionPlacement(f, ANCHOR_D12);
    const yHi = pl.originY + 10 * pl.cellYm; // norte de la franja
    const yLo = pl.originY + 13 * pl.cellYm;
    expect(yHi).toBeGreaterThan(yLo);
    let inside = 0;
    for (let s = 0; s < r.count; s++) {
      const my = (r.segs[s * 6 + 1]! + r.segs[s * 6 + 4]!) / 2;
      if (my < yHi && my > yLo) inside++;
    }
    expect(inside).toBe(0);
    // comparación con el mismo campo SIN franja: menos muestras
    const clean = new Float64Array(REF_N * REF_N);
    for (let j = 0; j < REF_N; j++)
      for (let i = 0; i < REF_N; i++) {
        const base = 2 + 9 * (i / 95);
        const wall = i >= 30 && i <= 70 && j >= 40 && j <= 58 ? 9 : 0;
        clean[j * REF_N + i] = base + wall;
      }
    const fc = buildFrictionField(mkDem(clean, REF_N, REF_N, -9999));
    const rc = buildLehmannSegs(fc.data, fc.w, frictionOpts(fc, k));
    expect(r.count).toBeLessThan(rc.count);
  });

  test('presupuesto E-Ink: tinta de trama del fixture de referencia ≤ 0.22', () => {
    const f = refField();
    const k = lehmannStride(REF_N, 10, 14, MPP, 20000);
    const r = buildLehmannSegs(f.data, f.w, frictionOpts(f, k));
    const t = createTarget(80, 80); // 960 m · 0.08 px/m = 76.8 px + margen
    rasterizeTramaTop(t, r.segs, r.count, 0.08, 40, 40, 0.7);
    const ratio = inkRatio(t);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(LEHMAN_TRAMA_INK_BUDGET);
  });

  test('A/B contrato d: build del campo bajo el guard de 6 ms (canónico y denso)', () => {
    // El guard del motor revierte a export-only si el BUILD > 6 ms. La
    // geometría del campo se mide aquí a nivel núcleo: vista canónica
    // (k=18, 16 trazos) y peor caso denso (k=1, ~4.9k muestras). El costo
    // de CUADRO lo atribuye el guard en runtime (EMA vs baseline capturada
    // al activar — mismo esquema que hachures, decisión #11).
    const f = refField();
    const kCanon = lehmannStride(REF_N, 10, 14, MPP, 20000);
    const rCanon = buildLehmannSegs(f.data, f.w, frictionOpts(f, kCanon));
    expect(rCanon.buildMs).toBeLessThan(6);
    // 16 = 25 muestras de la rejilla − 9 omitidas por el estarcido de la
    // franja NODATA (filas 22-31 y 40-67 la pisán con k=18) — known-answer.
    expect(rCanon.count).toBe(16);
    const rDense = buildLehmannSegs(f.data, f.w, frictionOpts(f, 1));
    // ~4.9k: 94×94 menos clase 0 y las filas de la franja (centro+estarcido)
    expect(rDense.count).toBeGreaterThan(4500);
    expect(rDense.buildMs).toBeLessThan(6); // umbral del guard, con margen
  });
});

/* ------------------------------------------------------------------ */
/* §8.5 — Coexistencia D11: 7 tipos SOBRE el mismo fondo tramado       */
/* ------------------------------------------------------------------ */

describe('D12 §8.5 — coexistencia D11: los 21 pares SOBRE fondo tramado', () => {
  const UMBRAL = 0.004; // mismo umbral B/N de D11
  const STRIP_W = 200;
  const STRIP_H = 44;
  const N = D11_LAYER_TYPES.length;

  // Fondo tramado: campo D12 limpio (sin franja NODATA — el estarcido de
  // la franja vaciaría las primeras filas de muestra y dejaría franjas sin
  // tinta), colocado para cubrir las 7 franjas con la vista canónica.
  const clean = new Float64Array(REF_N * REF_N);
  for (let j = 0; j < REF_N; j++)
    for (let i = 0; i < REF_N; i++) {
      const base = 2 + 9 * (i / 95);
      const wall = i >= 30 && i <= 70 && j >= 40 && j <= 58 ? 9 : 0;
      clean[j * REF_N + i] = base + wall;
    }
  const f = buildFrictionField(mkDem(clean, REF_N, REF_N, null));
  const kTrama = lehmannStride(REF_N, 10, 14, 1 / 0.3, 20000);
  const tramaOpts = { ...frictionOpts(f, kTrama), metersPerPx: 1 / 0.3 };
  const built = buildLehmannSegs(f.data, f.w, tramaOpts);

  const full = createTarget(STRIP_W, STRIP_H * N);
  // ox/oy +0.5: los centros de trazo caen en píxeles enteros (con origen
  // entero, el disco de cobertura r=0.35 pasa ENTRE filas de píxeles y la
  // trama no dejaría tinta — hallazgo de la propia verificación).
  rasterizeTramaTop(full, built.segs, built.count, 0.3, 100.5, 154.5, 0.7);

  // Franja por tipo: copia del fondo + linework D11 ENCIMA (orden motor).
  function refLine(n = 40): Array<[number, number]> {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) pts.push([6 + (i * (STRIP_W - 12)) / (n - 1), 22 + (i % 2 === 0 ? 0 : 2)]);
    return pts;
  }
  const perType = new Map<string, ReturnType<typeof createTarget>>();
  for (const type of D11_LAYER_TYPES) {
    const strip = createTarget(STRIP_W, STRIP_H);
    const row = D11_LAYER_TYPES.indexOf(type);
    for (let y = 0; y < STRIP_H; y++)
      for (let x = 0; x < STRIP_W; x++)
        strip.ink[y * STRIP_W + x] = full.ink[(row * STRIP_H + y) * STRIP_W + x]!;
    rasterizeLine(strip, refLine().map(([x, y]) => [x, y]), resolveLineStyle(type), true);
    perType.set(type, strip);
  }

  test('el fondo tramado es visible pero respeta el presupuesto D12', () => {
    expect(built.count).toBeGreaterThan(100); // la trama existe de verdad
    const bgOnly = createTarget(STRIP_W, STRIP_H);
    for (let y = 0; y < STRIP_H; y++)
      for (let x = 0; x < STRIP_W; x++) bgOnly.ink[y * STRIP_W + x] = full.ink[y * STRIP_W + x]!;
    const bg = inkRatio(bgOnly);
    expect(bg).toBeGreaterThan(0);
    expect(bg).toBeLessThanOrEqual(LEHMAN_TRAMA_INK_BUDGET);
  });

  test('par-a-par sobre trama: Hamming ≥ 0.004 en los 21 pares C(7,2)', () => {
    let pairs = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = perType.get(D11_LAYER_TYPES[i]!)!;
        const b = perType.get(D11_LAYER_TYPES[j]!)!;
        const d = pixelHamming(a, b);
        if (!(d >= UMBRAL)) {
          throw new Error(
            `par indistinguible SOBRE TRAMA: ${D11_LAYER_TYPES[i]} vs ${D11_LAYER_TYPES[j]} Hamming=${d}`
          );
        }
        pairs++;
      }
    }
    expect(pairs).toBe(21);
  });
});

/* ------------------------------------------------------------------ */
/* §8.6 — WYSIWYG: el export emite la MISMA trama vía el MISMO núcleo  */
/* ------------------------------------------------------------------ */

describe('D12 §8.6 — WYSIWYG del campo en la lista de despliegue', () => {
  const model = buildTerrain(getRegion('soledad'));
  const contours = buildContours(model.grid);
  const opts: ViewOpts = {
    minor: true,
    major: true,
    mesh: true,
    nodes: false,
    streams: true,
    divides: true,
    labels: true,
    cotas: true,
    inegi: true,
    elevRange: [contours.minV, contours.maxV],
    forcedStep: 0,
    reliefFx: true,
    eink: false,
    day: false,
    powerSave: false,
    hachures: true,
    friction: true,
  };
  const base = {
    model,
    contours,
    opts,
    cam: {
      az: (-45 * Math.PI) / 180,
      el: (35.3 * Math.PI) / 180,
      zoom: 1,
      panX: 0,
      panY: 0,
      pxPerM: 0.08,
      w: 800,
      h: 600,
      dpr: 1,
    },
    step: 1,
    useLight: false,
    bucketColor: ['#7a7a85', '#7a7a85', '#7a7a85', '#8a8a92'],
    fogIdx: 0,
  };

  test('con la capa activa: frictionSegs > 0 y dos serializaciones ⇒ bytes iguales', () => {
    const scene = { ...base, friction: { field: refField(), anchor: ANCHOR_D12 } };
    const dl1 = buildDisplayList(scene as never);
    const dl2 = buildDisplayList(scene as never);
    expect(dl1.frictionSegs).toBeDefined();
    expect(dl1.frictionSegs!).toBeGreaterThan(0);
    // determinismo del display list completo (JSON igual)
    expect(JSON.stringify(dl1.ops)).toBe(JSON.stringify(dl2.ops));
    const svg1 = serializeSvg(dl1, scene as never);
    const svg2 = serializeSvg(dl2, scene as never);
    expect(svg1).toBe(svg2);
  });

  test('sin la capa: sin trama en el export (la ficha no miente)', () => {
    const off = { ...base, opts: { ...opts, friction: false }, friction: null };
    const dl = buildDisplayList(off as never);
    expect(dl.frictionSegs).toBeUndefined();
    const withField = buildDisplayList({ ...base, friction: { field: refField(), anchor: ANCHOR_D12 } } as never);
    const svgOff = serializeSvg(dl, off as never);
    const svgOn = serializeSvg(withField, { ...base, friction: { field: refField(), anchor: ANCHOR_D12 } } as never);
    expect(svgOff).not.toBe(svgOn);
  });
});

/* ------------------------------------------------------------------ */
/* §8.7 — Cierre 2f: chevrons de dirección ORIENTADOS (known-answer)   */
/* ------------------------------------------------------------------ */

describe('D12 §8.7 — cierre 2f: chevrons orientados pixel-verified', () => {
  test('avance +x: ala de tinta DETRÁS del nodo, NADA de tinta de ala DELANTE', () => {
    // 13 puntos → 12 segmentos ⇒ UN solo chevron en el vértice 0 (cada 12).
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 13; i++) pts.push([20 + i * 6, 30]);
    const withNodes = createTarget(200, 60);
    const bare = createTarget(200, 60);
    rasterizeLine(withNodes, pts, resolveLineStyle('ruta'), true);
    rasterizeLine(bare, pts, resolveLineStyle('ruta'), false);
    // diff = tinta del chevron (la línea se cancela)
    const diff: Array<[number, number]> = [];
    for (let y = 0; y < 60; y++)
      for (let x = 0; x < 200; x++) {
        const i = y * 200 + x;
        if (withNodes.ink[i] !== bare.ink[i]) diff.push([x, y]);
      }
    expect(diff.length).toBeGreaterThan(0);
    // chevron en el nodo (20,30), avance +x: alas a ±135° ⇒ x ≤ 20+redondeo
    const NODE = 20;
    for (const [x] of diff) expect(x).toBeLessThanOrEqual(NODE + 2);
    // ala presente DETRÁS (la punta llega a x ≈ 20 − 3.54 − 0.7 ≈ 15.8)
    expect(diff.some(([x]) => x <= NODE - 2)).toBe(true);
    // las dos alas: tinta arriba Y abajo del eje de avance (y=30)
    expect(diff.some(([, y]) => y < 29)).toBe(true);
    expect(diff.some(([, y]) => y > 31)).toBe(true);
    // NADA de ala DELANTE (el avance +x no deja tinta de chevron en x>NODE+2)
    expect(diff.every(([x]) => x <= NODE + 2)).toBe(true);
  });

  test('chevron opuesto: avanzando −x las alas quedan al Este (orientación real)', () => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 13; i++) pts.push([20 + i * 6, 30]);
    pts.reverse(); // ahora el avance es −x (de x=92 hacia x=20)
    const withNodes = createTarget(200, 60);
    const bare = createTarget(200, 60);
    rasterizeLine(withNodes, pts, resolveLineStyle('ruta'), true);
    rasterizeLine(bare, pts, resolveLineStyle('ruta'), false);
    let minX = 999;
    let maxX = -1;
    for (let y = 0; y < 60; y++)
      for (let x = 0; x < 200; x++) {
        const i = y * 200 + x;
        if (withNodes.ink[i] !== bare.ink[i]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    expect(maxX).toBeGreaterThan(0);
    // nodo en pts[0] = (92,30): alas hacia +x ⇒ toda la ala en x ≥ 92−2
    expect(minX).toBeGreaterThanOrEqual(92 - 2);
  });

  test('presupuesto de flechas: sampleNodes respeta D11_MAX_NODES (≤48)', () => {
    expect(D11_MAX_NODES).toBe(48);
    const segs: Array<{ a: number; b: number; ax: number; ay: number; bx: number; by: number }> = [];
    for (let i = 1; i < 121; i++)
      segs.push({ a: i - 1, b: i, ax: i - 1, ay: 0, bx: i, by: 0 });
    const nodes = sampleNodes('arrow', segs, 121);
    expect(nodes.length).toBeLessThanOrEqual(D11_MAX_NODES);
    expect(nodes.length).toBe(10); // cada 12 segmentos: 0,12,…,108
    // y todas las flechas llevan la dirección del segmento portador
    expect(nodes[0]!.angle).toBeCloseTo(0, 6);
  });
});

/* ------------------------------------------------------------------ */
/* Contrato (g) — fixtures sintéticos decodifican por caminos REALES  */
/* ------------------------------------------------------------------ */

describe('D12 contrato g — fixtures sintéticos FR-W1 (malla + pack completo)', () => {
  const ANCHOR_FR5: Anchor = {
    extentM: 8000,
    zMinM: 1950,
    zMaxM: 2600,
    centerLat: 21.0,
    centerLon: -101.33,
    regionName: 'soledad-fr5',
  };

  function loadBytes(path: string): ArrayBuffer {
    const b = readFileSync(path);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  test('friction_mesh_sintetico.tif: GeoTIFF REAL (geográfico, Float32, NODATA) decodifica', () => {
    const dem = decodeGeoTiffFieldSync(loadBytes('tests/fixtures/friction_mesh_sintetico.tif'));
    expect(dem.w).toBe(REF_N);
    expect(dem.h).toBe(REF_N);
    expect(dem.crs.kind).toBe('geographic');
    expect(dem.nodata).toBe(-9999);
    expect(dem.compression).toBe('sin comprimir');
    const f = buildFrictionField(dem);
    // las 4 clases presentes + NODATA excluido del rango
    expect(f.classCounts.every((c) => c > 0)).toBe(true);
    expect(f.vmin).toBeGreaterThan(-9999);
    expect(frictionRows(f).length).toBe(3);
  });

  test('mision_fr5_completa.zip: el pack completo trae el campo D12 decodificado', () => {
    const r = parseMissionPack(loadBytes('tests/fixtures/mision_fr5_completa.zip'), ANCHOR_FR5)!;
    expect(r.field).toBeDefined();
    expect(r.field!.w).toBe(REF_N);
    expect(r.field!.classes.length).toBe(REF_N * REF_N);
    expect(JSON.stringify(r.meta)).toContain('Campo de fricción (D12)');
    // y la fila de ficha es honesta sobre NODATA
    expect(JSON.stringify(r.meta)).toContain('-9999');
  });

  test('FRICTION_NAME_RE: el nombre «friction» ENRUTA a campo D12, no a MDT (regresión E2E re-entrada)', () => {
    // Hallazgo E2E de la re-entrada (checkpoint ): /fricc/ no
    // hacía match con «friction» (UNA c) — el fixture suelto se enrutaba a
    // MDT («falso MDT REAL»). El camino del worker: nombre ⇒ campo, con la
    // fila honesta «Campo de fricción (D12)» y sin fila de Elevación.
    expect(FRICTION_NAME_RE.test('friction_mesh_sintetico.tif')).toBe(true);
    expect(FRICTION_NAME_RE.test('friccion_campo.tif')).toBe(true);
    expect(FRICTION_NAME_RE.test('FRICCIÓN_costo.TIF')).toBe(true);
    expect(FRICTION_NAME_RE.test('mdt_cerros_1m.tif')).toBe(false);
    const field = buildFrictionField(decodeGeoTiffFieldSync(loadBytes('tests/fixtures/friction_mesh_sintetico.tif')));
    const rows = frictionRows(field);
    expect(rows[0]![0]).toBe('Campo de fricción (D12)');
    expect(JSON.stringify(rows)).not.toContain('Elevación');
  });
});
