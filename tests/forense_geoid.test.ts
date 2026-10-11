/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FORENSE GEoid — unidad geoid.ts (FR-7 · GGM25), ratificación D-1
 * ( · checkpoint ).
 *
 * D-1 (urgente, desbloquea la unidad): fixtures autocotejadas con lector
 * independiente. Cotejo EJECUTADO en sandbox con GDAL/rasterio 1.5.0
 * (precedente KwKwK/libtiff) sobre el ARCHIVO REAL en custodia:
 *
 *   upload/794551163085_b.zip · sha256 2c63a19cdc9d6351… · 16,718,134 B
 *   GGM25.hdr (BYTEORDER I · LAYOUT BIL · 2100×3000 · FLOAT32 · 1′ ·
 *   UL -124.991666667/39.9916666667 · NODATA -nan) · GGM25.prj
 *   (GEOGCS GCS_GRS_1980) · GGM25.bil (25,200,000 B EXACTOS · 0 NaN de
 *   6,300,000 celdas · rango −47.706 … +27.290 m — RATIFICADO por GDAL).
 *
 * HALLAZGO D-1 (registro honesto): el muestreo PUNTUAL del checkpoint
 * anterior (CDMX −5.431 · GDL −15.401 · MTY −19.246 · Soledad −11.356 ·
 * Cancún −11.367) NO es reproducible en GGM25 con coordenadas canónicas
 * públicas (Δ −0.014…+0.126 m) y sus coordenadas NO quedaron registradas
 * — los valores exactos existen como celdas del grid a cientos de filas
 * de las ciudades (procedencia incierta: mapeo lat/fila del instrumento
 * de la sesión previa). El RANGO global sí cuadra exacto. Resolución:
 * GOLDEN RE-ESTAMPADA con procedencia completa — coordenadas canónicas
 * públicas + valores verificados por DOS lectores independientes
 * (GDAL/rasterio y este parser, misma fórmula bilineal). Los valores
 * antiguos quedan como historia; −11.356 jamás se hornéa (FR-7 sigue
 * elipsoidal-declarado; la fila de datum del export declara el estado).
 *
 * GOLDEN (bilineal, lector GDAL · celda = (j,i) del censo):
 *   CDMX     19.4326, −99.1332  → −5.444857 m  (celda 1233,1551)
 *   GDL      20.6597, −103.3496 → −15.420479 m (celda 1159,1298)
 *   MTY      25.6866, −100.3161 → −19.183630 m (celda  858,1480)
 *   SOLEDAD  21.0518, −101.3248 → −11.229993 m (celda 1136,1420)  ← centro
 *            de la región revisión de ingeniería (regions.ts), no dato de brigadista
 *   CANCÚN   21.1619, −86.8515  → −11.382100 m (celda 1129,2288)
 *
 * FR-W1: fixtures sintéticas para TODO el catálogo hostiles; el archivo
 * real es un MODELO PÚBLICO de INEGI (custodia commiteada en upload/);
 * las coordenadas de la golden son referencias públicas de ciudades y el
 * centro catalogado de la región — 0 coordenadas de misión ni personas.
 *
 * Convención BIL (verificada contra GDAL/EHdr): ULXMAP/ULYMAP = CENTRO de
 * la celda (0,0); fila 0 = NORTE; la banda i=w−1 / j=h−1 es NaN (misma
 * semántica de sampleDemElevation — «la bilineal existente»).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from '../src/lib/ingest/zip';
import {
  parseBilGeoid,
  parseGgm25Zip,
  undulation,
  toOrthometric,
  geoidFichaRows,
} from '../src/lib/ingest/geoid';

/* ------------------------------------------------------------------ */
/* Builders deterministas (mismo estilo que forense_pack/paridad)      */
/* ------------------------------------------------------------------ */

const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const u32 = (v: number): Uint8Array =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

function cat(parts: Array<Uint8Array>): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface ZipIn {
  name: string;
  data: Uint8Array;
}

