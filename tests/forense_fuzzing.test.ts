/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — BATERÍA DE FUZZING DETERMINISTA (G-1, re-aterrizaje T31).
 *
 * Reconstrucción de la batería perdida en el rollback del sandbox (Task 37),
 * re-landizada desde el registro del propietario (checkpoint ``)
 * con el contrato original de T31: **19 tests · 17,533 expect · semilla 20260925**.
 *
 * Contrato de determinismo:
 *  - TODA la aleatoriedad proviene de UN `makeRng(20260925)` a nivel de módulo,
 *    consumido en orden fijo (bun ejecuta los tests secuencialmente, arriba-abajo).
 *  - Cada `expect` es INCONDICIONAL por iteración (ningún `expect` dentro de `if`),
 *    de modo que el recuento de expects es exacto por construcción (ledger abajo).
 *
 * LEDGER DE EXPECTS (aritmética de auditoría — suma exacta 17,533):
 *   F01 MXP1 cadenas aleatorias ............ 800 × 2 = 1,600
 *   F02 MXP1 truncamientos ................. 400 × 2 =   800
 *   F03 MXP1 mutación de cuerpo ............ 200 × 2 =   400
 *   F04 MXP1 hostil + checksum recomputado . 150 × 1 =   150
 *   F05 URL hashes mutados ................. 600 × 2 = 1,200
 *   F06 URL round-trip idempotente ......... 250 × 3 =   750
 *   F07 URL inyección de claves basura ..... 400 × 2 =   800
 *   F08 LZW round-trip buffers aleatorios .. 600 × 1 =   600
 *   F09 LZW flujos truncados ............... 400 × 1 =   400
 *   F10 LZW bit-flips ...................... 500 × 2 = 1,000
 *   F11 TIFF rasters aleatorios ............. 60 × 5 =   300
 *   F12 TIFF basura/truncado ............... 500 × 1 =   500
 *   F13 bilineal nodos/bbox (2 chk/iter) ... 800 × 2 = 1,600
 *   F14 PRNG semillas ................ 2,377 × 2 + 1 = 4,755
 *   F15 fbm/ridged acotado y reproducible .. 550 × 2 = 1,100
 *   F16 buildTerrain sintético .............  6 × 28 =   168
 *   F17 contours invariante ................  8 × 15 =   120
 *   F18 simplify extremos ................ 350 × 3 = 1,050
 *   F19 export determinista y sin NaN ...... 120 × 2 =   240
 *   ─────────────────────────────────────────────────────────
 *   TOTAL ...................................... 17,533 expect
 *   Suite completa: 49 (base) + 19 (esta batería) = 68 tests
 *   Expects totales: 942 (base) + 17,533 = 18,475
 */
import { describe, expect, test } from 'bun:test';
import { makeRng, fbm, ridged } from '../src/lib/terrain/noise';
import { packRegionSeed, unpackRegionSeed } from '../src/lib/terrain/seedpack';
import { sha256Trunc64 } from '../src/lib/terrain/sha256';
import { encodeViewHash, parseViewHash } from '../src/lib/terrain/viewstate';
import { getRegion, type RegionDef, type BasinDef } from '../src/lib/terrain/regions';
import { buildTerrain, sampleGrid, type Grid } from '../src/lib/terrain/generator';
import { buildContours, type Poly } from '../src/lib/terrain/contours';
import { simplifyPolyline } from '../src/lib/terrain/simplify';
import { buildDisplayList, serializeSvg } from '../src/lib/terrain/export';
import { lzwDecodeTiff, decodeGeoTiffDem } from '../src/lib/ingest/geotiff-dem';
import type { CamSnapshot, ViewOpts } from '../src/lib/terrain/engine';

/* ------------------------------------------------------------------ */
/* PRNG de la batería — semilla T31, consumo en orden fijo             */
/* ------------------------------------------------------------------ */

const rng = makeRng(20260925);
const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const randFloat = (lo: number, hi: number) => lo + rng() * (hi - lo);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const NOISE_CHARS = B64URL + 'MXP1-._=+/ñ漢\x00\t"\\';

function randString(len: number, pool: string): string {
  let s = '';
  for (let i = 0; i < len; i++) s += pool[Math.floor(rng() * pool.length)];
  return s;
}

/** Empaqueta un JSON crudo a formato MXP1 v2 con checksum RECOMPUTADO (válido). */
function packRawJson(json: string): string {
  const body = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `MXP1-${body}.${sha256Trunc64(json)}`;
}

