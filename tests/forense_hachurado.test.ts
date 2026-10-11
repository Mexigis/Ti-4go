/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — F5-03 · Hachurado de pendiente por tramas (export-first).
 * Fija los reclamos del README/ROADMAP: la trama vive SOLO en el export
 * vectorial (SVG/PDF) con 0 ms de presupuesto interactivo, es determinista
 * (misma escena ⇒ mismos hachures byte a byte), codifica la pendiente en la
 * longitud del trazo (Lehmann) y es un no-op exacto cuando está apagada
 * (regresión 0 en los exports existentes).
 */
import { describe, test, expect } from 'bun:test';
import { buildTerrain, type TerrainModel } from '../src/lib/terrain/generator';
import { buildContours } from '../src/lib/terrain/contours';
import { getRegion } from '../src/lib/terrain/regions';
import {
  COLORS,
  DAY_COLORS,
  EINK_COLORS,
  type ExportScene,
  type ViewOpts,
} from '../src/lib/terrain/engine';
import { buildDisplayList, serializeSvg } from '../src/lib/terrain/export';

/* ---------------- fixtures ---------------- */

const model = buildTerrain(getRegion('soledad'));
const contours = buildContours(model.grid);
const cam = {
  az: -Math.PI / 4,
  el: (35.264 * Math.PI) / 180,
  zoom: 1,
  panX: 0,
  panY: 0,
  pxPerM: 0.08,
  w: 800,
  h: 600,
  dpr: 1,
};
const baseOpts: ViewOpts = {
  minor: true,
  major: true,
  mesh: true,
  nodes: false,
  streams: true,
  divides: true,
  labels: false,
  cotas: false,
  inegi: false,
  elevRange: [0, 9999],
  forcedStep: 0,
  reliefFx: true,
  eink: false,
  day: false,
  powerSave: false,
};

const scene = (over: Partial<ViewOpts> = {}): ExportScene => ({
  model,
  contours,
  opts: { ...baseOpts, ...over },
  cam,
  step: 1,
  useLight: false,
  bucketColor: Array<string>(8).fill('#7a7a85'),
  fogIdx: 0,
});

/** Localiza la op única de la trama (stroke = color hachure de la paleta). */
const hachureOps = (dl: ReturnType<typeof buildDisplayList>, stroke: string) =>
  dl.ops.filter((o) => o.op === 'path' && o.stroke === stroke);

/** Longitudes en pantalla de cada hachure (px). */
const hachureLengths = (subs: { p: number[] }[]): number[] =>
  subs
    .filter((s) => s.p.length >= 4)
    .map((s) => Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]));

/** Modelo sintético: plano inclinado slope m/m hacia −x (determinista). */
const planeModel = (slope: number): TerrainModel => {
  const m = buildTerrain(getRegion('soledad'));
  const { n, cell } = m.grid;
  const half = (n - 1) / 2;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      h[j * n + i] = 2000 + slope * (i - half) * cell;
    }
  }
  m.grid.h = h;
  m.grid.min = 2000 - slope * half * cell;
  m.grid.max = 2000 + slope * half * cell;
  return m;
};

const planeScene = (slope: number, over: Partial<ViewOpts> = {}): ExportScene => ({
  ...scene(over),
  model: planeModel(slope),
});

/* ---------------- tests ---------------- */

describe('F5-03 hachurado — no-op exacto apagado (regresión 0)', () => {
  test('hachures undefined ⇒ 0 ops de trama y métrica 0', () => {
    const dl = buildDisplayList(scene());
    expect(dl.hachures).toBe(0);
    expect(hachureOps(dl, COLORS.hachure).length).toBe(0);
  });
  test('hachures false ⇒ salida idéntica byte a byte al export legacy', () => {
    const a = serializeSvg(buildDisplayList(scene()), scene());
    const b = serializeSvg(buildDisplayList(scene({ hachures: false })), scene({ hachures: false }));
    expect(a).toBe(b);
  });
  test('hachures false ⇒ mismo JSON de ops que undefined', () => {
    const a = JSON.stringify(buildDisplayList(scene()).ops);
    const b = JSON.stringify(buildDisplayList(scene({ hachures: false })).ops);
    expect(a).toBe(b);
  });
});