/** Escritor ZIP mínimo (PKZIP 2.0, almacenado) — lo que el lector exige. */
function buildZip(inputs: ZipIn[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const offsets: number[] = [];
  let off = 0;
  const enc = new TextEncoder();
  for (const inp of inputs) {
    const crc = crc32(inp.data);
    offsets.push(off);
    const nameB = enc.encode(inp.name);
    const local = cat([
      u32(0x04034b50), u16(20), u16(0x800), u16(0),
      u16(0), u16(0), u32(crc), u32(inp.data.length), u32(inp.data.length),
      u16(nameB.length), u16(0), nameB, inp.data,
    ]);
    chunks.push(local);
    central.push(cat([
      u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(0),
      u16(0), u16(0), u32(crc), u32(inp.data.length), u32(inp.data.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offsets[offsets.length - 1]), nameB,
    ]));
    off += local.length;
  }
  const cdOff = off;
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = cat([
    u32(0x06054b50), u16(0), u16(0), u16(inputs.length), u16(inputs.length),
    u32(cdSize), u32(cdOff), u16(0),
  ]);
  return cat([...chunks, ...central, eocd]);
}

/** Rejilla sintética 6×5: v(i,j) = i*10 − j*7 (enteros exactos en f32). */
const W = 6;
const H = 5;
const DX = 0.01666666666; // 1′ de arco (como el GGM25 real)
const ULX = -101.35;
const ULY = 21.1;

function gridOf(fill: (i: number, j: number) => number): Float32Array {
  const d = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) d[j * W + i] = fill(i, j);
  return d;
}

const GRID = gridOf((i, j) => i * 10 - j * 7); // min −28 (i=0,j=4) · max 50 (i=5,j=0)

