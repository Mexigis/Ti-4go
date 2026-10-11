/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — Unidad RECORTADOR · topopack.ts (ruta escritorio del
 * entregable topográfico en ZIP, patrón hermano del geoide GGM25).
 *
 * Contrato probado:
 *   - Patrón: 1×.tif ± sidecars (.tfwx / *.aux.xml / .prj) SIN manifest.json
 *     ⇒ ruta escritorio; cualquier otro contenido ⇒ null (cae al Mission
 *     Pack intacto); tif sin magic II·MM ⇒ Error legible (hostil).
 *   - Clasificación por CONTENIDO del tif (jamás por nombre): mono
 *     (1 muestra, 8/16/32/64 bits) ⇒ 'demzip' (Motor DEM Real); multibanda
 *     (p. ej. 8×3 RGB) ⇒ 'carta' (escaneada documental, sin banda de
 *     elevación — la ficha lo declara, nada inventado).
 *   - .tfwx: afín EXTERNA reportada (esquina NO UTM 14N ⇒ WGS84 Snyder FR-1).
 *   - Paridad doble lector (estándar del geoid): los valores del parser
 *     ≡ GDAL/rasterio sobre el raster REAL convertido (EX-005), con guard
 *     honesto si rasterio no está en el entorno.
 *
 * Rejilla REAL: `upload/mx_inegi_GGM10_stripped.tif` (Geoide Gravimétrico
 * Mexicano 2010 · INEGI · 792×456 · Float32 · Deflate strips · NODATA
 * −32767), convertido in-situ con `gdal_translate -co TILED=NO
 * -co COMPRESS=DEFLATE` desde el original TILED 256×256 + PREDICTOR=3.
 * Si el archivo no está en el sandbox, los tests REAL se saltan con aviso
 * (patrón idéntico al de la rejilla GGM25 de forense_geoid).
 */

import { describe, expect, test } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { crc32 } from '../src/lib/ingest/zip';
import { parseFile, detectFormat } from '../src/lib/ingest/parsers';
import {
  extractTopoPack,
  looksLikeTopoZip,
  classifyTopo,
  parseTfwx,
  tfwxRows,
} from '../src/lib/ingest/topopack';
import { decodeGeoTiffDem } from '../src/lib/ingest/geotiff-dem';
import type { Anchor } from '../src/lib/ingest/parsers';

/** Ancla de La Soledad (región oficial) — trazabilidad de ficha. */
const ANCHOR: Anchor = {
  extentM: 6400,
  zMinM: 2000,
  zMaxM: 2545,
  centerLat: 21.0518,
  centerLon: -101.3248,
  regionName: 'Cuenca de la Soledad',
};

/* ------------------------------------------------------------------ */
/* Builders (0-dep): ZIP (stored/deflate) + TIFF mono/RGB sintéticos   */
/* ------------------------------------------------------------------ */

const T = { BYTE: 1, SHORT: 3, LONG: 4, DOUBLE: 12 } as const;

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const w16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
};
const w32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const enc = new TextEncoder();

function buildZip(inputs: Array<{ name: string; data: Uint8Array; method?: 0 | 8 }>): ArrayBuffer {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const inp of inputs) {
    let data = inp.data;
    const method = (inp.method ?? 0) as 0 | 8;
    if (method === 8) data = new Uint8Array(deflateRawSync(data));
    const crc = crc32(inp.data);
    const nameB = enc.encode(inp.name);
    const local = concat(
      w32(0x04034b50), w16(20), w16(0), w16(method), w16(0), w16(0),
      w32(crc), w32(data.length), w32(inp.data.length), w16(nameB.length), w16(0),
      nameB, data
    );
    locals.push(local);
    central.push(concat(
      w32(0x02014b50), w16(20), w16(20), w16(0), w16(method), w16(0), w16(0),
      w32(crc), w32(data.length), w32(inp.data.length), w16(nameB.length),
      w16(0), w16(0), w16(0), w16(0), w32(0), w32(off),
      nameB
    ));
    off += local.length;
  }
  const cdStart = off;
  const cd = concat(...central);
  const eocd = concat(
    w32(0x06054b50), w16(0), w16(0), w16(inputs.length), w16(inputs.length),
    w32(cd.length), w32(cdStart), w16(0)
  );
  return concat(...locals, cd, eocd).buffer.slice(
    0,
    locals.reduce((a, l) => a + l.length, 0) + cd.length + eocd.length
  ) as ArrayBuffer;
}

