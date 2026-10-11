/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense DRAPE-1 — «la capa viva sobre las curvas» (directiva del
 * propietario, checkpoint de ingeniería).
 *
 * Contrato fijado con aserciones:
 *   A. UNIDAD PURA (drape.ts): sin cota ⇒ z = terreno (bilineal) + lift de
 *      pantalla 2–3 px; CON cota declarada ⇒ dato intacto (jamás se toca);
 *      densificación preservando índices (la ruta TREPA las curvas, no
 *      corta el valle en cuerda); presupuestos duros; determinismo byte a
 *      byte; hostiles ⇒ copia honesta, nunca lanzar.
 *   B. RECREACIÓN 215550 (incidente): rutas Primaria 88 % / Secundaria
 *      78 % / Emergencia 95 % con route_class + confidence trepando las
 *      curvas correctas — hundimiento del trazo DONDE el terreno se
 *      hunde (valle), gramática D11 v1.1 exacta.
 *   C. RECREACIÓN 215531 (captura de campo): punto de campo/brigadista sin
 *      cota cae al terreno (A-8 ya dibuja el marcador sobre el grid);
 *      KML/CSV/GeoJSON preservan la señal NaN (zMid/0 horneados jamás).
 *   D. E-INK + OVERLAY: el drape es GEOMETRÍA — no introduce color (tinta
 *      B/N pura), NaN jamás entra al path, caché por sello de MDT,
 *      telemetría drapePerf.
 *
 * Ledger de auditoría: aserciones incondicionales; sin ramas condicionales
 * que alteren el conteo.
 */
import { describe, expect, test } from 'bun:test';
import { drapeGeom, drapeLifted, DRAPE_LIFT_PX, DRAPE_MAX_SUBDIV } from '../src/lib/terrain/drape';
import { sampleGrid, type Grid } from '../src/lib/terrain/generator';
import { resolveLineStyle } from '../src/lib/terrain/linegrammar';
import { parseGeoJson } from '../src/lib/ingest/geojson';
import { parseKml } from '../src/lib/ingest/kml';
import { parseFile, type Anchor, type IngestMeta } from '../src/lib/ingest/parsers';
import { drawIngestOverlay, drapePerf, type OverlayDrape } from '../src/lib/ingest/overlay';
import type { CamSnapshot } from '../src/lib/terrain/engine';
import type { GeomLayer } from '../src/components/terrain/ingest';

/* ------------------------------------------------------------------ */
/* Escenario: MDT sintético con valle simétrico (recreación 215550)   */
/* ------------------------------------------------------------------ */

const N = 65; // vértices por lado
const CELL = 40; // m → extent 2560 m, x=0 es vértice exacto (i=32)
const half = ((N - 1) / 2) * CELL;

/** Terreno analítico: valle gaussiano en x=0 (−30 m) + rampa suave en y. */
function terrainZ(x: number, y: number): number {
  return 2200 - 30 * Math.exp(-(x * x) / (2 * 150 * 150)) + 0.04 * y;
}

const H = new Float32Array(N * N);
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    H[j * N + i] = terrainZ((i - (N - 1) / 2) * CELL, (j - (N - 1) / 2) * CELL);
  }
}
let gmin = Infinity;
let gmax = -Infinity;
for (let k = 0; k < H.length; k++) {
  if (H[k] < gmin) gmin = H[k];
  if (H[k] > gmax) gmax = H[k];
}
const GRID: Grid = { n: N, cell: CELL, h: H, min: gmin, max: gmax };
const SAMPLER = (x: number, y: number): number => sampleGrid(GRID, x, y);
const STEP = CELL / 2; // 20 m — el paso que el overlay entrega (cellM/2)

function routeVerts(pts: Array<[number, number, number]>): Float32Array {
  const v = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => {
    v[i * 3] = p[0];
    v[i * 3 + 1] = p[1];
    v[i * 3 + 2] = p[2];
  });
  return v;
}

function chainSegs(n: number): Uint32Array {
  const s = new Uint32Array((n - 1) * 2);
  for (let i = 0; i < n - 1; i++) {
    s[i * 2] = i;
    s[i * 2 + 1] = i + 1;
  }
  return s;
}

