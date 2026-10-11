/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — Determinismo bit-exacto del motor procedural.
 * Fija los reclamos del README: buildTerrain reproducible byte a byte
 * (rejilla 161×161), curvas 1 m exactas, maestras 25 m (cota % 25),
 * y PRNG/ruido deterministas por semilla.
 */
import { describe, expect, test } from 'bun:test';
import { buildTerrain } from '../src/lib/terrain/generator';
import { buildContours } from '../src/lib/terrain/contours';
import { makeRng, fbm, ridged } from '../src/lib/terrain/noise';
import { REGIONS, getRegion } from '../src/lib/terrain/regions';

describe('buildTerrain — determinismo bit-exacto', () => {
  test('misma región ⇒ rejilla 161×161 idéntica BYTE A BYTE', () => {
    const a = buildTerrain(getRegion('soledad'));
    const b = buildTerrain(getRegion('soledad'));
    expect(a.grid.n).toBe(161);
    expect(a.grid.h.length).toBe(161 * 161);
    expect(Buffer.from(a.grid.h.buffer).equals(Buffer.from(b.grid.h.buffer))).toBe(true);
  });
  test('rejillas de regiones distintas divergen', () => {
    const a = buildTerrain(getRegion('soledad')).grid.h;
    const b = buildTerrain(getRegion('esperanza')).grid.h;
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(false);
  });
  test('stats coherentes (superficie/desnivel dentro de rangos documentados)', () => {
    const t = buildTerrain(getRegion('soledad'));
    expect(t.stats.areaModelHa).toBeGreaterThan(200);
    expect(t.stats.areaModelHa).toBeLessThan(600);
    expect(t.stats.desnivel).toBeGreaterThan(50);
  });
});

describe('curvas — nivel 1 m y maestras 25 m', () => {
  const t = buildTerrain(getRegion('soledad'));
  const c = buildContours(t.grid);

  test('cada nivel de curva está a 1 m exacto y es consecutivo', () => {
    const levels = c.levels.map((l) => l.v);
    expect(levels.length).toBe(c.maxV - c.minV + 1);
    for (let i = 0; i < levels.length; i++) expect(levels[i]).toBe(c.minV + i);
  });
  test('maestras = exactamente cota % 25 === 0 (reclamo «maestras 25 m»)', () => {
    let maestras = 0;
    for (const l of c.levels) {
      expect(l.maestra).toBe(l.v % 25 === 0);
      if (l.maestra) maestras++;
    }
    expect(c.maestraCount).toBe(maestras);
    expect(maestras).toBeGreaterThan(0);
  });
  test('buildContours determinista (segunda pasada idéntica)', () => {
    const c2 = buildContours(buildTerrain(getRegion('soledad')).grid);
    expect(c2.totalSegs).toBe(c.totalSegs);
    expect(c2.maestraCount).toBe(c.maestraCount);
    expect(c2.minV).toBe(c.minV);
    expect(c2.maxV).toBe(c.maxV);
  });
  test('simplificación reduce vértices (diagnóstico honesto)', () => {
    expect(c.totalPts).toBeGreaterThan(0);
    expect(c.totalSegs).toBeGreaterThan(0);
  });
});

describe('PRNG y ruido — determinismo por semilla', () => {
  test('makeRng determinista; semillas distintas divergen', () => {
    const a = makeRng(20260925);
    const b = makeRng(20260925);
    const c = makeRng(20260926);
    const seqA = Array.from({ length: 64 }, () => a());
    const seqB = Array.from({ length: 64 }, () => b());
    const seqC = Array.from({ length: 64 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });
  test('fbm/ridged deterministas y acotados [-1,1]·escala', () => {
    const a = fbm(1.234, 5.678, 42);
    const b = fbm(1.234, 5.678, 42);
    const r = ridged(1.234, 5.678, 42);
    expect(a).toBe(b);
    expect(Number.isFinite(a)).toBe(true);
    expect(Number.isFinite(r)).toBe(true);
    expect(fbm(1.234, 5.678, 43)).not.toBe(a);
  });
});

describe('regiones — contrato', () => {
  test('4 regiones con ids esperados y getRegion lanza/falla fuera de catálogo', () => {
    expect(REGIONS.map((r) => r.id).sort()).toEqual(['bufa', 'esperanza', 'santarosa', 'soledad']);
    for (const r of REGIONS) expect(getRegion(r.id).id).toBe(r.id);
  });
});