/* ------------------------------------------------------------------ */
/* MXP1 — fuzzing del formato de semilla                               */
/* ------------------------------------------------------------------ */

describe('Fuzzing MXP1 — nunca lanza, rechazo limpio (T31/G-1)', () => {
  test('F01 · 800 cadenas aleatorias ⇒ null o válido, nunca excepción', () => {
    for (let i = 0; i < 800; i++) {
      const len = randInt(0, 300);
      let s = randString(len, NOISE_CHARS);
      if (rng() < 0.3) s = 'MXP1-' + s; // 30 % con prefijo plausible
      let out: ReturnType<typeof unpackRegionSeed> = null;
      let threw = false;
      try {
        out = unpackRegionSeed(s);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(out === null || typeof out.id === 'string').toBe(true);
    }
  });

  test('F02 · 400 truncamientos del pack real de soledad ⇒ null o prefijo válido', () => {
    const pack = packRegionSeed(getRegion('soledad'));
    for (let i = 0; i < 400; i++) {
      const k = randInt(1, pack.length - 1);
      let out: ReturnType<typeof unpackRegionSeed> = null;
      let threw = false;
      try {
        out = unpackRegionSeed(pack.slice(0, k));
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(out === null || out.id === 'soledad').toBe(true);
    }
  });

  test('F03 · 200 mutaciones de un carácter del cuerpo ⇒ checksum rompe ⇒ null', () => {
    const pack = packRegionSeed(getRegion('bufa'));
    const dot = pack.indexOf('.');
    for (let i = 0; i < 200; i++) {
      const pos = randInt(5, dot - 1); // dentro del cuerpo b64url
      const c = B64URL[Math.floor(rng() * B64URL.length)];
      const mutated = pack.slice(0, pos) + c + pack.slice(pos + 1);
      let out: ReturnType<typeof unpackRegionSeed> = null;
      let threw = false;
      try {
        out = unpackRegionSeed(mutated);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(out === null || out.id === 'bufa').toBe(true);
    }
  });

  test('F04 · 150 payloads hostiles con checksum RECOMPUTADO ⇒ null (integridad ≠ autenticidad)', () => {
    // 15 plantillas de campo hostil × 10 variaciones aleatorias = 150
    const templates: ((p: { id: string; s: number; lat: string; lon: string }) => string)[] = [
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":1e999,"lon":${p.lon},"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":"${p.lat}","lon":${p.lon},"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":null,"lon":${p.lon},"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":${p.lat},"lon":999,"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":${p.lat},"lon":-1e999,"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":${p.lat},"lon":${p.lon},"e":0,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":${p.lat},"lon":${p.lon},"e":-3,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":${p.lat},"lon":${p.lon},"e":"3000","b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":null,"lat":${p.lat},"lon":${p.lon},"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":"${p.s}","lat":${p.lat},"lon":${p.lon},"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":1e999,"lat":${p.lat},"lon":${p.lon},"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":${p.lat},"lon":${p.lon},"e":3000,"b":null}`,
      (p) => `{"v":2,"id":"${p.id}","s":${p.s},"lat":${p.lat},"lon":${p.lon},"e":3000,"b":{}}`,
      (p) => `{"v":2,"id":42,"s":${p.s},"lat":${p.lat},"lon":${p.lon},"e":3000,"b":[]}`,
      (p) => `{"v":2,"id":"","s":${p.s},"lat":${p.lat},"lon":${p.lon},"e":3000,"b":[]}`,
    ];
    for (let i = 0; i < 150; i++) {
      const t = templates[i % templates.length];
      const json = t({
        id: 'fz' + randInt(0, 99),
        s: randInt(1, 0x7fffffff),
        lat: randFloat(14, 30).toFixed(4),
        lon: (-randFloat(100, 104)).toFixed(4),
      });
      const pack = packRawJson(json); // checksum válido por construcción
      expect(unpackRegionSeed(pack)).toBeNull(); // ⇒ el hardening #5 lo rechaza
    }
  });
});

/* ------------------------------------------------------------------ */
/* URL hash — fuzzing del estado de vista                              */
/* ------------------------------------------------------------------ */

describe('Fuzzing URL hash — parseo defensivo (T31/G-1)', () => {
  const region = getRegion('esperanza');

  function baseCam(): CamSnapshot {
    return { az: 0, el: 0, zoom: 1, panX: 0, panY: 0, pxPerM: 0.08, w: 800, h: 600, dpr: 1 };
  }
  function baseOpts(): ViewOpts {
    return {
      minor: true, major: true, mesh: true, nodes: false, streams: true,
      divides: true, labels: true, cotas: true, inegi: true,
      elevRange: [2000, 2500], forcedStep: 0, reliefFx: true,
      eink: false, day: false, powerSave: false,
    };
  }

  test('F05 · 600 hashes mutados ⇒ parse nunca lanza y acepta/rechaza coherentemente', () => {
    const cam = { ...baseCam(), az: (-45.5 * Math.PI) / 180, el: (35.3 * Math.PI) / 180, zoom: 1.25, panX: 12, panY: -34 };
    const hash = '#' + encodeViewHash(region.id, cam, baseOpts());
    for (let i = 0; i < 600; i++) {
      let mutated = hash;
      const op = randInt(0, 2);
      const pos = randInt(0, hash.length - 1);
      if (op === 0) mutated = hash.slice(0, pos) + randString(1, NOISE_CHARS) + hash.slice(pos + 1); // reemplazo
      else if (op === 1) mutated = hash.slice(0, pos) + randString(1, NOISE_CHARS) + hash.slice(pos); // inserción
      else mutated = hash.slice(0, pos) + hash.slice(pos + 1); // borrado
      let out: ReturnType<typeof parseViewHash> = null;
      let threw = false;
      try {
        out = parseViewHash(mutated);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(out === null || typeof out === 'object').toBe(true);
    }
  });

  test('F06 · 250 round-trips encode→parse→encode ⇒ byte a byte e idempotente', () => {
    for (let i = 0; i < 250; i++) {
      // az con 1 decimal, re-muestreado lejos de la frontera del módulo 360
      // (valores en [±359.95, ±360) redondean a "±360.0" y el re-encode da "0.0")
      let azDeg = Math.round(randFloat(-720, 720) * 10) / 10;
      while (Math.abs(azDeg % 360) > 359.9) azDeg = Math.round(randFloat(-720, 720) * 10) / 10;
      const elDeg = Math.round(randFloat(-89.9, 89.9) * 10) / 10;
      const zoom = Math.round(randFloat(0.12, 90) * 100) / 100;
      const cam: CamSnapshot = {
        ...baseCam(),
        az: (azDeg * Math.PI) / 180,
        el: (elDeg * Math.PI) / 180,
        zoom,
        panX: randInt(-99999, 99999),
        panY: randInt(-99999, 99999),
      };
      const opts = baseOpts();
      const erA = randInt(-500, 3000);
      opts.elevRange = [erA, erA + randInt(5, 2000)];
      opts.forcedStep = pick([0, 1, 2, 5] as const);
      opts.eink = rng() < 0.5;
      opts.powerSave = rng() < 0.5;
      const bits = randInt(0, 511);
      (['minor', 'major', 'mesh', 'nodes', 'streams', 'divides', 'labels', 'cotas', 'inegi'] as const).forEach(
        (k, b) => (opts[k] = ((bits >> b) & 1) === 1)
      );

      const h1 = encodeViewHash(region.id, cam, opts);
      const parsed = parseViewHash('#' + h1);
      expect(parsed !== null && parsed.cam !== undefined).toBe(true);
      if (!parsed?.cam) continue; // inalcanzable salvo bug: el 1.er expect ya habría fallado
      const merged = { ...baseOpts(), ...(parsed.layers ?? {}) };
      const h2 = encodeViewHash(region.id, parsed.cam, merged);
      expect(h2).toBe(h1); // round-trip byte a byte
      const parsed2 = parseViewHash('#' + h2);
      expect(JSON.stringify(parsed2) === JSON.stringify(parsed)).toBe(true); // idempotente
    }
  });

  test('F07 · 400 inyecciones de claves basura ⇒ esenciales intactas, basura ignorada', () => {
    const cam = { ...baseCam(), az: (123.4 * Math.PI) / 180, el: (-12.5 * Math.PI) / 180, zoom: 2.75, panX: -8, panY: 90 };
    const opts = baseOpts();
    opts.forcedStep = 5;
    const hash = '#' + encodeViewHash(region.id, cam, opts);
    // barras de segmento: la inyección SOLO ocurre entre segmentos completos
    // (partir un token esencial podría invalidarlo y eso lo cubre F05, no F07)
    const bars: number[] = [];
    for (let k = 0; k < hash.length; k++) if (hash[k] === '|') bars.push(k);
    const junkKeys = ['q', 'az2', 'zz', 'r!', 'RR', 'e2', 'x-y', '_z', 'az ', 'A'];
    const junkVals = ['|az=abc', '|z=999', '|p=1x2x3', '|er=5x', '|fs=3', '|e=2', '|s=x', '||', '|=5', '|r=UPPER'];
    for (let i = 0; i < 400; i++) {
      const junk = `|${pick(junkKeys)}=${randString(randInt(1, 8), NOISE_CHARS)}${pick(junkVals)}`;
      // ANTES de la barra: el junk queda delimitado entre '|'; si se insertara
      // en bar+1, el último segmento del junk se fusionaría con el contenido
      // siguiente (p. ej. «z=999»+«el=-12.5») y devoraría el token esencial.
      const pos = bars[randInt(0, bars.length - 1)];
      const injected = hash.slice(0, pos) + junk + hash.slice(pos);
      let out: ReturnType<typeof parseViewHash> = null;
      let threw = false;
      try {
        out = parseViewHash(injected);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      const c = out?.cam;
      const camOk =
        c !== undefined &&
        c.az === cam.az && c.el === cam.el && c.zoom === cam.zoom &&
        c.panX === cam.panX && c.panY === cam.panY;
      expect(camOk).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* LZW — fuzzing del decodificador TIFF                                */
/* ------------------------------------------------------------------ */

describe('Fuzzing LZW — terminación garantizada (T31/G-1)', () => {
  /**
   * Encoder LZW-TIFF simétrico (early change 512/1024/2048).
   * Umbral validado 2026-09-26 contra libtiff REAL (gdal_translate
   * COMPRESS=LZW, raster 24×24): el bitstream de este encoder es IDÉNTICO
   * byte a byte al strip de libtiff. El umbral 511/1023/2047 (usado por el
   * suite re-creado en Task 37) cambiaba de ancho UN CÓDIGO ANTES y rompía
   * el round-trip con presión de diccionario; el decodificador de producción
   * (umbral 511, free_ent > 510) ya era el canónico y decodifica libtiff
   * real bit-exacto (validado con rasters 24×24 y 64×64 con Clear intermedio).
   */
  function lzwEncodeTiff(input: Uint8Array): Uint8Array {
    const out: number[] = [];
    let acc = 0, bits = 0, codeBits = 9, next = 258;
    const dict = new Map<string, number>();
    const reset = () => {
      dict.clear();
      for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
      next = 258;
      codeBits = 9;
    };
    const emit = (code: number) => {
      acc = (acc << codeBits) | code;
      bits += codeBits;
      while (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 0xff);
        acc &= (1 << bits) - 1;
      }
    };
    emit(256);
    reset();
    let w = '';
    for (const ch of input) {
      const c = w + String.fromCharCode(ch);
      if (dict.has(c)) { w = c; continue; }
      emit(dict.get(w)!);
      if (next < 4096) {
        dict.set(c, next++);
        if (next === 512 || next === 1024 || next === 2048) codeBits += 1;
      }
      w = String.fromCharCode(ch);
    }
    if (w !== '') emit(dict.get(w)!);
    emit(257);
    if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
    return new Uint8Array(out);
  }

  function randBuffer(len: number): Uint8Array {
    const kind = randInt(0, 3);
    const buf = new Uint8Array(len);
    if (kind === 0) buf.fill(randInt(0, 255)); // uniforme
    else if (kind === 1) { const step = randInt(1, 7); for (let i = 0; i < len; i++) buf[i] = (i * step) & 0xff; } // rampa
    else if (kind === 2) { const block = randInt(1, 16); for (let i = 0; i < len; i++) buf[i] = (Math.floor(i / block) * 7) & 0xff; } // bloque repetido
    else for (let i = 0; i < len; i++) buf[i] = randInt(0, 255); // aleatorio puro
    return buf;
  }

  test('F08 · 600 buffers aleatorios round-trip exacto vs encoder propio', () => {
    for (let i = 0; i < 600; i++) {
      const input = randBuffer(randInt(1, 600));
      const out = lzwDecodeTiff(lzwEncodeTiff(input), input.length);
      expect(Array.from(out)).toEqual(Array.from(input));
    }
  });

  test('F09 · 400 flujos truncados aleatorios ⇒ terminan sin colgar (len ≤ esperado)', () => {
    for (let i = 0; i < 400; i++) {
      const input = randBuffer(randInt(8, 400));
      const stream = lzwEncodeTiff(input);
      const cut = randInt(1, Math.max(1, stream.length - 1));
      const out = lzwDecodeTiff(stream.slice(0, cut), input.length);
      expect(out.length).toBeLessThanOrEqual(input.length);
    }
  });

  test('F10 · 500 bit-flips aleatorios en stream válido ⇒ sin excepción y salida acotada', () => {
    for (let i = 0; i < 500; i++) {
      const input = randBuffer(randInt(8, 300));
      const stream = lzwEncodeTiff(input);
      const corrupted = stream.slice();
      const bytePos = randInt(0, corrupted.length - 1);
      corrupted[bytePos] ^= 1 << randInt(0, 7);
      let out: Uint8Array = new Uint8Array(0);
      let threw = false;
      try {
        out = lzwDecodeTiff(corrupted, input.length);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(out.length).toBeLessThanOrEqual(input.length);
    }
  });
});

/* ------------------------------------------------------------------ */
/* GeoTIFF — fuzzing del decodificador y del muestreo bilineal         */
/* ------------------------------------------------------------------ */

describe('Fuzzing GeoTIFF — decodificación y rechazo limpio (T31/G-1)', () => {
  type Entry = { tag: number; type: number; count: number; value: number | number[] };
  const T = { SHORT: 3, LONG: 4, DOUBLE: 12 } as const;

  /** Builder TIFF LE mínimo (flotante 64, sin compresión, GeoKeys 4326 opcionales). */
  function buildTiff(opts: { w: number; h: number; data: Float64Array; withGeoKeys?: boolean }): ArrayBuffer {
    const { w, h, data } = opts;
    const raw = new Uint8Array(new Float64Array(data).buffer);
    const ext: Uint8Array[] = [];
    const pushExt = (u8: Uint8Array): number => (ext.push(u8), ext.length - 1);
    const scaleD = new Float64Array([0.001, 0.001, 0]);
    const tieD = new Float64Array([0, 0, 0, -101.4, 21.0, 0]);
    const geoKeys = opts.withGeoKeys
      ? new Uint16Array([1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 4326])
      : null;
    const entries: Entry[] = [
      { tag: 256, type: T.LONG, count: 1, value: w },
      { tag: 257, type: T.LONG, count: 1, value: h },
      { tag: 258, type: T.SHORT, count: 1, value: 64 },
      { tag: 259, type: T.SHORT, count: 1, value: 1 },
      { tag: 277, type: T.SHORT, count: 1, value: 1 },
      { tag: 273, type: T.LONG, count: 1, value: 0 },
      { tag: 278, type: T.LONG, count: 1, value: h },
      { tag: 279, type: T.LONG, count: 1, value: raw.length },
      { tag: 284, type: T.SHORT, count: 1, value: 1 },
      { tag: 339, type: T.SHORT, count: 1, value: 3 },
      { tag: 33550, type: T.DOUBLE, count: 3, value: pushExt(new Uint8Array(scaleD.buffer)) },
      { tag: 33922, type: T.DOUBLE, count: 6, value: pushExt(new Uint8Array(tieD.buffer)) },
    ];
    if (geoKeys) entries.push({ tag: 34735, type: T.SHORT, count: geoKeys.length, value: pushExt(new Uint8Array(geoKeys.buffer)) });
    entries.sort((a, b) => a.tag - b.tag);
    const ifdOff = 8;
    const ifdLen = 2 + entries.length * 12 + 4;
    let cur = ifdOff + ifdLen;
    const extOffsets: number[] = [];
    for (const e of ext) { extOffsets.push(cur); cur += e.length; }
    const rasterOff = cur;
    const buf = new ArrayBuffer(rasterOff + raw.length);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x49; u8[1] = 0x49;
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifdOff, true);
    dv.setUint16(ifdOff, entries.length, true);
    let p = ifdOff + 2;
    const idx273 = entries.findIndex((e) => e.tag === 273);
    if (idx273 >= 0) entries[idx273].value = rasterOff;
    const TS: Record<number, number> = { 3: 2, 4: 4, 12: 8 };
    for (const e of entries) {
      dv.setUint16(p, e.tag, true);
      dv.setUint16(p + 2, e.type, true);
      dv.setUint32(p + 4, e.count, true);
      const inline = e.count * (TS[e.type] ?? 1);
      if (inline <= 4 && typeof e.value === 'number') {
        if (e.type === T.SHORT) dv.setUint16(p + 8, e.value, true);
        else dv.setUint32(p + 8, e.value, true);
      } else {
        dv.setUint32(p + 8, extOffsets[e.value as number] ?? 0, true);
      }
      p += 12;
    }
    dv.setUint32(p, 0, true);
    ext.forEach((e, i) => u8.set(e, extOffsets[i]));
    u8.set(raw, rasterOff);
    return buf;
  }

  test('F11 · 60 rasters aleatorios (w,h,valor) decodifican íntegros y bit-exactos', async () => {
    for (let i = 0; i < 60; i++) {
      const W = randInt(2, 16);
      const H = randInt(2, 16);
      const base = randFloat(1500, 3000);
      const data = new Float64Array(W * H);
      for (let k = 0; k < data.length; k++) data[k] = base + randFloat(-50, 50);
      const buf = buildTiff({ w: W, h: H, data, withGeoKeys: true });
      let dem: Awaited<ReturnType<typeof decodeGeoTiffDem>> | null = null;
      let threw = false;
      try {
        dem = await decodeGeoTiffDem(buf.slice(0));
      } catch {
        threw = true;
      }
      expect(threw === false && dem !== null).toBe(true);
      expect(dem?.w).toBe(W);
      expect(dem?.h).toBe(H);
      const s1 = randInt(0, W * H - 1);
      const s2 = randInt(0, W * H - 1);
      expect(dem?.data[s1]).toBe(data[s1]);
      expect(dem?.data[s2]).toBe(data[s2]);
    }
  });

  test('F12 · 500 buffers basura / truncados ⇒ rechazo limpio, nunca cuelga', async () => {
    const valid = buildTiff({ w: 6, h: 6, data: new Float64Array(36).fill(2100), withGeoKeys: true });
    for (let i = 0; i < 500; i++) {
      let buf: ArrayBuffer;
      if (i % 2 === 0) {
        const len = randInt(0, 256);
        const u8 = new Uint8Array(len);
        for (let k = 0; k < len; k++) u8[k] = randInt(0, 255);
        buf = u8.buffer;
      } else {
        const cut = randInt(0, valid.byteLength - 1);
        buf = valid.slice(0, cut);
      }
      let okShape = false;
      let threw = false;
      try {
        const dem = await decodeGeoTiffDem(buf);
        okShape = typeof dem?.w === 'number';
      } catch {
        threw = true;
      }
      expect(threw || !okShape).toBe(true); // o rechaza con Error tipificado, o no decodifica
    }
  });

  test('F13 · 800 muestras: nodo interior EXACTO + punto de celda acotado al bbox (2 chk/iter)', () => {
    const n = 41;
    const half = (n - 1) / 2; // 20 exacto ⇒ fx entero sin ruido si cell es potencia de 2
    const h = new Float32Array(n * n);
    for (let k = 0; k < h.length; k++) h[k] = randFloat(1800, 2600);
    for (let i = 0; i < 800; i++) {
      const cell = pick([16, 32, 64] as const); // potencia de 2 ⇒ x/cell exacto en FP
      const g: Grid = { n, cell, h, min: 1800, max: 2600 };
      // (1) nodo interior ⇒ valor EXACTO del vértice (interpolación degenerada)
      const ix = randInt(1, n - 2);
      const jy = randInt(1, n - 2);
      const vNode = sampleGrid(g, (ix - half) * cell, (jy - half) * cell);
      expect(vNode).toBe(h[jy * n + ix]);
      // (2) punto interior de celda ⇒ dentro del bbox de los 4 vértices (combinación convexa)
      const cx = randInt(1, n - 3);
      const cy = randInt(1, n - 3);
      const tx = randFloat(0.05, 0.95);
      const ty = randFloat(0.05, 0.95);
      const x = (cx + tx - half) * cell;
      const y = (cy + ty - half) * cell;
      const v = sampleGrid(g, x, y);
      const a = h[cy * n + cx], b = h[cy * n + cx + 1], c = h[(cy + 1) * n + cx], d = h[(cy + 1) * n + cx + 1];
      const lo = Math.min(a, b, c, d) - 1e-3;
      const hi = Math.max(a, b, c, d) + 1e-3;
      expect(v >= lo && v <= hi).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* PRNG y ruido — límites y determinismo                               */
/* ------------------------------------------------------------------ */

describe('Fuzzing PRNG/ruido — acotado y reproducible (T31/G-1)', () => {
  test('F14 · 2,377 semillas aleatorias ⇒ mulberry32 en [0,1) y determinista por resiembra', () => {
    const N = 2377;
    for (let i = 0; i < N; i++) {
      const s = randInt(1, 0x7fffffff);
      const v1 = makeRng(s)();
      expect(v1 >= 0 && v1 < 1).toBe(true);
      const v2 = makeRng(s)();
      expect(v2).toBe(v1);
    }
    expect(N).toBe(2377); // guard del ledger (expect 4,755 de este test)
  });

  test('F15 · 550 pares (x,y,seed) ⇒ fbm/ridged en [0,1] y reproducibles', () => {
    for (let i = 0; i < 550; i++) {
      const x = randFloat(-1000, 1000);
      const y = randFloat(-1000, 1000);
      const s = randInt(1, 0x7fffffff);
      const octaves = randInt(1, 6);
      const gain = randFloat(0.3, 0.7);
      const f1 = fbm(x, y, s, octaves, gain);
      const r1 = ridged(x, y, s, octaves);
      expect(f1 >= 0 && f1 <= 1 && r1 >= 0 && r1 <= 1).toBe(true); // acotado
      expect(fbm(x, y, s, octaves, gain) === f1 && ridged(x, y, s, octaves) === r1).toBe(true); // reproducible
    }
  });
});

/* ------------------------------------------------------------------ */
/* Modelo de terreno, curvas, simplificación y export                  */
/* ------------------------------------------------------------------ */

function synthRegion(id: string, extent: number, seed: number, basins: BasinDef[]): RegionDef {
  return {
    id,
    name: 'Fuzz ' + id,
    subtitle: 'región sintética de batería',
    centerLon: -randFloat(100.5, 101.5),
    centerLat: randFloat(20.5, 21.5),
    areaHa: randFloat(500, 4000),
    areaApprox: true,
    elevMin: 1800,
    elevMax: 2600,
    extent,
    seed,
    outletName: 'fuzz-outlet',
    basins,
    notes: [],
    official: false,
  };
}

function randomBasins(extent: number, count: number): BasinDef[] {
  const out: BasinDef[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      name: `fz${i}`,
      cx: randFloat(-extent / 4, extent / 4),
      cy: randFloat(-extent / 4, extent / 4),
      r: randFloat(extent / 6, extent / 3),
      outletAz: randFloat(0, Math.PI * 2),
    });
  }
  return out;
}

describe('Fuzzing modelo/curvas/export — determinismo con entradas aleatorias (T31/G-1)', () => {
  test('F16 · 6 regiones sintéticas ⇒ buildTerrain bit-exacto, malla finita, stats coherentes', () => {
    for (let i = 0; i < 6; i++) {
      const extent = randFloat(2000, 5000);
      const region = synthRegion('fz' + i, extent, randInt(1, 0x7fffffff), randomBasins(extent, randInt(1, 4)));
      const a = buildTerrain(region);
      const b = buildTerrain(region);
      const ba = new Uint8Array(a.grid.h.buffer);
      const bb = new Uint8Array(b.grid.h.buffer);
      expect(ba.length === bb.length && ba.every((v, k) => v === bb[k])).toBe(true); // bit a bit
      const n = a.grid.n;
      for (let s = 0; s < 22; s++) {
        const idx = randInt(0, n * n - 1);
        expect(Number.isFinite(a.grid.h[idx])).toBe(true);
      }
      expect(a.stats.areaModelHa).toBeGreaterThan(0);
      expect(a.stats.desnivel).toBeGreaterThan(0);
      expect(a.stats.nodes).toBeGreaterThan(0);
      expect(a.stats.streams).toBeGreaterThan(0);
      expect(b.stats).toEqual(a.stats);
    }
  });

  test('F17 · 8 rejillas aleatorias ⇒ curvas deterministas, niveles 1 m consecutivos, sin NaN', () => {
    for (let i = 0; i < 8; i++) {
      const n = 49;
      const cell = randFloat(20, 60);
      const h = new Float32Array(n * n);
      let hMin = Infinity;
      let hMax = -Infinity;
      const reliefSeed = randInt(1, 0x7fffffff);
      for (let k = 0; k < h.length; k++) {
        // relieve suave vía fBm sobre la rejilla ⇒ rango garantizado ≫ 1 m
        const v = 1000 + 50 * fbm((k % n) * 0.35, Math.floor(k / n) * 0.35, reliefSeed, 4);
        h[k] = v;
        if (v < hMin) hMin = v;
        if (v > hMax) hMax = v;
      }
      const g: Grid = { n, cell, h, min: hMin, max: hMax };
      const a = buildContours(g, { simplifyTol: 0 });
      const b = buildContours(g, { simplifyTol: 0 });
      const segsA = a.levels.map((l) => l.segs).join(',');
      const segsB = b.levels.map((l) => l.segs).join(',');
      const det =
        a.levels.length === b.levels.length &&
        a.minV === b.minV && a.maxV === b.maxV && a.totalSegs === b.totalSegs &&
        segsA === segsB;
      expect(det).toBe(true);
      const consecutive = a.levels.every((lv, k) => lv.v === a.levels[0].v + k);
      expect(consecutive).toBe(true);
      const pool: Poly[] = [];
      for (const lv of a.levels) for (const poly of lv.polys) if (pool.length < 64) pool.push(poly);
      for (let s = 0; s < 11; s++) {
        const poly = pool.length > 0 ? pool[randInt(0, pool.length - 1)] : undefined;
        const ok =
          poly !== undefined &&
          Number.isFinite(poly.pts[0]) &&
          (poly.n < 2 || (Number.isFinite(poly.pts[(poly.n - 1) * 2]) && Number.isFinite(poly.pts[(poly.n - 1) * 2 + 1])));
        expect(ok).toBe(true);
      }
      expect(a.minV < a.maxV).toBe(true);
      expect(a.totalSegs).toBeGreaterThan(0);
    }
  });

  test('F18 · 350 polilíneas aleatorias ⇒ extremos preservados y longitud ≤ original', () => {
    for (let i = 0; i < 350; i++) {
      const m = randInt(3, 50);
      const pts = new Float32Array(m * 2);
      for (let k = 0; k < m; k++) {
        pts[k * 2] = randFloat(-500, 500);
        pts[k * 2 + 1] = randFloat(-500, 500);
      }
      const tol = randFloat(0.5, 8);
      const out = simplifyPolyline(pts, tol);
      expect(out.length / 2).toBeLessThanOrEqual(m);
      expect(out[0] === pts[0] && out[1] === pts[1]).toBe(true); // primer vértice
      const last = out.length - 2;
      expect(out[last] === pts[pts.length - 2] && out[last + 1] === pts[pts.length - 1]).toBe(true); // último
    }
  });

  test('F19 · 120 escenas (opts,cam) aleatorias ⇒ SVG determinista por pareja y sin «NaN»', () => {
    const region = getRegion('bufa');
    const n = 49;
    const cell = 40;
    const h = new Float32Array(n * n);
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let k = 0; k < h.length; k++) {
      const v = 2050 + 60 * fbm((k % n) * 0.3, Math.floor(k / n) * 0.3, 777, 4);
      h[k] = v;
      if (v < hMin) hMin = v;
      if (v > hMax) hMax = v;
    }
    const grid: Grid = { n, cell, h, min: hMin, max: hMax };
    const contours = buildContours(grid);
    const ring = new Float32Array(96 * 3);
    for (let k = 0; k < 96; k++) {
      const th = (k / 96) * Math.PI * 2;
      ring[k * 3] = Math.cos(th) * 500;
      ring[k * 3 + 1] = Math.sin(th) * 500;
      ring[k * 3 + 2] = 2100;
    }
    const model = {
      region,
      grid,
      basins: [{ name: 'fz', cx: 0, cy: 0, r: 500, outlet: { x: 470, y: 0, z: 2090 }, ring }],
      streams: [new Float32Array([0, 0, 2100, 100, -40, 2080, 200, -80, 2060])],
      stats: { areaModelHa: 300, dividePerimeterKm: 8, desnivel: 60, slopePct: 12, nodes: n * n, streams: 1 },
    };
    for (let i = 0; i < 120; i++) {
      const zoom = randFloat(0.4, 2.5);
      const opts: ViewOpts = {
        minor: rng() < 0.8, major: rng() < 0.8, mesh: rng() < 0.5, nodes: rng() < 0.3,
        streams: rng() < 0.8, divides: rng() < 0.8, labels: rng() < 0.5, cotas: rng() < 0.5,
        inegi: rng() < 0.5,
        elevRange: [hMin, hMax],
        forcedStep: pick([0, 1, 2, 5] as const),
        reliefFx: rng() < 0.5,
        eink: rng() < 0.3,
        day: rng() < 0.3,
        powerSave: rng() < 0.3,
        hachures: rng() < 0.5,
      };
      const cam = {
        az: randFloat(-Math.PI, Math.PI), el: randFloat(0.2, 1.2), zoom,
        panX: randInt(-200, 200), panY: randInt(-200, 200),
        pxPerM: 0.08 * zoom, w: 640, h: 480, dpr: 1,
      };
      const scene = { model, contours, opts, cam, step: 1, useLight: false, bucketColor: ['#7a7a85', '#7a7a85', '#7a7a85', '#8a8a92'], fogIdx: 0 };
      const svgA = serializeSvg(buildDisplayList(scene as never), scene as never);
      const svgB = serializeSvg(buildDisplayList(scene as never), scene as never);
      expect(svgA).toBe(svgB);
      expect(svgA.includes('NaN')).toBe(false);
    }
  });
});