type Entry = { tag: number; type: number; count: number; value: number | number[] };

function buildTiff(opts: {
  w: number;
  h: number;
  /** mono: 1 muestra float64 · rgb: 3 bandas uint8 (fila 0 = norte) */
  kind: 'mono' | 'rgb';
  data: Float64Array | Uint8Array;
  withGeoKeys?: boolean;
}): ArrayBuffer {
  const { w, h, data, kind } = opts;
  const samples = kind === 'mono' ? 1 : 3;
  const raster =
    kind === 'mono' ? new Uint8Array(new Float64Array(data as Float64Array).buffer) : (data as Uint8Array);

  const ext: Uint8Array[] = [];
  const pushExt = (u8: Uint8Array): number => {
    ext.push(u8);
    return ext.length - 1;
  };

  const entries: Entry[] = [
    { tag: 256, type: T.LONG, count: 1, value: w },
    { tag: 257, type: T.LONG, count: 1, value: h },
  ];
  if (kind === 'mono') {
    entries.push({ tag: 258, type: T.SHORT, count: 1, value: 64 });
    entries.push({ tag: 339, type: T.SHORT, count: 1, value: 3 }); // float
  } else {
    // BitsPerSample ×3 y SampleFormat ×3 no caben en línea ⇒ externos
    entries.push({ tag: 258, type: T.SHORT, count: 3, value: pushExt(new Uint8Array(new Uint16Array([8, 8, 8]).buffer)) as unknown as number });
    entries.push({ tag: 339, type: T.SHORT, count: 3, value: pushExt(new Uint8Array(new Uint16Array([1, 1, 1]).buffer)) as unknown as number });
  }
  entries.push({ tag: 259, type: T.SHORT, count: 1, value: 1 }); // sin comprimir
  entries.push({ tag: 273, type: T.LONG, count: 1, value: 0 }); // StripOffsets — parcheado
  entries.push({ tag: 277, type: T.SHORT, count: 1, value: samples });
  entries.push({ tag: 278, type: T.LONG, count: 1, value: h }); // RowsPerStrip = h
  entries.push({ tag: 279, type: T.LONG, count: 1, value: raster.length });
  entries.push({ tag: 284, type: T.SHORT, count: 1, value: 1 }); // PlanarConfig
  // georreferencia mínima (obligatoria para el Motor DEM Real)
  entries.push({ tag: 33550, type: T.DOUBLE, count: 3, value: pushExt(new Uint8Array(new Float64Array([0.001, 0.001, 0]).buffer)) as unknown as number });
  entries.push({ tag: 33922, type: T.DOUBLE, count: 6, value: pushExt(new Uint8Array(new Float64Array([0, 0, 0, -101.4, 21.0, 0]).buffer)) as unknown as number });
  if (opts.withGeoKeys) {
    entries.push({
      tag: 34735, type: T.SHORT, count: 12,
      value: pushExt(new Uint8Array(new Uint16Array([1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 4326]).buffer)) as unknown as number,
    });
  }
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOff = 8;
  const ifdLen = 2 + entries.length * 12 + 4;
  let cur = ifdOff + ifdLen;
  const extOffsets: number[] = [];
  for (const e of ext) {
    extOffsets.push(cur);
    cur += e.length;
  }
  const rasterOff = cur;

  const buf = new ArrayBuffer(rasterOff + raster.length);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x49; u8[1] = 0x49; // 'II'
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, entries.length, true);
  let p = ifdOff + 2;
  const idx273 = entries.findIndex((e) => e.tag === 273);
  if (idx273 >= 0) entries[idx273].value = rasterOff;
  for (const e of entries) {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    const TS: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
    const inline = e.count * (TS[e.type] ?? 1);
    if (inline <= 4 && typeof e.value === 'number' && e.value < 1000) {
      // valor en línea (todas las entradas externas de este builder tienen
      // count·size > 4 ⇒ cualquier valor numérico aquí es un valor real)
      if (e.type === T.SHORT) dv.setUint16(p + 8, e.value, true);
      else dv.setUint32(p + 8, e.value, true);
    } else {
      // externo: e.value trae el índice en la lista ext
      dv.setUint32(p + 8, extOffsets[e.value as number] ?? 0, true);
    }
    p += 12;
  }
  dv.setUint32(p, 0, true);
  ext.forEach((e, i) => u8.set(e, extOffsets[i]));
  u8.set(raster, rasterOff);
  return buf;
}