describe('F5-03 hachurado — emisión y acotación', () => {
  const dl = buildDisplayList(scene({ hachures: true }));
  const ops = hachureOps(dl, COLORS.hachure);

  test('terreno real ⇒ trama emitida y contada', () => {
    expect(dl.hachures).toBeGreaterThan(0);
    expect(ops.length).toBe(1); // presupuesto: UNA sola op de trazo
    expect(ops[0].width).toBe(0.7);
  });
  test('tope de muestras respetado (pxPerM 0.08 ⇒ k=4 ⇒ ≤1600)', () => {
    // 161 vértices, paso k=4 desde i/j=1 ⇒ 40×40 muestras máximas
    expect(dl.hachures).toBeLessThanOrEqual(1600);
  });
  test('tope duro MAX_SAMPLES: zoom extremo (pxPerM 10) no dispara', () => {
    // plano 15 % garantiza pendiente visible en las ~4 muestras del encuadre
    const base = planeScene(0.15, { hachures: true });
    // pxPerM alto ⇒ k=1 ⇒ 159² = 25281 > 20000 ⇒ el bucle dobla k a 2 ⇒ 6400
    const dl10 = buildDisplayList({ ...base, cam: { ...cam, pxPerM: 10 } });
    expect(dl10.hachures).toBeGreaterThan(0);
    expect(dl10.hachures).toBeLessThanOrEqual(6400);
  });
  test('inicios dentro del lienzo + pad 24 px; extremos dentro de pad 48 px', () => {
    for (const s of (ops[0].subs as { p: number[] }[])) {
      // punto de inicio (culled estricto en el código)
      expect(s.p[0]).toBeGreaterThanOrEqual(-24);
      expect(s.p[0]).toBeLessThanOrEqual(cam.w + 24);
      expect(s.p[1]).toBeGreaterThanOrEqual(-24);
      expect(s.p[1]).toBeLessThanOrEqual(cam.h + 24);
      // extremo (baja por la pendiente: desplazamiento de pantalla ≤ ~11 px)
      expect(s.p[2]).toBeGreaterThanOrEqual(-48);
      expect(s.p[2]).toBeLessThanOrEqual(cam.w + 48);
      expect(s.p[3]).toBeGreaterThanOrEqual(-48);
      expect(s.p[3]).toBeLessThanOrEqual(cam.h + 48);
    }
  });
  test('longitud de pantalla de cada hachure ≤ 12 px (cap Lehmann + proyección)', () => {
    const lens = hachureLengths(ops[0].subs as { p: number[] }[]);
    expect(lens.length).toBe(dl.hachures);
    for (const L of lens) expect(L).toBeLessThanOrEqual(12);
  });
});

describe('F5-03 hachurado — codificación de pendiente (Lehmann)', () => {
  test('plano llano (2 % < S_MIN) ⇒ 0 hachures', () => {
    const dl = buildDisplayList(planeScene(0.02, { hachures: true }));
    expect(dl.hachures).toBe(0);
  });
  test('plano inclinado (15 %) ⇒ hachures en el rango de longitud tapada', () => {
    const dl = buildDisplayList(planeScene(0.15, { hachures: true }));
    expect(dl.hachures).toBeGreaterThan(0);
    const op = hachureOps(dl, COLORS.hachure)[0];
    const lens = hachureLengths(op.subs as { p: number[] }[]);
    // lenPx = min(1.5 + 0.15·24, 9) = 5.1 px proyectado (el~35° acorta en pantalla)
    for (const L of lens) {
      expect(L).toBeGreaterThan(0);
      expect(L).toBeLessThanOrEqual(9.2);
    }
  });
  test('más pendiente ⇒ tramos largos en pantalla (mónotona creciente)', () => {
    const soft = buildDisplayList(planeScene(0.08, { hachures: true }));
    const steep = buildDisplayList(planeScene(0.3, { hachures: true }));
    const mean = (dl: ReturnType<typeof buildDisplayList>): number => {
      const op = hachureOps(dl, COLORS.hachure)[0];
      const lens = hachureLengths(op.subs as { p: number[] }[]);
      return lens.reduce((a, b) => a + b, 0) / lens.length;
    };
    expect(steep.hachures).toBeGreaterThan(0);
    expect(mean(steep)).toBeGreaterThan(mean(soft));
  });
});

describe('F5-03 hachurado — determinismo y paletas', () => {
  test('misma escena ⇒ mismos hachures byte a byte', () => {
    const a = JSON.stringify(buildDisplayList(scene({ hachures: true })).ops);
    const b = JSON.stringify(buildDisplayList(scene({ hachures: true })).ops);
    expect(a).toBe(b);
  });
  test('paleta E-Ink: tinta negra (técnica clásica de hachures)', () => {
    const dl = buildDisplayList(scene({ hachures: true, eink: true }));
    expect(hachureOps(dl, EINK_COLORS.hachure).length).toBe(1);
    expect(hachureOps(dl, COLORS.hachure).length).toBe(0);
  });
  test('paleta Día: tinta gris sobre papel', () => {
    const dl = buildDisplayList(scene({ hachures: true, day: true }));
    expect(hachureOps(dl, DAY_COLORS.hachure).length).toBe(1);
  });
});

describe('F5-03 hachurado — serialización SVG', () => {
  test('el SVG contiene la trama con el color de paleta', () => {
    const sc = scene({ hachures: true });
    const svg = serializeSvg(buildDisplayList(sc), sc);
    expect(svg).toContain(`stroke="${COLORS.hachure}"`);
  });
  test('orden z: la trama va DEBAJO de las curvas intermedias', () => {
    const sc = scene({ hachures: true });
    const svg = serializeSvg(buildDisplayList(sc), sc);
    const iHach = svg.indexOf(`stroke="${COLORS.hachure}"`);
    const iMinor = svg.indexOf('stroke="#7a7a85"'); // bucketColor uniforme del fixture
    expect(iHach).toBeGreaterThan(-1);
    expect(iMinor).toBeGreaterThan(-1);
    expect(iHach).toBeLessThan(iMinor);
  });
  test('el SVG apagado NO contiene el color de trama (sin residuo)', () => {
    const sc = scene();
    const svg = serializeSvg(buildDisplayList(sc), sc);
    expect(svg).not.toContain(`stroke="${COLORS.hachure}"`);
  });
});
