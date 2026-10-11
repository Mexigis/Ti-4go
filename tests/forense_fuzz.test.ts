/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — FUZZING DETERMINISTA DE PARSERS (última fase 1 de la
 * agenda quirúrgica revisión de ingeniería aprobada por el propietario, ).
 *
 * Filosofía: fuzzing con PRNG determinista del proyecto (makeRng) — la misma
 * semilla produce exactamente la misma batería de ataques, así el fallo es
 * reproducible byte a byte (0 GPU / 0 aleatoriedad ambiental).
 *
 * Superficies cubiertas (todas las entradas externas del visor):
 *   1. unpackRegionSeed — semilla MXP1 (texto, formato abierto en ficha/QR).
 *      Ruido + mutaciones + payloads hostiles con checksum REPARADO (el
 *      checksum da integridad, no autenticidad — cualquiera puede recomputarlo).
 *   2. parseViewHash — fragmento de URL (#v=1|…) compartible.
 *   3. decodeGeoTiffDem — archivo GeoTIFF subido (drag & drop): flips de byte,
 *      truncados, buffers diminutos y basura aleatoria.
 *   4. lzwDecodeTiff — decodificador LZW TIFF (flujo corrupto arbitrario).
 *
 * Contrato fijado: los parsers NUNCA cuelgan, NUNCA corrompen memoria,
 * devuelven null/error limpio o un objeto válido, y son deterministas.
 * Los vacíos conocidos que requieren decisión del propietario (campos sin
 * verificar en SeedPackInfo; RangeError crudo en TIFFs < 4 B) están
 * documentados como hallazgos en bitácora de ingeniería.md — aquí NO se disimulan.
 */
import { describe, test, expect } from 'bun:test';
import { unpackRegionSeed, packRegionSeed } from '../src/lib/terrain/seedpack';
import { sha256Trunc64 } from '../src/lib/terrain/sha256';
import { parseViewHash, encodeViewHash } from '../src/lib/terrain/viewstate';
import { decodeGeoTiffDem, lzwDecodeTiff } from '../src/lib/ingest/geotiff-dem';
import { REGIONS } from '../src/lib/terrain/regions';
import { makeRng } from '../src/lib/terrain/noise';
import type { ViewCamera, ViewOpts } from '../src/lib/terrain/engine';

/* ------------------------------------------------------------------ */
/* Utilidades de fuzzing                                              */
/* ------------------------------------------------------------------ */

const rng = makeRng(20260925); // semilla fija — batería 100 % reproducible

const NOISE_CHARS = 'MXP1-abcXYZ0189_./+= \t\nñü日本<>&"\'\\#|=%';

function randStr(min: number, max: number): string {
  const len = min + Math.floor(rng() * (max - min + 1));
  let s = '';
  for (let j = 0; j < len; j++) s += NOISE_CHARS[Math.floor(rng() * NOISE_CHARS.length)];
  return s;
}

function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let j = 0; j < n; j++) b[j] = Math.floor(rng() * 256);
  return b;
}

/** Invariante de forma de un SeedPackInfo (lo que HOY garantiza el parser).
 *  NOTA (hallazgo #5): id/lat/lon/e NO se verifican (pasan tal cual del JSON);
 *  el vacío queda fijado como comportamiento documentado más abajo. */
function expectSeedShape(r: NonNullable<ReturnType<typeof unpackRegionSeed>>): void {
  expect([1, 2]).toContain(r.version);
  expect(typeof r.seed).toBe('number');
  expect(Number.isInteger(r.basins)).toBe(true);
  expect(r.basins).toBeGreaterThanOrEqual(0);
}

/* ================================================================== */
/* 1. unpackRegionSeed — MXP1                                          */
/* ================================================================== */