const ab = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

/* ------------------------------------------------------------------ */
/* Recorder ctx — graba el dibujo del overlay (sin canvas real)        */
/* ------------------------------------------------------------------ */

class RecorderCtx {
  readonly strokes = new Set<string>();
  readonly fills = new Set<string>();
  ops: Array<{ op: string; x: number; y: number }> = [];
  private _strokeStyle = '';
  private _fillStyle = '';
  lineWidth = 0;
  globalAlpha = 1;
  font = '';
  textAlign = '';
  textBaseline = '';
  lineCap = '';
  canvas = { width: 0, height: 0 };

  get strokeStyle(): string {
    return this._strokeStyle;
  }
  set strokeStyle(v: string) {
    this._strokeStyle = v;
    this.strokes.add(v);
  }
  get fillStyle(): string {
    return this._fillStyle;
  }
  set fillStyle(v: string) {
    this._fillStyle = v;
    this.fills.add(v);
  }
  setTransform(): void {}
  clearRect(): void {}
  beginPath(): void {
    this.ops.push({ op: 'begin', x: NaN, y: NaN });
  }
  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'move', x, y });
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ op: 'line', x, y });
  }
  closePath(): void {}
  fill(): void {}
  stroke(): void {}
  save(): void {}
  restore(): void {}
  fillRect(x: number, y: number): void {
    this.ops.push({ op: 'rect', x, y });
  }
  fillText(): void {}
  arc(): void {}
  setLineDash(): void {}
}

const CAM: CamSnapshot = {
  az: 0,
  el: (35.264 * Math.PI) / 180,
  zoom: 0.4, // < 0.45 ⇒ sin etiqueta (aisla la tinta de la línea)
  panX: 0,
  panY: 0,
  pxPerM: 0.2,
  w: 800,
  h: 600,
  dpr: 1,
};

const ANCHOR: Anchor = {
  extentM: 8000,
  zMinM: 1950,
  zMaxM: 2600,
  centerLat: 21.0,
  centerLon: -101.33,
  regionName: 'prueba-drape1',
};

function layerOf(
  verts: Float32Array,
  segs: Uint32Array,
  attrs: { layerType?: string; routeClass?: string; confidence?: number } = {}
): GeomLayer {
  const meta = {
    format: 'geojson',
    label: 'capa drape',
    magicOk: true,
    rows: [],
    layerType: attrs.layerType,
    routeClass: attrs.routeClass,
    confidence: attrs.confidence,
  } as unknown as IngestMeta;
  return { id: 1, name: 'capa', meta, geom: { verts, segs, pts: new Uint32Array(0) } };
}

const DRAPE: OverlayDrape = { sampler: SAMPLER, stamp: 1, cellM: CELL };

/* ------------------------------------------------------------------ */
/* A. Unidad pura                                                      */
/* ------------------------------------------------------------------ */