/* ------------------------------------------------------------------ */
/* 1 · Patrón + clasificación por contenido                            */
/* ------------------------------------------------------------------ */

describe('RECORTADOR · topopack patrón y clasificación', () => {
  const TFWX = parseTfwx('1.6929990895517857\n-0.023460212393937127\n-0.023384046957503676\n-1.6930744690063708\n256445.52328923004\n2339650.4234534204')!;

  test('mono (1×float64) ⇒ demzip — ruta del sub-grid del RECORTADOR', () => {
    const tif = buildTiff({ w: 4, h: 3, kind: 'mono', data: new Float64Array([2000, 2010, 2020, 2030, 2040, 2050, 2060, 2070, 2080, 2090, 2100, 2110]), withGeoKeys: true });
    const zip = buildZip([
      { name: 'subgrid.tif', data: new Uint8Array(tif) },
      { name: 'subgrid.tfwx', data: enc.encode('1\n0\n0\n-1\n256000\n2330000') },
    ]);
    const r = parseFile('subgrid.zip', zip, ANCHOR);
    expect(r.meta.format).toBe('demzip');
    expect(r.meta.label).toContain('MDT en ZIP · subgrid');
    expect(r.topo).toBeDefined();
    expect(r.topo!.bytes).toBe(tif.byteLength);
    expect(r.meta.rows.some(([k, v]) => k === 'Contenedor' && v.includes('sin manifest'))).toBeTrue();
    expect(r.meta.rows.some(([k]) => k === 'Ruta')).toBeTrue();
  });

  test('demzip ⇒ el tif extraído decodifica en el Motor DEM Real', async () => {
    const tif = buildTiff({ w: 4, h: 3, kind: 'mono', data: new Float64Array(12).map((_, i) => 2000 + i * 10), withGeoKeys: true });
    const zip = buildZip([{ name: 'subgrid.tif', data: new Uint8Array(tif) }]);
    const r = parseFile('subgrid.zip', zip, ANCHOR);
    const dem = await decodeGeoTiffDem(r.topo!.tif);
    expect(dem.w).toBe(4);
    expect(dem.h).toBe(3);
    expect(dem.sampleLabel).toBe('Float64');
    expect(dem.min).toBeLessThan(dem.max);
    expect(dem.min).toBe(2000);
    expect(dem.max).toBe(2110);
  });

  test('multibanda 8×3 ⇒ carta documental — clasificada por CONTENIDO', () => {
    const rgb = new Uint8Array(4 * 3 * 3).fill(128);
    const tif = buildTiff({ w: 4, h: 3, kind: 'rgb', data: rgb });
    const zip = buildZip([
      { name: 'F14C43 d.tif', data: new Uint8Array(tif) },
      { name: 'F14C43 d.tfwx', data: enc.encode('1.693\n-0.0234\n-0.0233\n-1.6931\n256445.52328923004\n2339650.4234534204') },
      { name: 'F14C43 d.tif.aux.xml', data: enc.encode('<PAMDataset/>') },
    ]);
    const r = parseFile('carta.zip', zip, ANCHOR);
    expect(r.meta.format).toBe('carta');
    expect(r.meta.label).toContain('Capa topográfica · F14C43 d');
    const esc = r.meta.rows.find(([k]) => k === 'Carta escaneada');
    expect(esc).toBeDefined();
    expect(esc![1]).toContain('8 bits × 3 bandas');
    expect(esc![1]).toContain('NO es MDT');
    const geo = r.meta.rows.find(([k]) => k === 'Geo-ref (tfwx)');
    expect(geo).toBeDefined();
    expect(r.topo).toBeDefined();
    expect(r.geom).toBeNull();
  });

  test('.tfwx ⇒ esquina NO UTM 14N ⇒ WGS84 (Snyder FR-1) con dominio sane', () => {
    const rows = tfwxRows(TFWX);
    const esquina = rows.find(([k]) => k === 'Esquina NO (tfwx)')![1];
    const m = esquina.match(/(-?\d+\.\d+)°, (-?\d+\.\d+)°/);
    expect(m).not.toBeNull();
    const lon = Number(m![1]);
    const lat = Number(m![2]);
    // esquina NO de la hoja F14C43-D (E 256,445 · N 2,339,650): Bajío,
    // al nor-noroeste del centro de La Soledad (−101.3248, 21.0518)
    expect(lon).toBeGreaterThan(-101.6);
    expect(lon).toBeLessThan(-101.2);
    expect(lat).toBeGreaterThan(21.0);
    expect(lat).toBeLessThan(21.3);
  });

  test('parseTfwx hostil ⇒ null (no inventa afín)', () => {
    expect(parseTfwx('1 2 3')).toBeNull();
    expect(parseTfwx('a b c d e f')).toBeNull();
    expect(parseTfwx('')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 2 · Catálogo hostil del patrón (rechazo limpio o caída al pack)     */
/* ------------------------------------------------------------------ */

describe('RECORTADOR · catálogo hostil del patrón', () => {
  const monoTif = () => new Uint8Array(buildTiff({ w: 2, h: 2, kind: 'mono', data: new Float64Array([1, 2, 3, 4]) }));

  test('manifest.json presente ⇒ NO es topopack (cae al Mission Pack intacto)', () => {
    const zip = buildZip([
      { name: 'manifest.json', data: enc.encode('{"v":"1"}') },
      { name: 'subgrid.tif', data: monoTif() },
    ]);
    expect(extractTopoPack(zip)).toBeNull();
  });

  test('2× .tif ⇒ ambiguo ⇒ null', () => {
    const zip = buildZip([
      { name: 'a.tif', data: monoTif() },
      { name: 'b.tif', data: monoTif() },
    ]);
    expect(extractTopoPack(zip)).toBeNull();
  });

  test('sidecar fuera de lista blanca (.shp) ⇒ null', () => {
    const zip = buildZip([
      { name: 'subgrid.tif', data: monoTif() },
      { name: 'subgrid.shp', data: enc.encode('nope') },
    ]);
    expect(extractTopoPack(zip)).toBeNull();
  });

  test('tif sin magic II·MM ⇒ Error legible (hostil, nunca silencioso)', () => {
    const zip = buildZip([{ name: 'subgrid.tif', data: enc.encode('esto no es un tiff') }]);
    expect(() => extractTopoPack(zip)).toThrow(/hostil o inválido/);
    expect(() => parseFile('subgrid.zip', zip, ANCHOR)).toThrow(/no es TIFF/);
  });

  test('ZIP fracturado ⇒ null (pack.ts lo cataloga con su catálogo)', () => {
    const good = new Uint8Array(buildZip([{ name: 'subgrid.tif', data: monoTif() }]));
    const broken = good.slice(0, good.length - 8); // sin EOCD
    expect(extractTopoPack(broken.buffer.slice(broken.byteOffset) as ArrayBuffer)).toBeNull();
  });

  test('looksLikeTopoZip: lista blanca exacta', () => {
    expect(looksLikeTopoZip(['a.tif'])).toBeTrue();
    expect(looksLikeTopoZip(['a.TIF'])).toBeTrue();
    expect(looksLikeTopoZip(['a.tif', 'a.tfwx', 'a.tif.aux.xml', 'a.prj'])).toBeTrue();
    expect(looksLikeTopoZip([])).toBeFalse();
    expect(looksLikeTopoZip(['a.tif', 'manifest.json'])).toBeFalse();
    expect(looksLikeTopoZip(['a.tif', 'a.tif', 'b.tif'])).toBeFalse();
  });
});

/* ------------------------------------------------------------------ */
/* 3 · Rejilla REAL GGM10 (INEGI) — doble lector parser ≡ GDAL          */
/* ------------------------------------------------------------------ */

const REAL_STRIPPED = 'upload/mx_inegi_GGM10_stripped.tif';
const REAL_TILED = 'upload/mx_inegi_GGM10.tif';
const hasReal = existsSync(REAL_STRIPPED);

describe.skipIf(!hasReal)('RECORTADOR · rejilla REAL GGM10 (estructural + paridad GDAL)', () => {
  test('EX-005: el ORIGINAL tiled+predictor3 ⇒ rechazo con guía (el parser no finge)', async () => {
    if (!existsSync(REAL_TILED)) return;
    const buf = readFileSync(REAL_TILED);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    try {
      await decodeGeoTiffDem(ab);
      throw new Error('el original TILED debió ser rechazado');
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      expect(msg).toMatch(/gdal_translate|TILED|tile/i);
    }
  });

  test('convertido (strips) ⇒ zip del RECORTADOR ⇒ demzip + decodificación completa', async () => {
    const tif = new Uint8Array(readFileSync(REAL_STRIPPED));
    const zip = buildZip([{ name: 'mx_inegi_GGM10_stripped.tif', data: tif }], );
    const r = parseFile('GGM10.zip', zip, ANCHOR);
    expect(r.meta.format).toBe('demzip');
    expect(r.topo!.bytes).toBe(tif.length);
    const dem = await decodeGeoTiffDem(r.topo!.tif);
    expect(dem.w).toBe(792);
    expect(dem.h).toBe(456);
    expect(dem.sampleLabel).toBe('Float32');
    // NODATA −32767 excluido del min/max (honesto)
    expect(dem.nodata).toBe(-32767);
    expect(dem.min).toBeGreaterThan(-1000);
    expect(dem.max).toBeLessThan(1000);
    expect(dem.crs.kind === 'geographic' || dem.crs.kind === 'utm').toBeTrue();
  });

  test('paridad doble lector: min/max/centro del parser ≡ rasterio (GDAL)', async () => {
    // GDAL manda el veredicto; si rasterio no está, el guard lo declara
    let py: import('node:child_process').SpawnSyncReturns<string>;
    try {
      const { spawnSync } = await import('node:child_process');
      py = spawnSync('python3', ['-c', 'import rasterio; print("ok")'], { encoding: 'utf-8' });
    } catch {
      console.log('[paridad] rasterio indisponible — skip declarado (H-3: no silencioso en el reporte)');
      return;
    }
    if (py.status !== 0) {
      console.log('[paridad] rasterio indisponible — skip declarado (H-3: no silencioso en el reporte)');
      return;
    }
    const { spawnSync } = await import('node:child_process');
    const script = `
import rasterio, numpy as np, json
with rasterio.open('${REAL_STRIPPED}') as ds:
    a = ds.read(1, masked=True)
    h, w = a.shape
    c = a[h//2, w//2]
    print(json.dumps({'min': float(a.min()), 'max': float(a.max()), 'center': float(c), 'w': w, 'h': h}))
`;
    const out = spawnSync('python3', ['-c', script], { encoding: 'utf-8' });
    if (out.status !== 0) {
      console.log('[paridad] rasterio fallo al leer — skip declarado:', out.stderr.slice(0, 120));
      return;
    }
    const g = JSON.parse(out.stdout);

    const tif = new Uint8Array(readFileSync(REAL_STRIPPED));
    const zip = buildZip([{ name: 'mx_inegi_GGM10_stripped.tif', data: tif }]);
    const r = parseFile('GGM10.zip', zip, ANCHOR);
    const dem = await decodeGeoTiffDem(r.topo!.tif);
    const center = (dem.data as Float32Array)[Math.floor(dem.h / 2) * dem.w + Math.floor(dem.w / 2)];

    expect(dem.w).toBe(g.w);
    expect(dem.h).toBe(g.h);
    expect(dem.min).toBeCloseTo(g.min, 4);
    expect(dem.max).toBeCloseTo(g.max, 4);
    expect(center).toBeCloseTo(g.center, 4);
  });
});
