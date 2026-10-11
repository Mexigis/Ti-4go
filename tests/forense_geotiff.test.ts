/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — Decodificador GeoTIFF (EX-005 + límites declarados +
 * hardening Bundle A #6/#7). TIFF sintéticos con builder LE propio;
 * mensajes de rechazo accionables en español; no-regresión bit-exacta.
 */
import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { decodeGeoTiffDem, sampleDemElevation, type DecodedDem } from '../src/lib/ingest/geotiff-dem';

/* ------------------------------------------------------------------ */
/* Builder TIFF sintético (little-endian)                              */
/* ------------------------------------------------------------------ */

type Entry = { tag: number; type: number; count: number; value: number | number[] | bigint[] };

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, DOUBLE: 12 } as const;

function buildTiff(opts: {
  w: number;
  h: number;
  data: Float64Array; // fila 0 = norte
  compression?: number;
  scaleX?: number;
  scaleY?: number;
  tieX?: number;
  tieY?: number;
  withGeoKeys?: boolean;
  omitStrips?: boolean;
  stripByteCountOverride?: number;
  bigtiff?: boolean;
}): ArrayBuffer {
  const { w, h, data } = opts;
  const compression = opts.compression ?? 1;
  const pxBytes = 8;
  const raw = new Uint8Array(new Float64Array(data).buffer); // LE en plataforma LE
  const raster = compression === 8 ? new Uint8Array(deflateSync(raw)) : raw;
  const rasterByteLen = opts.stripByteCountOverride ?? raster.length;

  // ── zona de datos externos (valores que no caben en 4 bytes) ──
  const ext: { bytes: Uint8Array }[] = [];
  const pushExt = (u8: Uint8Array): number => {
    ext.push({ bytes: u8 });
    return ext.length - 1; // índice real; el offset absoluto se resuelve al ensamblar
  };

  const scaleD = new Float64Array([opts.scaleX ?? 0.001, opts.scaleY ?? 0.001, 0]);
  const tieD = new Float64Array([0, 0, 0, opts.tieX ?? -101.4, opts.tieY ?? 21.0, 0]);
  const geoKeys = opts.withGeoKeys
    ? new Uint16Array([1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 4326]) // GTModel=2 geográfico, EPSG:4326
    : null;

  const entries: Entry[] = [
    { tag: 256, type: T.LONG, count: 1, value: w },
    { tag: 257, type: T.LONG, count: 1, value: h },
    { tag: 258, type: T.SHORT, count: 1, value: 64 },
    { tag: 259, type: T.SHORT, count: 1, value: compression },
  ];
  entries.push({ tag: 277, type: T.SHORT, count: 1, value: 1 }); // SamplesPerPixel siempre
  if (!opts.omitStrips) {
    entries.push({ tag: 273, type: T.LONG, count: 1, value: 0 }); // StripOffsets — parcheado
    entries.push({ tag: 278, type: T.LONG, count: 1, value: h }); // RowsPerStrip = h
    entries.push({ tag: 279, type: T.LONG, count: 1, value: rasterByteLen });
  }
  entries.push({ tag: 284, type: T.SHORT, count: 1, value: 1 }); // PlanarConfig
  entries.push({ tag: 339, type: T.SHORT, count: 1, value: 3 }); // SampleFormat float
  entries.push({ tag: 33550, type: T.DOUBLE, count: 3, value: pushExt(new Uint8Array(scaleD.buffer)) });
  entries.push({ tag: 33922, type: T.DOUBLE, count: 6, value: pushExt(new Uint8Array(tieD.buffer)) });
  if (geoKeys) entries.push({ tag: 34735, type: T.SHORT, count: geoKeys.length, value: pushExt(new Uint8Array(geoKeys.buffer)) });
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOff = 8;
  const ifdLen = 2 + entries.length * 12 + 4;
  const extOff0 = ifdOff + ifdLen;
  // resolver offsets externos
  let cur = extOff0;
  const extOffsets: number[] = [];
  for (const e of ext) {
    extOffsets.push(cur);
    cur += e.bytes.length;
  }
  const rasterOff = cur;

  const size = rasterOff + raster.length;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // header
  u8[0] = 0x49; u8[1] = 0x49; // 'II'
  dv.setUint16(2, opts.bigtiff ? 43 : 42, true);
  dv.setUint32(4, ifdOff, true);
  // IFD
  dv.setUint16(ifdOff, entries.length, true);
  let p = ifdOff + 2;
  const idx273 = entries.findIndex((e) => e.tag === 273);
  if (idx273 >= 0) entries[idx273].value = rasterOff;
  for (const e of entries) {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    const TS: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
    const inlineBytes = e.count * (TS[e.type] ?? 1);
    if (inlineBytes <= 4 && typeof e.value === 'number') {
      if (e.type === T.SHORT) dv.setUint16(p + 8, e.value, true);
      else dv.setUint32(p + 8, e.value, true);
    } else {
      // dato externo: e.value es el índice en la lista ext
      dv.setUint32(p + 8, extOffsets[e.value as number] ?? 0, true);
    }
    p += 12;
  }
  dv.setUint32(p, 0, true); // next IFD = 0
  // datos externos
  ext.forEach((e, i) => u8.set(e.bytes, extOffsets[i]));
  // raster
  u8.set(raster, rasterOff);
  return buf;
}