describe('Fuzz MXP1 — ruido y mutaciones (nunca lanza, null u objeto válido)', () => {
  const base = packRegionSeed(REGIONS[0]);

  test('1,500 cadenas aleatorias ⇒ null/objeto, sin lanzar, determinista', () => {
    for (let i = 0; i < 1500; i++) {
      const s = randStr(1, 280);
      const r = unpackRegionSeed(s); // si lanzara, el test falla con la excepción
      if (r) expectSeedShape(r);
      expect(unpackRegionSeed(s)).toStrictEqual(r); // determinismo
    }
  });

  test('1,200 mutaciones del pack válido ⇒ sin lanzar; forma válida', () => {
    for (let i = 0; i < 1200; i++) {
      const arr = base.split('');
      const mode = Math.floor(rng() * 5);
      if (mode === 0) {
        const p = Math.floor(rng() * arr.length);
        const c = arr[p].charCodeAt(0) ^ (1 << Math.floor(rng() * 7));
        if (c > 0 && c < 128) arr[p] = String.fromCharCode(c);
      } else if (mode === 1) {
        arr.length = Math.max(0, Math.floor(rng() * arr.length));
      } else if (mode === 2) {
        arr.splice(Math.floor(rng() * arr.length), 0, NOISE_CHARS[Math.floor(rng() * NOISE_CHARS.length)]);
      } else if (mode === 3) {
        const p = arr.length - 1 - Math.floor(rng() * 16);
        arr[p] = '0123456789abcdef'[Math.floor(rng() * 16)];
      } else {
        arr.splice(Math.floor(rng() * arr.length), 0, ...base.slice(0, Math.floor(rng() * 30)).split(''));
      }
      const r = unpackRegionSeed(arr.join(''));
      if (r) expectSeedShape(r);
    }
    // el pack base siempre sigue vivo tras la batería (regresión)
    expect(unpackRegionSeed(base)).not.toBeNull();
  });

  test('cadena de 1 MB ⇒ null rápido (< 200 ms, sin memoria infinita)', () => {
    const huge = 'MXP1-' + 'A'.repeat(1_000_000) + '.0123456789abcdef';
    const t0 = performance.now();
    expect(unpackRegionSeed(huge)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test('round-trip de las 4 regiones sobrevive al fuzz (centinela de no-regresión)', () => {
    for (const reg of REGIONS) {
      const r = unpackRegionSeed(packRegionSeed(reg));
      expect(r).not.toBeNull();
      expect(r!.id).toBe(reg.id);
      expect(r!.seed).toBe(reg.seed);
      expect(r!.basins).toBe(reg.basins.length);
      expect(r!.version).toBe(2);
    }
  });
});

describe('Fuzz MXP1 — payloads hostiles con checksum válido (integridad ≠ autenticidad)', () => {
  /** Empaqueta un payload arbitrario con checksum v2 CORRECTO (ataque realista). */
  function craft(payload: string): string {
    const body = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `MXP1-${body}.${sha256Trunc64(payload)}`;
  }

  test('catálogo fijo de payloads hostiles ⇒ sin lanzar, forma válida, sin contaminar prototype', () => {
    const fixed = [
      '{"v":2,"id":"soledad","s":42,"lat":"INJECT","lon":-101.3,"e":6000,"b":[[10,10,5,1.2]]}',
      '{"v":2,"id":"soledad","s":1e999,"lat":21.05,"lon":-101.3,"e":6000,"b":[[1,2,3,4]]}', // s=Infinity
      '{"v":2,"id":{"x":1},"s":42,"lat":21.05,"lon":-101.3,"e":6000,"b":[[1,2,3,4]]}', // id objeto
      '{"v":2,"id":"x","s":42,"lat":null,"lon":true,"e":-0,"b":[]}', // tipos raros
      '{"v":2,"id":"x","s":42,"lat":21.05,"lon":-101.3,"e":6000,"b":' + JSON.stringify(new Array(5000).fill([1, 2, 3, 4])) + '}',
      '{"v":1,"id":"x","s":42,"lat":21.05,"lon":-101.3,"e":6000,"b":[[1,2,3,4]]}', // v1 declarado + checksum v2
      '{"v":3,"id":"x","s":42,"lat":21.05,"lon":-101.3,"e":6000,"b":[[1,2,3,4]]}', // v desconocida
      'not json at all',
      '{"v":2,"id":"x","s":42,"lat":21.05,"lon":-101.3,"e":6000,"b":[[1,2,3,4]],"__proto__":{"polluted":1}}',
      '[]', 'null', '"str"', '123',
    ];
    for (const p of fixed) {
      const r = unpackRegionSeed(craft(p));
      if (r) expectSeedShape(r);
    }
    // __proto__ no contamina (JSON.parse crea propiedad propia, no invoca setter)
    unpackRegionSeed(craft(fixed[8]));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('hallazgo #5 CERRADO — id/lat/lon/e hostiles con checksum válido ⇒ RECHAZO (verificación de tipos)', () => {
    /* Historia: el hallazgo #5 documentó que id/lat/lon/e pasaban sin
     * verificación de tipo (integridad ≠ autenticidad). El seedpack hoy
     * VALIDA tipos y forma: el payload hostil con checksum reparado devuelve
     * null — el pin anterior (el gap existente) quedó obsoleto y se
     * re-ancla al comportamiento estricto actual. */
    const r = unpackRegionSeed(craft('{"v":2,"id":{"x":1},"s":42,"lat":"INJECT","lon":null,"e":true,"b":[[1,2,3,4]]}'));
    expect(r).toBeNull(); // id objeto · lat string · lon null · e bool ⇒ rechazo limpio
    // s:1e999 ⇒ Infinity (no finito) también fuera del contrato ⇒ rechazo
    const inf = unpackRegionSeed(craft('{"v":2,"id":"x","s":1e999,"lat":21,"lon":-101,"e":6000,"b":[]}'));
    expect(inf).toBeNull();
  });

  test('300 payloads mutados con checksum reparado ⇒ invariante de forma + determinismo', () => {
    const template: Record<string, unknown> = {
      v: 2, id: 'soledad', s: 20240613, lat: 21.0518, lon: -101.3248, e: 6400, b: [[10.5, 20.1, 5, 1.234]],
    };
    const junk: unknown[] = ['INJECT', null, true, -1, 1e999, { o: 1 }, [9, 9], 0, '', 42]; // NaN no es JSON
    for (let i = 0; i < 300; i++) {
      const p: Record<string, unknown> = { ...template };
      const field = ['v', 'id', 's', 'lat', 'lon', 'e', 'b'][Math.floor(rng() * 7)];
      if (rng() < 0.15) delete p[field]; // campo ausente
      else p[field] = junk[Math.floor(rng() * junk.length)];
      const payload = JSON.stringify(p);
      const r = unpackRegionSeed(craft(payload));
      if (r) {
        expectSeedShape(r);
        expect(unpackRegionSeed(craft(payload))).toStrictEqual(r); // determinismo
      }
    }
  });
});

/* ================================================================== */
/* 2. parseViewHash — fragmento de URL                                 */
/* ================================================================== */

describe('Fuzz parseViewHash — URL hostil (nunca lanza, null o vista válida)', () => {
  const cam: ViewCamera = { az: -0.7853981633974483, el: 0.61548, zoom: 1.23, panX: -12, panY: 34 };
  const opts = {
    minor: true, major: true, mesh: false, nodes: true, streams: true,
    divides: false, labels: true, cotas: true, inegi: false,
    elevRange: [2000, 2545] as [number, number], forcedStep: 0, eink: false, powerSave: true,
  } as unknown as ViewOpts;
  const validHash = '#' + encodeViewHash('soledad', cam, opts);

  const expectView = (pv: ReturnType<typeof parseViewHash>): void => {
    if (pv === null) return;
    if (pv.regionId !== undefined) expect(pv.regionId).toMatch(/^[a-z0-9-]{1,40}$/);
    if (pv.cam) {
      for (const v of [pv.cam.az, pv.cam.el, pv.cam.zoom, pv.cam.panX, pv.cam.panY]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
    if (pv.layers?.elevRange) {
      const [a, b] = pv.layers.elevRange;
      expect(a < b).toBe(true);
    }
  };

  test('2,000 fragmentos ruidosos y mutados ⇒ null/vista válida, sin lanzar, determinista', () => {
    for (let i = 0; i < 2000; i++) {
      const mode = Math.floor(rng() * 3);
      let h: string;
      if (mode === 0) {
        h = randStr(0, 160);
        if (rng() < 0.5) h = '#v=1|' + h; // prefijo válido + basura
      } else if (mode === 1) {
        // mutación del hash válido: inserción/borrado/sustitución de 1 char
        const p = Math.floor(rng() * validHash.length);
        const c = randStr(1, 1);
        h = rng() < 0.33
          ? validHash.slice(0, p) + c + validHash.slice(p)
          : rng() < 0.5
            ? validHash.slice(0, p) + validHash.slice(p + 1)
            : validHash.slice(0, p) + c + validHash.slice(p + 1);
      } else {
        h = '#v=' + Math.floor(rng() * 3) + '|' + randStr(0, 120);
      }
      const pv = parseViewHash(h);
      expectView(pv);
      expect(parseViewHash(h)).toStrictEqual(pv); // determinismo
    }
  });

  test('claves inválidas se descartan una a una; la vista se sostiene con las válidas (tolerancia documentada)', () => {
    // hash con az=Infinity ⇒ la clave az se descarta y el/z válidos sostienen la vista
    const pv = parseViewHash('#v=1|r=soledad|az=1e999|el=35.3|z=1');
    expect(pv).not.toBeNull();
    expect(pv!.cam!.az).toBe(-Math.PI / 4); // az por defecto
    expect(pv!.cam!.zoom).toBe(1);
    // rechazo total cuando NINGUNA clave es válida (ok nunca se activa)
    expect(parseViewHash('#v=1|az=1e999')).toBeNull(); // az=Infinity sola
    expect(parseViewHash('#v=1|az=NaN')).toBeNull();
    expect(parseViewHash('#v=1|az=721')).toBeNull(); // fuera de ±720
    expect(parseViewHash('#v=1|z=1e308')).toBeNull(); // zoom Infinity
    expect(parseViewHash('#v=1|r=' + 'a'.repeat(41))).toBeNull(); // id > 40
    expect(parseViewHash('#v=1|r=SOLEDAD')).toBeNull(); // mayúsculas
    expect(parseViewHash('#v=1|r=soledad;alert(1)')).toBeNull(); // inyección
    expect(parseViewHash('#v=2|r=soledad')).toBeNull(); // versión futura
    expect(parseViewHash('#v=1|er=3000x2000')).toBeNull(); // rango invertido
    // pan gigante: enteros válidos ⇒ aceptado (el motor re-clampa — comportamiento documentado)
    // NOTA: la clave p sola no activa ok (solo r/az/el/z validan la vista) — con r sí
    expect(parseViewHash('#v=1|p=99999999999x-99999999999')).toBeNull();
    const bigPan = parseViewHash('#v=1|r=soledad|p=99999999999x-99999999999');
    expect(bigPan).not.toBeNull();
    expect(Number.isFinite(bigPan!.cam!.panX)).toBe(true);
  });

  test('centinela: el hash válido de producción sigue parseando', () => {
    const pv = parseViewHash(validHash);
    expect(pv).not.toBeNull();
    expect(pv!.regionId).toBe('soledad');
    expect(pv!.cam!.zoom).toBeCloseTo(1.23, 6);
  });
});

/* ================================================================== */
/* 3. decodeGeoTiffDem — binario hostil                                */
/* ================================================================== */

type Tag = [number, number, number, number | number[]];

/** TIFF clásico LE mínimo (mismo builder que forense_geotiff.test.ts). */
function buildTiff(tags: Tag[], extra?: Uint8Array): ArrayBuffer {
  const sorted = [...tags].sort((a, b) => a[0] - b[0]);
  const ifdSize = 2 + sorted.length * 12 + 4;
  const dataStart = 8 + ifdSize;
  const chunks: Uint8Array[] = [];
  let off = dataStart;
  const valueOf = new Map<number, number>();
  for (const [tag, type, , value] of sorted) {
    if (Array.isArray(value)) {
      valueOf.set(tag, off);
      const bytes = new Uint8Array(value.length * (type === 12 ? 8 : type === 4 ? 4 : 2));
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < value.length; i++) {
        if (type === 12) dv.setFloat64(i * 8, value[i] as number, true);
        else if (type === 4) dv.setUint32(i * 4, value[i] as number, true);
        else dv.setUint16(i * 2, value[i] as number, true);
      }
      chunks.push(bytes);
      off += bytes.length;
    }
  }
  const buf = new ArrayBuffer(off + (extra?.length ?? 0));
  const dv = new DataView(buf);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, sorted.length, true);
  let p = 10;
  for (const [tag, type, count, value] of sorted) {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    const v = valueOf.get(tag);
    if (v !== undefined) dv.setUint32(p + 8, v, true);
    else if (type === 3) dv.setUint16(p + 8, value as number, true);
    else dv.setUint32(p + 8, value as number, true);
    p += 12;
  }
  dv.setUint32(p, 0, true);
  let q = dataStart;
  for (const c of chunks) { new Uint8Array(buf, q, c.length).set(c); q += c.length; }
  if (extra) new Uint8Array(buf, q, extra.length).set(extra);
  return buf;
}

const px = new Float64Array(16);
for (let i = 0; i < 16; i++) px[i] = 2000 + i * 7;
const STRIP_OFF = 8 + (2 + 14 * 12 + 4) + 24 + 48 + 16; // 14 tags (11 escalares + 3 geo)
const validTiff = buildTiff([
  [256, 4, 1, 4], [257, 4, 1, 4], [258, 3, 1, 64], [259, 3, 1, 1],
  [273, 4, 1, STRIP_OFF], [277, 3, 1, 1], [278, 4, 1, 4], [279, 4, 1, 128],
  [284, 3, 1, 1], [317, 3, 1, 1], [339, 3, 1, 3],
  [33550, 12, 3, [1.0e-5, 1.0e-5, 0]], [33922, 12, 6, [0, 0, 0, -101.3248, 21.0518, 0]],
  [34735, 3, 8, [1, 1, 0, 1, 2048, 0, 1, 4326]],
], new Uint8Array(px.buffer));

describe('Fuzz GeoTIFF — binario hostil (decodifica íntegro o rechaza; nunca cuelga)', () => {
  function expectDem(d: Awaited<ReturnType<typeof decodeGeoTiffDem>>): void {
    // invariantes universales bajo mutación (ver GAP #7 para la excepción de consistencia w×h)
    expect(d.data.length).toBeGreaterThan(0); // raster no vacío
    expect(d.min).toBeLessThanOrEqual(d.max);
    expect(d.scaleX).toBeGreaterThan(0);
    expect(d.scaleY).toBeGreaterThan(0);
    expect(d.strips).toBeGreaterThanOrEqual(1);
    expect(['geographic', 'utm', 'metric', 'unknown']).toContain(d.crs.kind);
  }

  test('buffers diminutos (0–7 B) y firma prematura ⇒ Error (RangeError crudo documentado — hallazgo #6)', async () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const err = await decodeGeoTiffDem(new ArrayBuffer(n)).then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.length).toBeGreaterThan(0);
    }
    // "II*\0" (4 B con firma válida): el parser intenta leer el IFD ⇒ RangeError documentado
    const craft = new ArrayBuffer(4);
    const dv = new DataView(craft);
    dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); dv.setUint16(2, 42, true);
    const err = await decodeGeoTiffDem(craft).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
  });

  test('hallazgo #7 CERRADO — atajo sin comprimir RECHAZA strip que no cubre w×h', () => {
    /* Historia: el hallazgo #7 documentó que el atajo compression=1 decodificaba
     * con data.length=16 aunque w×h=32 (el strip no se re-validaba). El decoder
     * hoy VALIDA la cobertura del strip contra w×h ⇒ rechazo limpio — el pin
     * anterior (el gap existente) quedó obsoleto y se re-ancla al rechazo. */
    const u8 = new Uint8Array(validTiff.slice(0));
    const dv = new DataView(u8.buffer);
    expect(dv.getUint16(10, true)).toBe(256); // entry 0 = ImageWidth
    dv.setUint32(18, 8, true); // width 4 → 8 (strip 16 B < w×h 32 B)
    const out = decodeGeoTiffDem(u8.buffer).then((d) => d, () => null);
    return out.then((d) => {
      expect(d).toBeNull(); // hoy RECHAZA (cobertura inconsistente)
    });
  });

  test('900 mutaciones del TIFF válido ⇒ decodifica o rechaza; centinela bit-exacto cada 150', async () => {
    let decoded = 0;
    let rejected = 0;
    for (let i = 0; i < 900; i++) {
      const u8 = new Uint8Array(validTiff.slice(0)); // COPIA — new Uint8Array(ArrayBuffer) es vista, no copia
      const mode = Math.floor(rng() * 3);
      if (mode === 0) {
        const n = 1 + Math.floor(rng() * 4);
        for (let k = 0; k < n; k++) u8[Math.floor(rng() * u8.length)] = Math.floor(rng() * 256);
      } else if (mode === 1) {
        u8[Math.floor(rng() * 90)] = Math.floor(rng() * 256); // header/IFD
      } else {
        u8[Math.floor(rng() * u8.length)] = Math.floor(rng() * 256);
        u8[Math.floor(rng() * u8.length)] = Math.floor(rng() * 256);
      }
      await decodeGeoTiffDem(u8.buffer).then(
        (d) => { decoded++; expectDem(d); },
        (e: Error) => { rejected++; expect(e.message.length).toBeGreaterThan(0); }
      );
      if (i % 150 === 0) {
        // centinela de no-regresión: el TIFF prístino sigue bit-exacto
        const d = await decodeGeoTiffDem(validTiff);
        expect(d.data[0]).toBe(2000);
        expect(d.data[15]).toBe(2000 + 15 * 7);
      }
    }
    expect(decoded + rejected).toBe(900);
    expect(decoded).toBeGreaterThan(0); // el fuzz SÍ alcanza la zona de datos a veces
    expect(rejected).toBeGreaterThan(0); // y también rechaza
  });

  test('200 truncados ⇒ decodifica o Error limpio (sin colgar)', async () => {
    const full = new Uint8Array(validTiff);
    for (let i = 0; i < 200; i++) {
      const cut = Math.floor(rng() * full.length);
      const t2 = new Uint8Array(cut);
      t2.set(full.subarray(0, cut));
      const res = await decodeGeoTiffDem(t2.buffer).then(
        (d) => { expectDem(d); return 'decoded'; },
        (e: Error) => e.message
      );
      expect(res.length).toBeGreaterThan(0);
    }
  });

  test('150 buffers aleatorios puros ⇒ decodifica o Error (mayoría rechazada por firma)', async () => {
    for (let i = 0; i < 150; i++) {
      const res = await decodeGeoTiffDem(randBytes(Math.floor(rng() * 400)).buffer).then(
        (d) => { expectDem(d); return 'decoded'; },
        (e: Error) => e.message
      );
      expect(res.length).toBeGreaterThan(0);
    }
  });

  test('determinismo: el mismo binario mutado produce siempre el mismo resultado', async () => {
    const u8 = new Uint8Array(validTiff.slice(0)); // copia independiente
    u8[20] ^= 0xff; // mutación FIJA (reproducible)
    const a = await decodeGeoTiffDem(u8.buffer).then(() => 'ok', (e: Error) => e.message);
    const b = await decodeGeoTiffDem(u8.slice().buffer).then(() => 'ok', (e: Error) => e.message);
    expect(b).toBe(a);
  });
});

/* ================================================================== */
/* 4. lzwDecodeTiff — flujo LZW corrupto                               */
/* ================================================================== */

describe('Fuzz LZW — flujo arbitrario (termina, ≤ esperado, determinista)', () => {
  test('2,500 (src, expected) aleatorios ⇒ sin lanzar, out.length ≤ expected', () => {
    for (let i = 0; i < 2500; i++) {
      const src = randBytes(Math.floor(rng() * 300));
      const expected = Math.floor(rng() * 2000);
      const out = lzwDecodeTiff(src, expected); // si lanzara, el test falla
      expect(out.length).toBeLessThanOrEqual(expected);
      expect(Buffer.from(lzwDecodeTiff(src, expected)).equals(Buffer.from(out))).toBe(true);
    }
  });

  test('casos límite: src vacío, expected 0, flujo largo ⇒ acotado en tiempo', () => {
    expect(lzwDecodeTiff(new Uint8Array(0), 100).length).toBe(0);
    expect(lzwDecodeTiff(randBytes(50), 0).length).toBe(0);
    const t0 = performance.now();
    const out = lzwDecodeTiff(new Uint8Array(4096).fill(0x80), 1_000_000); // ruta larga acotada
    expect(out.length).toBeLessThanOrEqual(1_000_000);
    expect(performance.now() - t0).toBeLessThan(2000); // sin cuelgues (≤ 2 s)
  });
});

/* ------------------------------------------------------------------ */
/* Presupuesto total (detección global de cuelgues)                    */
/* ------------------------------------------------------------------ */

describe('Presupuesto de la batería de fuzzing', () => {
  test('ronda completa de todas las superficies en < 30 s (sin cuelgues ocultos)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) unpackRegionSeed(randStr(1, 260));
    for (let i = 0; i < 300; i++) parseViewHash(randStr(0, 140));
    for (let i = 0; i < 200; i++) lzwDecodeTiff(randBytes(200), 500);
    expect(performance.now() - t0).toBeLessThan(30_000);
  });
});