function hdrText(over: Record<string, string | undefined> = {}, drop: string[] = []): string {
  const base: Record<string, string> = {
    BYTEORDER: 'I',
    LAYOUT: 'BIL',
    NROWS: String(H),
    NCOLS: String(W),
    NBANDS: '1',
    NBITS: '32',
    BANDROWBYTES: String(W * 4),
    TOTALROWBYTES: String(W * 4),
    PIXELTYPE: 'FLOAT',
    ULXMAP: String(ULX),
    ULYMAP: String(ULY),
    XDIM: String(DX),
    YDIM: String(DX),
    NODATA: '-9999',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return (
    Object.entries(base)
      .filter(([k]) => !drop.includes(k))
      .map(([k, v]) => `${k.padEnd(15)}${v}`)
      .join('\n') + '\n'
  );
}

const PRJ_GRS80 =
  'GEOGCS["GCS_GRS_1980",DATUM["D_GRS_1980",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const PRJ_WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const PRJ_PROJCS =
  'PROJCS["WGS 84 / UTM zone 14N",GEOGCS["WGS 84",DATUM["WGS_1984"]],PROJECTION["Transverse_Mercator"]]';
const PRJ_NAD27 =
  'GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",SPHEROID["Clarke_1866",6378206.4,294.9786982]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

const enc = new TextEncoder();

function bilBytes(g: Float32Array, byteorder: 'I' | 'M' = 'I'): Uint8Array {
  const out = new Uint8Array(g.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < g.length; i++) dv.setFloat32(i * 4, g[i], byteorder === 'I');
  return out;
}

function zipOf(
  hdr: string,
  bil: Uint8Array,
  prj: string | null = PRJ_GRS80,
  base = 'geoid'
): Uint8Array {
  const inputs: ZipIn[] = [
    { name: `${base}.hdr`, data: enc.encode(hdr) },
    { name: `${base}.bil`, data: bil },
  ];
  if (prj !== null) inputs.push({ name: `${base}.prj`, data: enc.encode(prj) });
  return buildZip(inputs);
}

function parseOk(hdr: string, bil: Uint8Array, prj: string | null = PRJ_GRS80) {
  const r = parseGgm25Zip(zipOf(hdr, bil, prj));
  if (!r.ok) throw new Error(`fixture debía parsear y fue rechazada: ${r.reason}`);
  return r.model;
}

/* ------------------------------------------------------------------ */
/* LA SUITE                                                            */
/* ------------------------------------------------------------------ */

describe('geoid.ts — lector BIL+HDR 0-dep (FR-7 · GGM25, ratificación D-1)', () => {
  test('happy path ZIP: estructura exacta del modelo sintético', () => {
    const m = parseOk(hdrText(), bilBytes(GRID));
    expect(m.name).toBe('geoid');
    expect(m.w).toBe(W);
    expect(m.h).toBe(H);
    expect(m.ulx).toBeCloseTo(ULX, 12);
    expect(m.uly).toBeCloseTo(ULY, 12);
    expect(m.dx).toBeCloseTo(DX, 12);
    expect(m.dy).toBeCloseTo(DX, 12);
    expect(m.byteorder).toBe('I');
    expect(m.bytes).toBe(W * H * 4);
    expect(m.min).toBe(-28);
    expect(m.max).toBe(50);
    expect(m.nodata).toBe(-9999);
    expect(m.crsNote).toContain('GRS_1980');
    expect(m.crsNote).toContain('ADR D10');
  });

  test('convención BIL: ULXMAP/ULYMAP es el CENTRO de la celda (0,0) — cotejo GDAL', () => {
    const m = parseOk(hdrText(), bilBytes(GRID));
    // En el centro exacto de la celda (0,0) el valor es data[0] EXACTO
    // ((lon−ulx)/dx = 0 sin error FP — ambos ejes en 0 exactos).
    expect(undulation(m, ULY, ULX)).toBe(GRID[0]);
    // Centro de la celda (2,1): v = 2*10 − 1*7 = 13. La posición pasa por
    // (lon−ulx)/dx ⇒ tolerancia de 1 ulp FP (el centro es frágil, el VALOR
    // no: cae a uno u otro lado del mismo centro).
    expect(undulation(m, ULY - 1 * DX, ULX + 2 * DX)).toBeCloseTo(13, 8);
    // Bilineal a medio paso: función lineal ⇒ promedio exacto de 4 esquinas
    // (13, 23 · 6, 16) = 14.5 — la fórmula es la de sampleDemElevation.
    expect(undulation(m, ULY - 1.5 * DX, ULX + 2.5 * DX)).toBeCloseTo(14.5, 8);
  });

  test('fuera de cobertura ⇒ NaN (honesto) — incluida la banda última i=w−1/j=h−1', () => {
    const m = parseOk(hdrText(), bilBytes(GRID));
    expect(undulation(m, ULY + 1, ULX)).toBeNaN(); // norte fuera
    expect(undulation(m, ULY - H * DX, ULX)).toBeNaN(); // sur fuera
    expect(undulation(m, ULY, ULX - 1)).toBeNaN(); // oeste fuera
    expect(undulation(m, ULY, ULX + W * DX)).toBeNaN(); // este fuera
    // ENMIENDA honesta del contrato (puerto D-1,  —
    // épsilon de borde): los puntos a MEDIA CELDA más allá del último nodo
    // siguen FUERA de cobertura (NaN, regla intacta). Lo que CAMBIA con D-1:
    // el nodo EXACTO del borde (i=w−1/j=h−1) — que antes era NaN por
    // `i >= w−1` — ahora es COBERTURA (épsilon 1e-9°) y devuelve el nodo
    // (ver describe «PUERTO D-1» abajo).
    expect(undulation(m, ULY - 0.5 * DX, ULX + (W - 0.5) * DX)).toBeNaN();
    expect(undulation(m, ULY - (H - 0.5) * DX, ULX + 0.5 * DX)).toBeNaN();
    expect(undulation(m, NaN, ULX)).toBeNaN();
    expect(undulation(m, ULY, Infinity)).toBeNaN();
  });

  test('toOrthometric: H = h − N · NaN propagado honestamente', () => {
    const m = parseOk(hdrText(), bilBytes(GRID));
    const lat = ULY - 1 * DX;
    const lon = ULX + 2 * DX;
    expect(toOrthometric(m, lat, lon, 2100)).toBeCloseTo(2100 - 13, 8);
    expect(toOrthometric(m, ULY + 5, lon, 2100)).toBeNaN();
  });

  test('NODATA numérico respetado: celda −9999 ⇒ NaN la vecindad que la toca', () => {
    const g = gridOf((i, j) => (i === 2 && j === 1 ? -9999 : i * 10 - j * 7));
    const m = parseOk(hdrText(), bilBytes(g));
    expect(undulation(m, ULY - 1 * DX, ULX + 2 * DX)).toBeNaN(); // la celda
    expect(undulation(m, ULY - 1.5 * DX, ULX + 2.5 * DX)).toBeNaN(); // esquina
    // Punto que NO toca la celda NODATA: intacto — bilineal de las 4
    // esquinas (0, 10 · −7, 3) a medio paso = 1.5 (aritmética exacta).
    expect(undulation(m, ULY - 0.5 * DX, ULX + 0.5 * DX)).toBeCloseTo(1.5, 8);
    // min/max saltan el NODATA.
    expect(m.min).toBe(-28);
    expect(m.max).toBe(50);
  });

  test('NODATA «-nan» (el del GGM25 real) se honra como NaN', () => {
    const g = gridOf((i, j) => (i === 1 && j === 1 ? NaN : i * 10 - j * 7));
    const m = parseOk(hdrText({ NODATA: '-nan' }), bilBytes(g));
    expect(m.nodata).toBeNaN();
    expect(undulation(m, ULY - 1 * DX, ULX + 1 * DX)).toBeNaN();
    // Sin clave NODATA ⇒ null (las celdas NaN siguen siendo inválidas).
    const m2 = parseOk(hdrText({}, ['NODATA']), bilBytes(g));
    expect(m2.nodata).toBeNull();
    expect(undulation(m2, ULY - 1 * DX, ULX + 1 * DX)).toBeNaN();
  });

  test('BYTEORDER M (big-endian) honrado — declaración del HDR manda', () => {
    const m = parseOk(hdrText({ BYTEORDER: 'M' }), bilBytes(GRID, 'M'));
    expect(m.byteorder).toBe('M');
    expect(m.max).toBe(50);
    expect(undulation(m, ULY - 1 * DX, ULX + 2 * DX)).toBeCloseTo(13, 8);
    // Bytes LE con HDR que declara M ⇒ valores absurdos, pero NO crash:
    // el barrido puede dar 0 válidos (rechazo) o rango errado — ambos honrados.
    const wrong = parseGgm25Zip(zipOf(hdrText({ BYTEORDER: 'M' }), bilBytes(GRID, 'I')));
    if (wrong.ok) expect(wrong.ok).toBeTrue();
    else expect(wrong.reason).toBeTruthy();
  });

  test('PRJ WGS84 también es familia válida; sin PRJ ⇒ default honesto', () => {
    const m = parseOk(hdrText(), bilBytes(GRID), PRJ_WGS84);
    expect(m.crsNote).toContain('WGS_1984');
    const m2 = parseOk(hdrText(), bilBytes(GRID), null);
    expect(m2.crsNote).toContain('default');
    expect(m2.crsNote).toContain('WGS84/ITRF2008');
  });

  /* ------------------ catálogo hostiles BIL ------------------------- */

  test('hostil: LAYOUT ≠ BIL', () => {
    const r = parseGgm25Zip(zipOf(hdrText({ LAYOUT: 'BSQ' }), bilBytes(GRID)));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain('LAYOUT «BSQ» ≠ BIL');
  });

  test('hostil: BYTEORDER desconocido', () => {
    const r = parseGgm25Zip(zipOf(hdrText({ BYTEORDER: 'Q' }), bilBytes(GRID)));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain('BYTEORDER «Q» desconocido');
  });

  test('hostil: NBITS inválido (16) y NBANDS ≠ 1', () => {
    const a = parseGgm25Zip(zipOf(hdrText({ NBITS: '16' }), bilBytes(GRID)));
    expect(a.ok).toBeFalse();
    if (!a.ok) expect(a.reason).toContain('NBITS «16»');
    const b = parseGgm25Zip(zipOf(hdrText({ NBANDS: '2' }), bilBytes(GRID)));
    expect(b.ok).toBeFalse();
    if (!b.ok) expect(b.reason).toContain('NBANDS «2»');
  });

  test('hostil: dims absurdas (1 fila · 0 cols · no numéricas · gigantes)', () => {
    for (const over of [
      { NROWS: '1' },
      { NCOLS: '0' },
      { NROWS: 'abc' },
      { NROWS: '99999999' },
    ]) {
      const r = parseGgm25Zip(zipOf(hdrText(over), bilBytes(GRID)));
      expect(r.ok).toBeFalse();
      if (!r.ok) expect(r.reason).toContain('dims absurdas');
    }
  });

  test('hostil: XDIM/YDIM inválidos (0 · negativo · >1°)', () => {
    for (const over of [{ XDIM: '0' }, { YDIM: '-0.01' }, { XDIM: '1.5' }]) {
      const r = parseGgm25Zip(zipOf(hdrText(over), bilBytes(GRID)));
      expect(r.ok).toBeFalse();
      if (!r.ok) expect(r.reason).toContain('XDIM/YDIM inválidos');
    }
  });

  test('hostil: campo obligatorio del HDR ausente (ULXMAP · BYTEORDER · todo)', () => {
    const a = parseGgm25Zip(zipOf(hdrText({}, ['ULXMAP']), bilBytes(GRID)));
    expect(a.ok).toBeFalse();
    if (!a.ok) expect(a.reason).toContain('HDR sin «ULXMAP»');
    const b = parseGgm25Zip(zipOf(hdrText({}, ['BYTEORDER']), bilBytes(GRID)));
    expect(b.ok).toBeFalse();
    if (!b.ok) expect(b.reason).toContain('HDR sin «BYTEORDER»');
    // HDR fracturado (vacío) — todas las claves ausentes, la primera manda.
    const c = parseGgm25Zip(zipOf('', bilBytes(GRID)));
    expect(c.ok).toBeFalse();
    if (!c.ok) expect(c.reason).toContain('HDR sin «');
  });

  test('hostil: BIL truncado — faltan bytes EXACTOS en el motivo', () => {
    const bil = bilBytes(GRID);
    const r = parseGgm25Zip(zipOf(hdrText(), bil.slice(0, bil.length - 3)));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain('faltan 3');
  });

  test('hostil: BIL con sobrante — bytes de más EXACTOS en el motivo', () => {
    const bil = bilBytes(GRID);
    const r = parseGgm25Zip(zipOf(hdrText(), cat([bil, new Uint8Array([1, 2, 3, 4, 5])])));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain('+5 B exactos');
  });

  test('hostil: grid 100 % NODATA', () => {
    const g = gridOf(() => NaN);
    const r = parseGgm25Zip(zipOf(hdrText({ NODATA: '-nan' }), bilBytes(g)));
    expect(r.ok).toBeFalse();
    if (!r.ok) expect(r.reason).toContain('todo NODATA');
  });

  test('hostil: PRJ divergente (proyectado · datum fuera de familia)', () => {
    const a = parseGgm25Zip(zipOf(hdrText(), bilBytes(GRID), PRJ_PROJCS));
    expect(a.ok).toBeFalse();
    if (!a.ok) expect(a.reason).toContain('PRJ proyectado');
    const b = parseGgm25Zip(zipOf(hdrText(), bilBytes(GRID), PRJ_NAD27));
    expect(b.ok).toBeFalse();
    if (!b.ok) expect(b.reason).toContain('divergencia honesta');
    const c = parseGgm25Zip(zipOf(hdrText(), bilBytes(GRID), 'basura no WKT'));
    expect(c.ok).toBeFalse();
    if (!c.ok) expect(c.reason).toContain('GEOGCS');
  });

  test('hostil contenedor: sin par · par ambiguo · desparejado · no-ZIP', () => {
    const bil = bilBytes(GRID);
    // Solo .bil (sin .hdr)
    const a = parseGgm25Zip(buildZip([{ name: 'geoid.bil', data: bil }]));
    expect(a.ok).toBeFalse();
    if (!a.ok) expect(a.reason).toContain('sin par HDR+BIL');
    // Dos .hdr — ambiguo
    const b = parseGgm25Zip(
      buildZip([
        { name: 'a.hdr', data: enc.encode(hdrText()) },
        { name: 'b.hdr', data: enc.encode(hdrText()) },
        { name: 'a.bil', data: bil },
      ])
    );
    expect(b.ok).toBeFalse();
    if (!b.ok) expect(b.reason).toContain('múltiples .hdr');
    // Desparejados (a.hdr + b.bil)
    const c = parseGgm25Zip(
      buildZip([
        { name: 'a.hdr', data: enc.encode(hdrText()) },
        { name: 'b.bil', data: bil },
      ])
    );
    expect(c.ok).toBeFalse();
    if (!c.ok) expect(c.reason).toContain('desparejados');
    // No es ZIP
    const d = parseGgm25Zip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(d.ok).toBeFalse();
    if (!d.ok) expect(d.reason).toContain('ZIP hostil');
  });

  test('ficha determinista (sin tiempos — paridad worker/sync)', () => {
    const m = parseOk(hdrText(), bilBytes(GRID));
    const rows = geoidFichaRows(m);
    expect(rows[0][0]).toBe('Datum vertical');
    expect(rows[0][1]).toContain('«geoid» (ortométrica)');
    expect(rows[2][1]).toContain('-28');
    expect(rows[2][1]).toContain('50');
    expect(rows[3][0]).toBe('CRS horizontal');
  });
});

/* ------------------------------------------------------------------ */
/* GATE REAL — el archivo de custodia (commiteado en upload/)          */
/* ------------------------------------------------------------------ */

const REAL_PATH = join(import.meta.dir, '..', 'upload', '794551163085_b.zip');

function readReal(): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(REAL_PATH));
  } catch {
    return null; // sandbox sin custodia — la suite no miente: los gates de abajo se saltan
  }
}