function grad(w: number, h: number, base = 2000, step = 7): Float64Array {
  const d = new Float64Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = base + i * step;
  return d;
}

const GDAL = 'gdal_translate -co TILED=NO -co COMPRESS=DEFLATE';

/* ------------------------------------------------------------------ */
/* Rechazos con guía accionable (EX-005) y hardening #6/#7             */
/* ------------------------------------------------------------------ */

describe('GeoTIFF — rechazos con guía accionable (EX-005)', () => {
  test('JPEG (7) ⇒ mensaje con COG + comando de conversión, sin texto genérico viejo', async () => {
    const buf = buildTiff({ w: 4, h: 4, data: grad(4, 4), compression: 7 });
    try {
      await decodeGeoTiffDem(buf.slice(0));
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('COG');
      expect(msg).toContain('TILED=NO');
      expect(msg).toContain(GDAL);
      expect(msg).not.toContain('→ F5');
    }
  });
  test('tiled/COG (sin strips) ⇒ mensaje con comando de conversión', async () => {
    const buf = buildTiff({ w: 4, h: 4, data: grad(4, 4), omitStrips: true });
    try {
      await decodeGeoTiffDem(buf.slice(0));
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('tiled');
      expect(msg).toContain('TILED=NO');
      expect(msg).not.toContain('→ F5');
    }
  });
});

describe('GeoTIFF — hardening Bundle A', () => {
  test('#6 buffer < 8 bytes ⇒ rechazo limpio en español (no RangeError crudo)', async () => {
    for (const n of [0, 1, 2, 4, 7]) {
      const buf = new ArrayBuffer(n);
      try {
        await decodeGeoTiffDem(buf);
        expect.unreachable();
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('truncado');
        expect(msg).toContain('mínimo 8 bytes');
        expect(msg).not.toContain('DataView');
        expect(msg).not.toContain('bounds');
      }
    }
  });
  test('#7 atajo sin comprimir con strip que NO cubre w×h ⇒ rechazo', async () => {
    const buf = buildTiff({ w: 8, h: 8, data: grad(8, 8), stripByteCountOverride: 8 * 8 * 4 });
    try {
      await decodeGeoTiffDem(buf.slice(0));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('incompleto');
    }
  });
});

describe('GeoTIFF — límites declarados', () => {
  test('BigTIFF (magic 43) ⇒ rechazo explícito', async () => {
    const buf = buildTiff({ w: 4, h: 4, data: grad(4, 4), bigtiff: true });
    try {
      await decodeGeoTiffDem(buf.slice(0));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('BigTIFF');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Camino feliz — no-regresión bit-exacta + georreferenciación          */
/* ------------------------------------------------------------------ */

describe('GeoTIFF — camino feliz (no-regresión, bit-exacto)', () => {
  test('8×8 Float64 sin comprimir con GeoKeys 4326 decodifica íntegro', async () => {
    const W = 8, H = 8;
    const buf = buildTiff({ w: W, h: H, data: grad(W, H), withGeoKeys: true });
    const dem: DecodedDem = await decodeGeoTiffDem(buf.slice(0));
    expect(dem.w).toBe(W);
    expect(dem.h).toBe(H);
    expect(dem.data.length).toBe(W * H);
    for (let i = 0; i < W * H; i++) expect(dem.data[i] as number).toBe(2000 + i * 7);
    expect(dem.scaleX).toBeCloseTo(0.001);
    expect(dem.scaleY).toBeCloseTo(0.001);
    expect(dem.crs.kind).toBe('geographic');
  });
  test('muestreo bilineal EXACTO en el centro (pin forense de interpolación)', async () => {
    const W = 8, H = 8;
    const buf = buildTiff({ w: W, h: H, data: grad(W, H), withGeoKeys: true, tieX: -101.4, tieY: 21.0 });
    const dem = await decodeGeoTiffDem(buf.slice(0));
    // centro entre filas/cols 3-4: v00=2189 v10=2196 v01=2245 v11=2252 ⇒ media 2220.5
    const lon = -101.4 + 4 * 0.001;
    const lat = 21.0 - 4 * 0.001;
    expect(sampleDemElevation(dem, lon, lat)).toBeCloseTo(2220.5, 6);
  });
  test('fuera del raster ⇒ NaN (no inventa cotas; firma number)', async () => {
    const buf = buildTiff({ w: 8, h: 8, data: grad(8, 8), withGeoKeys: true, tieX: -101.4, tieY: 21.0 });
    const dem = await decodeGeoTiffDem(buf.slice(0));
    const far = sampleDemElevation(dem, -50, 50);
    expect(typeof far).toBe('number');
    expect(far).toBeNaN();
  });
  test('sin GeoKeys ⇒ CRS no geográfico ⇒ NaN en sampler (comportamiento documentado)', async () => {
    const buf = buildTiff({ w: 4, h: 4, data: grad(4, 4) });
    const dem = await decodeGeoTiffDem(buf.slice(0));
    expect(dem.crs.kind).not.toBe('geographic');
    expect(sampleDemElevation(dem, -101.4 + 0.002, 21.0 - 0.002)).toBeNaN();
  });
});
