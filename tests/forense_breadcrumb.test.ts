/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense Breadcrumb A-8 — breadcrumb.ts + render overlay (FR-W1).
 *
 * Contrato (visión revisión de ingeniería,  · screenshot 215531):
 *   - El breadcrumb «se siente paso»: migas a CADENCIA DE FIX (cada
 *     BREADCRUMB_STEP_M, golpe de paso cada 4ª maga).
 *   - Brigadista anclado al terreno: la z de CADA miga es la del MDT activo
 *     (sampleGridZ honesto); miga fuera del MDT ⇒ NO existe (se cuenta en
 *     `dropped`, jamás se inventa).
 *   - Ruta demo A-8 SIEMPRE etiquetada `source:'simulacion'` (FR-W1).
 *   - Presupuesto determinista (BREADCRUMB_MAX_PTS) y determinismo puro.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildBreadcrumbTrail,
  A8_WAYPOINTS,
  BREADCRUMB_ROUTE,
  BREADCRUMB_STEP_M,
  BREADCRUMB_MAX_PTS,
} from '../src/lib/terrain/breadcrumb';
import { buildTerrain } from '../src/lib/terrain/generator';
import { getRegion } from '../src/lib/terrain/regions';
import { sampleGridZ } from '../src/lib/terrain/gps';

const region = getRegion('soledad');
const model = buildTerrain(region);

describe('Breadcrumb A-8 · trail anclado al terreno (FR-W1)', () => {
  test('construye sobre la Soledad: migas, ruta etiquetada y longitud coherente', () => {
    const t = buildBreadcrumbTrail(model.grid);
    expect(t).not.toBeNull();
    expect(t!.n).toBeGreaterThan(10);
    expect(t!.pts.length).toBe(t!.n * 3);
    expect(t!.routeId).toBe(BREADCRUMB_ROUTE);
    expect(t!.routeId).toBe('A-8');
    expect(t!.source).toBe('simulacion');
    // Longitud declarada = suma de tramos entre waypoints (verificada):
    let len = 0;
    for (let w = 1; w < A8_WAYPOINTS.length; w++) {
      len += Math.hypot(
        A8_WAYPOINTS[w][0] - A8_WAYPOINTS[w - 1][0],
        A8_WAYPOINTS[w][1] - A8_WAYPOINTS[w - 1][1]
      );
    }
    expect(t!.lenM).toBeCloseTo(len, 4);
  });

  test('cada miga toma EXACTAMENTE la z del MDT (anclada al terreno, f32)', () => {
    const t = buildBreadcrumbTrail(model.grid)!;
    for (let i = 0; i < t.n; i++) {
      const x = t.pts[i * 3];
      const y = t.pts[i * 3 + 1];
      const z = t.pts[i * 3 + 2];
      expect(z).toBe(Math.fround(sampleGridZ(model.grid, x, y) ?? NaN));
      expect(Number.isFinite(z)).toBe(true);
    }
  });

  test('cadencia «se siente paso»: separación ≈ BREADCRUMB_STEP_M por tramo', () => {
    const t = buildBreadcrumbTrail(model.grid)!;
    for (let i = 1; i < t.n; i++) {
      const dx = t.pts[i * 3] - t.pts[(i - 1) * 3];
      const dy = t.pts[i * 3 + 1] - t.pts[(i - 1) * 3 + 1];
      const d = Math.hypot(dx, dy);
      // La interpolación reparte cada tramo en round(tramo/step) partes:
      // la separación nunca supera 1.6·step ni baja de 0.5·step.
      expect(d).toBeGreaterThan(BREADCRUMB_STEP_M * 0.5);
      expect(d).toBeLessThan(BREADCRUMB_STEP_M * 1.6);
    }
  });

  test('la cabeza es la última miga y coincide con la z del MDT en su (x,y)', () => {
    const t = buildBreadcrumbTrail(model.grid)!;
    const last = (t.n - 1) * 3;
    expect(t.headX).toBe(t.pts[last]);
    expect(t.headY).toBe(t.pts[last + 1]);
    expect(t.headZ).toBe(t.pts[last + 2]);
    expect(t.headZ).toBe(Math.fround(sampleGridZ(model.grid, t.headX, t.headY) ?? NaN));
  });

  test('presupuesto: n ≤ BREADCRUMB_MAX_PTS (dibujo acotado)', () => {
    const t = buildBreadcrumbTrail(model.grid)!;
    expect(t.n).toBeLessThanOrEqual(BREADCRUMB_MAX_PTS);
    expect(t.dropped).toBe(0); // la ruta A-8 vive dentro de la Soledad
  });

  test('determinismo: mismo grid ⇒ mismo trail byte a byte', () => {
    const a = buildBreadcrumbTrail(model.grid)!;
    const b = buildBreadcrumbTrail(model.grid)!;
    expect(Array.from(a.pts)).toEqual(Array.from(b.pts));
    expect(a.n).toBe(b.n);
    expect(a.lenM).toBe(b.lenM);
    expect(a.dropped).toBe(b.dropped);
  });

  test('fuera del MDT ⇒ migas descartadas y contadas (nada inventado)', () => {
    // Grid degenerado de 1 celda: casi todo el path cae fuera del ±cell/2.
    const tiny = { n: 2, cell: 10, h: new Float32Array([2200, 2210, 2215, 2220]), min: 2200, max: 2220 };
    const t = buildBreadcrumbTrail(tiny);
    // El primer waypoint (−200, 600) está fuera de ±10 m ⇒ sin migas honestas.
    if (t === null) return; // camino honesto: sin terreno ⇒ sin demo
    expect(t.dropped).toBeGreaterThan(0);
  });

  test('relieve real a lo largo de la ruta (no un trail plano horneado)', () => {
    const t = buildBreadcrumbTrail(model.grid)!;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < t.n; i++) {
      const z = t.pts[i * 3 + 2];
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    expect(zMax - zMin).toBeGreaterThan(2); // el terreno es real y vive
  });
});