const REAL = readReal();
const G = test.skipIf(REAL === null);

describe('GGM25 REAL en custodia — golden re-estampada (cotejo doble lector)', () => {
  G('estructura del ZIP nacional ≡ registro (2100×3000 · LE · 1′ · sin NaN)', () => {
    const r = parseGgm25Zip(REAL!);
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const m = r.model;
    expect(m.name).toBe('ggm25');
    expect(m.w).toBe(3000); // NCOLS — lon −124.99…−74.99
    expect(m.h).toBe(2100); // NROWS — lat 39.99…5.01
    expect(m.byteorder).toBe('I');
    expect(m.bytes).toBe(25_200_000);
    expect(m.ulx).toBeCloseTo(-124.991666667, 9);
    expect(m.uly).toBeCloseTo(39.9916666667, 9);
    expect(m.dx).toBeCloseTo(1 / 60, 9);
    expect(m.dy).toBeCloseTo(1 / 60, 9);
    expect(m.nodata).toBeNaN(); // «-nan» declarado · 0 celdas NaN (100 % cobertura)
    expect(m.min).toBeCloseTo(-47.706, 2); // rango RATIFICADO por GDAL
    expect(m.max).toBeCloseTo(27.29, 2);
    expect(m.crsNote).toContain('GRS_1980');
  });

  G('golden re-estampada — 5 puntos canónicos (GDAL ≡ parser ≤ 5e-4 m)', () => {
    const r = parseGgm25Zip(REAL!);
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const m = r.model;
    // [nombre, lat, lon, bilinear GDAL] — coordenadas públicas canónicas;
    // Soledad = centro catalogado de la región revisión de ingeniería (regions.ts).
    const GOLDEN: Array<[string, number, number, number]> = [
      ['CDMX', 19.4326, -99.1332, -5.444857],
      ['GDL', 20.6597, -103.3496, -15.420479],
      ['MTY', 25.6866, -100.3161, -19.18363],
      ['SOLEDAD', 21.0518, -101.3248, -11.229993],
      ['CANCUN', 21.1619, -86.8515, -11.3821],
    ];
    for (const [name, lat, lon, expected] of GOLDEN) {
      const n = undulation(m, lat, lon);
      expect(Number.isFinite(n)).toBeTrue();
      expect(Math.abs(n - expected)).toBeLessThanOrEqual(5e-4);
    }
    // La Soledad: cota ortométrica de PRUEBA (fixture del parser, jamás
    // horneada en producto — FR-7 elipsoidal-declarado fuera de unidad).
    expect(toOrthometric(m, 21.0518, -101.3248, 2100)).toBeCloseTo(2100 - -11.229993, 3);
  });

  G('cobertura honesta del modelo real: dentro ⇒ finito · fuera ⇒ NaN', () => {
    const r = parseGgm25Zip(REAL!);
    expect(r.ok).toBeTrue();
    if (!r.ok) return;
    const m = r.model;
    // Centro del grid (lon −99.99, lat 22.5) — finito.
    expect(Number.isFinite(undulation(m, 22.5, -99.99))).toBeTrue();
    // Fuera de cobertura (EE. UU. al norte · Pacífico al oeste) ⇒ NaN.
    expect(undulation(m, 41.0, -101.0)).toBeNaN();
    expect(undulation(m, 21.0, -126.0)).toBeNaN();
    expect(undulation(m, 4.0, -99.0)).toBeNaN();
  });
});