describe('DRAPE-1 A · unidad pura (drapeGeom)', () => {
  test('capa 100 % declarada ⇒ null (passthrough de costo cero)', () => {
    const verts = routeVerts([
      [-600, 0, 2150],
      [0, 0, 2170],
      [600, 0, 2150],
    ]);
    expect(drapeGeom(verts, chainSegs(3), SAMPLER, STEP)).toBeNull();
  });

  test('capa vacía ⇒ null', () => {
    expect(drapeGeom(new Float32Array(0), new Uint32Array(0), SAMPLER, STEP)).toBeNull();
  });

  test('known-answer: z drapeada ≡ bilineal del grid y ≈ analítica del terreno (≤1 m)', () => {
    // Ruta sin cota cruzando el valle: x = −600…600 a pasos de 200 m
    const n = 7;
    const verts = routeVerts(
      Array.from({ length: n }, (_, i) => [(-600 + i * 200) as number, 0 as number, NaN as number])
    );
    const d = drapeGeom(verts, chainSegs(n), SAMPLER, STEP)!;
    expect(d).not.toBeNull();
    expect(d.declaredCount).toBe(0);
    expect(d.mdtCount).toBe(n + d.extraVerts);
    for (let i = 0; i < d.verts.length / 3; i++) {
      const x = d.verts[i * 3];
      const y = d.verts[i * 3 + 1];
      const z = d.verts[i * 3 + 2];
      expect(z).toBeCloseTo(SAMPLER(x, y), 3); // identidad con el sampler (Float32)
      expect(Math.abs(z - terrainZ(x, y))).toBeLessThanOrEqual(1.0); // anclaje REAL al terreno
      expect(d.src[i]).toBe(0);
    }
  });

  test('la cota declarada JAMÁS se toca: byte a byte + src=1 (sin lift)', () => {
    const verts = routeVerts([
      [-600, 0, NaN],
      [0, 0, 2100.5], // cota declarada — dato del producto
      [600, 0, NaN],
    ]);
    const d = drapeGeom(verts, chainSegs(3), SAMPLER, STEP)!;
    expect(d.declaredCount).toBe(1);
    expect(d.src[1]).toBe(1);
    expect(d.verts[1 * 3 + 2]).toBe(verts[1 * 3 + 2]); // mismo valor exacto
    expect(drapeLifted(d.src, 1)).toBe(false); // declarada no lleva lift
    expect(drapeLifted(d.src, 0)).toBe(true); // mdt lleva lift
    expect(d.verts[0 * 3 + 2]).toBeCloseTo(SAMPLER(-600, 0), 3);
  });

  test('densificación preserva índices: endpoints compartidos siguen compartidos', () => {
    // 3 vértices, 2 aristas de 600 m (paso 20 ⇒ 30 subdivisiones ⇒ 29 extras)
    const verts = routeVerts([
      [-600, 0, NaN],
      [0, 0, NaN],
      [600, 0, NaN],
    ]);
    const d = drapeGeom(verts, chainSegs(3), SAMPLER, STEP)!;
    expect(d.extraVerts).toBe(58); // 29 por arista
    // pares emitidos = interiores + aristas originales (1 subseg extra c/u)
    const pairs: Array<[number, number]> = [];
    for (let k = 0; k < d.segs.length; k += 2) pairs.push([d.segs[k], d.segs[k + 1]]);
    expect(pairs.length).toBe(d.extraVerts + 2);
    const endsAt1 = pairs.filter((p) => p[1] === 1);
    const startsAt1 = pairs.filter((p) => p[0] === 1);
    expect(endsAt1.length).toBe(1);
    expect(startsAt1.length).toBe(1);
    // primera arista arranca en 0 y la última termina en 2
    expect(pairs[0][0]).toBe(0);
    expect(pairs[pairs.length - 1][1]).toBe(2);
  });

  test(`tope por arista (${DRAPE_MAX_SUBDIV}): arista 2000 m ⇒ 31 interiores, sin budgetHit`, () => {
    const verts = routeVerts([
      [-1000, 0, NaN],
      [1000, 0, NaN],
    ]);
    const d = drapeGeom(verts, chainSegs(2), SAMPLER, STEP)!;
    expect(d.extraVerts).toBe(31); // nSub capado a 32 ⇒ 31 interiores
    expect(d.budgetHit).toBe(false); // normalización, no fallo
    // los interiores trepan la curva: z variable, NO plano
    let zmin = Infinity;
    let zmax = -Infinity;
    for (let i = 2; i < d.verts.length / 3; i++) {
      const z = d.verts[i * 3 + 2];
      if (z < zmin) zmin = z;
      if (z > zmax) zmax = z;
    }
    expect(zmax - zmin).toBeGreaterThan(10); // la cuerda recta no engaña
  });

  test('presupuesto global: cadena larga ⇒ budgetHit true, extras ≤ tope, cola recta', () => {
    const nSegs = 6500;
    const n = nSegs + 1;
    const verts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      verts[i * 3] = i * 700; // aristas de 700 m (> paso, < tope×paso)
      verts[i * 3 + 1] = 0;
      verts[i * 3 + 2] = NaN;
    }
    const d = drapeGeom(verts, chainSegs(n), SAMPLER, STEP)!;
    expect(d.budgetHit).toBe(true);
    expect(d.extraVerts).toBeLessThanOrEqual(200_000);
    // la última arista salió recta (sin interiores)
    const last = d.segs.length - 2;
    expect(d.segs[last]).toBe(nSegs - 1);
    expect(d.segs[last + 1]).toBe(nSegs);
  });

  test('sampler no-finito ⇒ NaN preservado (honestidad antes que invención)', () => {
    const verts = routeVerts([
      [0, 0, NaN],
      [100, 0, NaN],
    ]);
    const d = drapeGeom(verts, chainSegs(2), () => NaN, STEP)!;
    expect(Number.isNaN(d.verts[0 * 3 + 2])).toBe(true);
    expect(Number.isNaN(d.verts[1 * 3 + 2])).toBe(true);
    expect(d.src[0]).toBe(0);
  });

  test('arista fuera de rango (hostil de ingesta) se copia tal cual, sin lanzar', () => {
    const verts = routeVerts([
      [0, 0, NaN],
      [100, 0, NaN],
    ]);
    const segs = new Uint32Array([0, 1, 1, 99]); // 99 ≥ n=2
    const d = drapeGeom(verts, segs, SAMPLER, STEP)!;
    const pairs: Array<[number, number]> = [];
    for (let k = 0; k < d.segs.length; k += 2) pairs.push([d.segs[k], d.segs[k + 1]]);
    expect(pairs[pairs.length - 1]).toEqual([1, 99]);
  });

  test('determinismo byte-exacto: misma entrada ⇒ mismos buffers', () => {
    const verts = routeVerts([
      [-600, 0, NaN],
      [0, 0, 2100.5],
      [600, 0, NaN],
    ]);
    const a = drapeGeom(verts, chainSegs(3), SAMPLER, STEP)!;
    const b = drapeGeom(verts, chainSegs(3), SAMPLER, STEP)!;
    expect(Buffer.from(a.verts.buffer).equals(Buffer.from(b.verts.buffer))).toBe(true);
    expect(Buffer.from(a.segs.buffer).equals(Buffer.from(b.segs.buffer))).toBe(true);
    expect(Buffer.from(a.src.buffer).equals(Buffer.from(b.src.buffer))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* B. Recreación 215550 — rutas del incidente sobre las curvas         */
/* ------------------------------------------------------------------ */

describe('DRAPE-1 B · recreación 215550 (rutas trepando las curvas)', () => {
  /** Ruta Primaria a lo largo de y=0 (cruza el fondo del valle). */
  const R1 = routeVerts(
    Array.from({ length: 7 }, (_, i) => [(-600 + i * 200) as number, 0 as number, NaN as number])
  );

  test('ruta sin cota se hunde DONDE el terreno se hunde (valle x≈0) — curva correcta', () => {
    const d = drapeGeom(R1, chainSegs(7), SAMPLER, STEP)!;
    let zmin = Infinity;
    let xmin = NaN;
    let zEnd = Infinity;
    for (let i = 0; i < d.verts.length / 3; i++) {
      const x = d.verts[i * 3];
      const z = d.verts[i * 3 + 2];
      if (Math.abs(x) >= 590 && z < zEnd) zEnd = z; // extremos (|x|=600)
      if (z < zmin) {
        zmin = z;
        xmin = x;
      }
    }
    expect(Math.abs(xmin)).toBeLessThanOrEqual(80); // el mínimo cae en el valle
    expect(zmin).toBeLessThan(zEnd - 25); // hundimiento real (>25 m vs extremos)
    expect(Math.abs(zmin - (2200 - 30))).toBeLessThanOrEqual(1.0); // fondo ≈ 2170
  });

  test('gramática D11 v1.1 de la recreación: primaria 88 / secundaria 78 / emergencia 95', () => {
    const prim = resolveLineStyle('ruta', 'normal', { routeClass: 'primaria', confidence: 88 });
    const secu = resolveLineStyle('ruta', 'normal', { routeClass: 'secundaria', confidence: 78 });
    const emer = resolveLineStyle('ruta', 'normal', { routeClass: 'emergencia', confidence: 95 });
    // pesos y guiones (screenshot 215550: jerarquía visible en B/N)
    expect(prim.style.weightPx).toBe(1.4);
    expect(prim.style.dash).toEqual([2, 3, 7, 3]);
    expect(secu.style.weightPx).toBe(1.0);
    expect(emer.style.weightPx).toBe(1.6);
    expect(emer.style.dash).toEqual([2, 3, 7, 3, 7, 3]);
    // opacidad por confianza (≥ 50 ⇒ 0.55 + 0.45·(c−50)/50)
    expect(prim.opacity).toBeCloseTo(0.892, 10);
    expect(secu.opacity).toBeCloseTo(0.802, 10);
    expect(emer.opacity).toBeCloseTo(0.955, 10);
  });

  test('lift de pantalla 2.5 px ∈ [2,3] — solo vértices MDT', () => {
    expect(DRAPE_LIFT_PX).toBeGreaterThanOrEqual(2);
    expect(DRAPE_LIFT_PX).toBeLessThanOrEqual(3);
    const d = drapeGeom(R1, chainSegs(7), SAMPLER, STEP)!;
    for (let i = 0; i < d.src.length; i++) expect(drapeLifted(d.src, i)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* C. Recreación 215531 — captura de campo (brigadista sobre el terreno)*/
/* ------------------------------------------------------------------ */

describe('DRAPE-1 C · recreación 215531 (campo: sin cota horneada)', () => {
  test('punto de campo sin cota (brigadista) cae al terreno vía drape', () => {
    const fc = JSON.stringify({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-101.33, 21.0] }, // sin cota
    });
    const r = parseGeoJson(fc, ANCHOR)!;
    expect(Number.isNaN(r.geom!.verts[2])).toBe(true); // señal preservada
    const d = drapeGeom(r.geom!.verts, r.geom!.segs, SAMPLER, STEP)!;
    expect(d.mdtCount).toBe(1);
    const z = d.verts[2];
    expect(Math.abs(z - terrainZ(0, 0))).toBeLessThanOrEqual(1.0); // sobre el terreno
    // A-8 ya dibuja al brigadista sobre el grid (groundZAt) — ver
    // tests/forense_gps_marker: el marcador nace EN el terreno, no encima.
  });

  test('KML: sin altitud ⇒ NaN (señal preservada); con altitud ⇒ declarada', () => {
    const kmlSin = (c: string): string =>
      `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString><coordinates>${c}</coordinates></LineString></Placemark></Document></kml>`;
    const sinAlt = parseKml(kmlSin('-101.35,21.00 -101.34,21.01'), ANCHOR)!;
    expect(Number.isNaN(sinAlt.geom!.verts[2])).toBe(true);
    const conAlt = parseKml(kmlSin('-101.35,21.00,2050 -101.34,21.01,2060'), ANCHOR)!;
    expect(conAlt.geom!.verts[2]).toBe(2050);
    expect(conAlt.geom!.verts[5]).toBe(2060);
  });

  test('CSV sin columna de cota ⇒ NaN preservado (no zMid horneado)', () => {
    const csv = 'lat,lon\n21.0,-101.35\n21.01,-101.34\n';
    const r = parseFile('puntos.csv', ab(csv), ANCHOR);
    expect(r.geom).not.toBeNull();
    expect(Number.isNaN(r.geom!.verts[2])).toBe(true);
    expect(Number.isNaN(r.geom!.verts[5])).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* D. E-Ink + overlay: el drape es geometría, no color                 */
/* ------------------------------------------------------------------ */

describe('DRAPE-1 D · overlay con drape (E-Ink-first)', () => {
  test('tinta E-Ink B/N pura: strokeStyle ∈ {tinta, papel}, sin color nuevo', () => {
    const ctx = new RecorderCtx();
    const layer = layerOf(
      routeVerts(
        Array.from({ length: 7 }, (_, i) => [(-600 + i * 200) as number, 0 as number, NaN as number])
      ),
      chainSegs(7),
      { layerType: 'ruta', routeClass: 'primaria', confidence: 88 }
    );
    drawIngestOverlay(ctx as unknown as CanvasRenderingContext2D, CAM, [layer], {
      eink: true,
      ink: '#111111',
      drape: DRAPE,
    });
    for (const s of ctx.strokes) expect(['#111111', '#ffffff']).toContain(s);
    for (const f of ctx.fills) expect(['#111111']).toContain(f);
    // el path sí se trazó (la capa viva es visible)
    expect(ctx.ops.filter((o) => o.op === 'line').length).toBeGreaterThan(20); // densificada
  });

  test('lift exacto: py del vértice drapeado = proyección del terreno − 2.5 px', () => {
    const ctx = new RecorderCtx();
    // y=−500 mantiene el vértice DENTRO del margen visible (el py en y=0
    // cae por encima del lienzo y el culling lo saltaría).
    const layer = layerOf(routeVerts([[-600, -500, NaN], [600, -500, NaN]]), new Uint32Array([0, 1]), {});
    drawIngestOverlay(ctx as unknown as CanvasRenderingContext2D, CAM, [layer], {
      ink: '#111111',
      drape: DRAPE,
    });
    const lines = ctx.ops.filter((o) => o.op === 'line' || o.op === 'move');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // replicación EXACTA de la proyección del overlay para el vértice 0
    const x = -600;
    const y = -500;
    const z = SAMPLER(x, y);
    const c = Math.cos(CAM.az);
    const s = Math.sin(CAM.az);
    const es = Math.sin(CAM.el);
    const ec = Math.cos(CAM.el);
    const w2 = CAM.w / 2;
    const h2 = CAM.h / 2;
    const S = CAM.pxPerM;
    const expected = h2 - ((x * s + y * c) * es + z * ec) * S - DRAPE_LIFT_PX;
    const first = lines[0];
    expect(first.y).toBeCloseTo(expected, 8);
    // el lift es EXACTAMENTE 2.5 px: sin drape, la proyección pura es +2.5
    const pure = h2 - ((x * s + y * c) * es + z * ec) * S;
    expect(pure - first.y).toBeCloseTo(DRAPE_LIFT_PX, 8);
  });

  test('sin drape y sin cota ⇒ proyección neutra z=0 (NaN jamás entra al path)', () => {
    const ctx = new RecorderCtx();
    const layer = layerOf(routeVerts([[-600, 0, NaN], [600, 0, NaN]]), new Uint32Array([0, 1]), {});
    drawIngestOverlay(ctx as unknown as CanvasRenderingContext2D, CAM, [layer], {
      ink: '#111111',
    });
    for (const o of ctx.ops) {
      if (o.op === 'move' || o.op === 'line') {
        expect(Number.isFinite(o.x)).toBe(true);
        expect(Number.isFinite(o.y)).toBe(true);
      }
    }
  });

  test('caché por sello de MDT: mismo (stamp, cellM) ⇒ 0 rebuilds; sello nuevo ⇒ 1', () => {
    const ctx = new RecorderCtx();
    const layer = layerOf(routeVerts([[-600, 0, NaN], [600, 0, NaN]]), new Uint32Array([0, 1]), {});
    const rebuilds0 = drapePerf.rebuilds;
    drawIngestOverlay(ctx as unknown as CanvasRenderingContext2D, CAM, [layer], { drape: DRAPE });
    expect(drapePerf.rebuilds - rebuilds0).toBe(1); // primera vez: construye
    drawIngestOverlay(ctx as unknown as CanvasRenderingContext2D, CAM, [layer], { drape: DRAPE });
    expect(drapePerf.rebuilds - rebuilds0).toBe(1); // 2º cuadro: caché viva
    drawIngestOverlay(ctx as unknown as CanvasRenderingContext2D, CAM, [layer], {
      drape: { ...DRAPE, stamp: 2 },
    });
    expect(drapePerf.rebuilds - rebuilds0).toBe(2); // terreno nuevo ⇒ rebuild
    expect(drapePerf.layers).toBe(1);
    expect(drapePerf.mdtVerts).toBeGreaterThan(0);
  });
});