/* ------------------------------------------------------------------ */
/* PUERTO D-1 (GPS-ORTO) — épsilon de borde · NODATA-por-pesos ·       */
/* lerp bit-exacto. Tres mejoras del linaje local (custodia            */
/* `ventana-local-task47`, LEDGER DE DELTAS D-1) LATENTES con el       */
/* GGM25 real (0 NODATA) y REALES con cualquier grid con NODATA.       */
/* ------------------------------------------------------------------ */
describe('geoid.ts — PUERTO D-1: épsilon de borde · NODATA-por-pesos · lerp bit-exacto', () => {
  test('épsilon de borde: el nodo EXACTO del borde este/sur es COBERTURA y devuelve el nodo (antes NaN)', () => {
    const m = parseOk(hdrText(), bilBytes(GRID));
    /* RUTA DETERMINISTA del nodo: último nodo + 1e-10° (dentro del épsilon
       de 1e-9°) cae en la banda de clamp ⇒ t=1 EXACTO ⇒ nodo bit-exacto
       (toBe, sin tolerancia — la aritmética no interviene). */
    expect(undulation(m, ULY, ULX + (W - 1) * DX + 1e-10)).toBe(GRID[5]); // este: nodo (0,5)=50
    expect(undulation(m, ULY - (H - 1) * DX - 1e-10, ULX)).toBe(GRID[4 * W]); // sur: nodo (4,0)=−28
    expect(undulation(m, ULY - (H - 1) * DX - 1e-10, ULX + (W - 1) * DX + 1e-10)).toBe(GRID[W * H - 1]); // SE: (4,5)=22
    /* Coordenada EXACTA del nodo: equivalente al nodo a ≤1e-9 m (la cota de
       1 ulp del round-trip lon/lat — honesto, no bit-exacto por diseño FP). */
    expect(undulation(m, ULY, ULX + (W - 1) * DX)).toBeCloseTo(GRID[5], 9);
    expect(undulation(m, ULY - (H - 1) * DX, ULX)).toBeCloseTo(GRID[4 * W], 9);
    /* Media celda más allá del último nodo ⇒ NaN (el épsilon es 1e-9°, no una banda). */
    expect(undulation(m, ULY, ULX + (W - 0.5) * DX)).toBeNaN();
    expect(undulation(m, ULY - (H - 0.5) * DX, ULX)).toBeNaN();
  });

  test('lerp bit-exacto: t=0/1 devuelve el NODO sin aritmética (a+(b−a)·1 ≠ b en IEEE)', () => {
    /* v(0,4)=1e8 y v(0,5)=0.1 (f32): la fórmula vieja en t=1 daba 1e8+(0.1−1e8) ≠ nodo;
       el lerp del puerto D-1 devuelve el nodo EXACTO — comparado contra el
       valor f32 ALMACENADO (el BIL es Float32: f32(0.1) ≠ literal 0.1). */
    const g = gridOf((i, j) => (j === 0 ? (i === 5 ? 0.1 : 1e8) : i * 10 - j * 7));
    const m = parseOk(hdrText(), bilBytes(g));
    expect(undulation(m, ULY, ULX + (W - 1) * DX + 1e-10)).toBe(g[5]); // t=1 vía clamp de la banda de épsilon
    expect(undulation(m, ULY, ULX)).toBe(g[0]); // nodo oeste, t=0
  });

  test('NODATA-por-pesos (fix LATENTE): la celda lejana de peso 0 NO envenena', () => {
    // NODATA en (5,1) — celda lejana al muestrear el borde este fila 0
    // (fy=0 ⇒ w01=w11=0): con el GGM25 real (0 NODATA) esto es invisible;
    // con CUALQUIER grid con NODATA la diferencia es real.
    const g = gridOf((i, j) => (i === 5 && j === 1 ? -9999 : i * 10 - j * 7));
    const m = parseOk(hdrText(), bilBytes(g));
    // Borde este exacto fila 0: solo v10 tiene peso 1 ⇒ el NODATA (peso 0) no anula.
    expect(undulation(m, ULY, ULX + 5 * DX)).toBe(50);
    // La MISMA celda NODATA con peso > 0 SÍ anula (regla honesta intacta).
    expect(undulation(m, ULY - 1.5 * DX, ULX + 5 * DX)).toBeNaN();
    // Vecindad interior de la celda NODATA (peso 0.25) ⇒ NaN (contrato previo).
    expect(undulation(m, ULY - 0.5 * DX, ULX + 4.5 * DX)).toBeNaN();
  });

  test('paridad interior bit-idéntica: 0<t<1 usa LA MISMA fórmula del hito geoid', () => {
    const m = parseOk(hdrText(), bilBytes(GRID));
    const puntos: Array<readonly [number, number]> = [
      [0.25, 0.75],
      [2.5, 1.5],
      [2.3, 1.7],
      [4.9, 2.2],
      [3.14159, 0.57721],
    ];
    for (const [xc, yr] of puntos) {
      /* La paridad es de la FÓRMULA de interpolación — el test replica la
         aritmética de coordenadas del módulo (mismo round-trip lon/lat ⇒
         xf/yf, misma cancelación ULY−lat), para aislar el lerp. */
      const lon = ULX + xc * DX;
      const lat = ULY - yr * DX;
      const xf = (lon - ULX) / DX;
      const yf = (ULY - lat) / DX;
      const i = Math.floor(xf);
      const j = Math.floor(yf);
      const fx = Math.min(Math.max(xf - i, 0), 1);
      const fy = Math.min(Math.max(yf - j, 0), 1);
      const v00 = GRID[j * W + i];
      const v10 = GRID[j * W + i + 1];
      const v01 = GRID[(j + 1) * W + i];
      const v11 = GRID[(j + 1) * W + i + 1];
      const top = v00 + (v10 - v00) * fx;
      const bottom = v01 + (v11 - v01) * fx;
      const esperado = top + (bottom - top) * fy;
      expect(undulation(m, lat, lon)).toBe(esperado);
    }
  });
});
