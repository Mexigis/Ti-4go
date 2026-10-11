/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-3 — Mission Pack ZIP (lector PKZIP 2.0 0-dep · manifest
 * → dispatch · cruce triangular A↔B↔KML · SHA-256 de custodia · H-1/H-3).
 * Re-landing por rollback #2 (entrada §9 PREVIA 2026-09-27, trace
 * ) — contrato registrado del checkpoint como mínimo.
 *
 *   - Golden pack: manifest tolerante + A (GeoJSON UTM 14N) + B (GeoJSON
 *     grados) + KML (rutas) + friction.tif (auditoría, overlay FR-5) +
 *     datum.prj (ficha) + rol desconocido («no procesado» honesto).
 *   - Descompresor DEFLATE contra ground truth node:zlib (deflateRawSync
 *     en niveles 0/1/6/9 y estrategia Z_FIXED — cubre bloques stored,
 *     fixed y dynamic) + round-trips aleatorios + streams truncados/basura.
 *   - CATÁLOGO 24 HOSTILES (tabla determinista): truncamientos EOCD,
 *     directorio roto, conteos/discrepancias, ZIP64, cifrado, método,
 *     cabeceras locales, CRC, bombas (real y declarada), zip-slip
 *     (../, absoluta, unidad, NUL), duplicados, solapamiento.
 *   - H-1: digest del manifest determinista (campos volátiles fuera).
 *   - Custodia: SHA-256 del pack completo en meta.custody (H-3: bitácora
 *     visible — verificado en ingest.ts).
 *
 * Ledger de auditoría: aserciones incondicionales verificadas contra bun.
 */
import { describe, expect, test } from 'bun:test';
import { deflateRawSync, inflateRawSync, deflateSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { crc32, readZip, inflateRaw, MAX_ENTRY_BYTES } from '../src/lib/ingest/zip';
import { parseMissionPack, geojsonIdentity } from '../src/lib/ingest/pack';
import { parseKmlIdentity } from '../src/lib/ingest/kml';
import { wgs84ToUtm14n } from '../src/lib/ingest/geojson';
import { sha256HexBytes } from '../src/lib/terrain/sha256';
import type { Anchor } from '../src/lib/ingest/parsers';

const ANCHOR: Anchor = {
  extentM: 8000,
  zMinM: 1950,
  zMaxM: 2600,
  centerLat: 21.0,
  centerLon: -101.33,
  regionName: 'prueba-fr3',
};

/* ------------------------------------------------------------------ */
/* Escritor ZIP de fixtures (solo para tests — FR-W1 sintético)       */
/* ------------------------------------------------------------------ */

interface ZipIn {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  utf8?: boolean;
}

interface BuildOpts {
  flags?: number; // OR sobre flags de cada entrada (cifrado simulado)
  methodOverride?: number;
  commentLenOverride?: number;
  entriesTotalOverride?: number;
  entriesThisDiskOverride?: number;
  cdSizeOverride?: number;
  cdOffsetOverride?: number;
  diskStartOverride?: number;
  localOffsetOverride?: number[]; // por índice
  corruptAt?: Array<{ at: number; xor: number }>; // mutaciones por byte
  breakLocalName?: number; // índice de entrada cuyo nombre local cambia
  mismatchLocalSizes?: number; // índice con tamaños locales falsos
  duplicateName?: boolean; // duplica la primera entrada
  appendBytes?: Uint8Array;
  truncateTail?: number; // bytes recortados del final ANTES del append
  appendEocd64Locator?: boolean;
}

function u16arr(v: number): [number, number] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32arr(v: number): [number, number, number, number] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Escritor ZIP mínimo (PKZIP 2.0) con ganchos de corrupción por opción. */
function buildZip(inputs: ZipIn[], opts: BuildOpts = {}): Uint8Array {
  const chunks: number[][] = [];
  const central: number[][] = [];
  const locals: number[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const method = opts.methodOverride ?? inp.method ?? 0;
    const flags = (inp.utf8 === false ? 0 : 0x800) | (opts.flags ?? 0);
    let data = inp.data;
    let crc = crc32(data);
    if (method === 8) data = deflateRawSync(data);
    const localOffset = opts.localOffsetOverride?.[i] ?? chunks.reduce((s, c) => s + c.length, 0);
    locals.push(chunks.reduce((s, c) => s + c.length, 0));
    const nameBytes = Array.from(new TextEncoder().encode(inp.name));
    const local: number[] = [
      ...u32arr(0x04034b50), ...u16arr(20), ...u16arr(flags), ...u16arr(method),
      ...u16arr(0), ...u16arr(0), ...u32arr(crc),
      ...u32arr(data.length), ...u32arr(inp.data.length),
      ...u16arr(nameBytes.length), ...u16arr(0),
      ...nameBytes, ...Array.from(data),
    ];
    if (opts.mismatchLocalSizes === i) {
      local[18] = (inp.data.length + 7) & 0xff; // uncomp local ≠ central
    }
    if (opts.breakLocalName === i) {
      // cambia la primera letra del nombre local (misma longitud)
      const nameStart = 30;
      local[nameStart] = (local[nameStart] & 0xff) ^ 0x01;
    }
    chunks.push(local);
    central.push([
      ...u32arr(0x02014b50), ...u16arr(20), ...u16arr(20), ...u16arr(flags), ...u16arr(method),
      ...u16arr(0), ...u16arr(0), ...u32arr(crc),
      ...u32arr(data.length), ...u32arr(inp.data.length),
      ...u16arr(nameBytes.length), ...u16arr(0), ...u16arr(0),
      ...u16arr(opts.diskStartOverride ?? 0), ...u16arr(0), ...u32arr(0),
      ...u32arr(localOffset),
      ...nameBytes,
    ]);
  }

  if (opts.duplicateName && inputs.length > 0) {
    // re-emite la primera entrada completa (mismo nombre) al final
    const inp = inputs[0];
    const data = inp.method === 8 ? deflateRawSync(inp.data) : inp.data;
    const nameBytes = Array.from(new TextEncoder().encode(inp.name));
    const off = chunks.reduce((s, c) => s + c.length, 0);
    locals.push(off);
    chunks.push([
      ...u32arr(0x04034b50), ...u16arr(20), ...u16arr(0x800), ...u16arr(inp.method ?? 0),
      ...u16arr(0), ...u16arr(0), ...u32arr(crc32(inp.data)),
      ...u32arr(data.length), ...u32arr(inp.data.length),
      ...u16arr(nameBytes.length), ...u16arr(0),
      ...nameBytes, ...Array.from(data),
    ]);
    central.push([
      ...u32arr(0x02014b50), ...u16arr(20), ...u16arr(20), ...u16arr(0x800), ...u16arr(inp.method ?? 0),
      ...u16arr(0), ...u16arr(0), ...u32arr(crc32(inp.data)),
      ...u32arr(data.length), ...u32arr(inp.data.length),
      ...u16arr(nameBytes.length), ...u16arr(0), ...u16arr(0),
      ...u16arr(0), ...u16arr(0), ...u32arr(0),
      ...u32arr(off),
      ...nameBytes,
    ]);
  }

  const localBlob = chunks.flat();
  const cdStart = localBlob.length;
  const cdBlob = central.flat();
  const eocdEntries = opts.duplicateName ? inputs.length + 1 : inputs.length;
  const eocd: number[] = [
    ...u32arr(0x06054b50), ...u16arr(0), ...u16arr(0),
    ...u16arr(opts.entriesThisDiskOverride ?? eocdEntries),
    ...u16arr(opts.entriesTotalOverride ?? eocdEntries),
    ...u32arr(opts.cdSizeOverride ?? cdBlob.length),
    ...u32arr(opts.cdOffsetOverride ?? cdStart),
    ...u16arr(opts.commentLenOverride ?? 0),
  ];

  let out: number[] = [...localBlob, ...cdBlob];
  const eocdAt = out.length;
  if (opts.appendEocd64Locator) {
    out = [...out, ...u32arr(0x07064b50), ...u32arr(0), ...u32arr(eocdAt + 20), ...u32arr(1)];
  }
  out = [...out, ...eocd];
  if (opts.truncateTail) out = out.slice(0, out.length - opts.truncateTail);
  if (opts.appendBytes) out = [...out, ...Array.from(opts.appendBytes)];
  if (opts.corruptAt) {
    for (const c of opts.corruptAt) out[c.at] = (out[c.at] ?? 0) ^ c.xor;
  }
  return new Uint8Array(out);
}

/* ------------------------------------------------------------------ */
/* Contenido sintético del pack (FR-W1)                               */
/* ------------------------------------------------------------------ */

// Feature compartida por las tres fuentes (misma tierra, distinta codificación)
const UUID_ARROYO = 'a0b1c2d3-1111-4222-8333-444455556666';
const UUID_CERRO = 'b1b2c3d4-2222-4333-8444-555566667777';

const DEG_LINE: Array<[number, number]> = [
  [-101.35, 21.0],
  [-101.34, 21.01],
  [-101.33, 21.02],
];

function degToUtm(lon: number, lat: number): [number, number] {
  // conversión real de FR-1: el fixture A es UTM 14N genuino
  const c = wgs84ToUtm14n(lon, lat);
  if (!c) throw new Error('fixture fuera de zona 14N');
  return c;
}

const A_GEOJSON_UTM = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { uuid: UUID_ARROYO, nombre: 'Arroyo principal', cota: 2050 },
      geometry: {
        type: 'LineString',
        coordinates: DEG_LINE.map(([lon, lat]) => {
          const [e, n] = degToUtm(lon, lat);
          return [Math.round(e * 100) / 100, Math.round(n * 100) / 100];
        }),
      },
    },
  ],
});

const B_GEOJSON_DEG = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { uuid: UUID_ARROYO, nombre: 'Arroyo principal (B)' },
      geometry: { type: 'LineString', coordinates: DEG_LINE },
    },
  ],
});

const KML_RUTAS = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark id="${UUID_ARROYO}"><name>Arroyo principal (K)</name>
      <LineString><coordinates>${DEG_LINE.map(([a, b]) => `${a},${b},2050`).join(' ')}</coordinates></LineString>
    </Placemark>
    <Placemark id="${UUID_CERRO}"><name>Cerro testigo (K)</name>
      <Polygon><outerBoundaryIs><LinearRing>
        <coordinates>-101.32,21.00 -101.31,21.00 -101.31,21.01 -101.32,21.01 -101.32,21.00</coordinates>
      </LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
  </Document>
</kml>`;

const TIFF_STUB = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0]); // II*\0 + IFD vacío

/* ------------------------------------------------------------------ */
/* Builder TIFF sintético LE (copia fiel del de forense_geotiff.test)  */
/* — genera el campo de fricción REAL del golden pack (FR-5 · D12)     */
/* ------------------------------------------------------------------ */

type Entry = { tag: number; type: number; count: number; value: number | number[] | bigint[] };

const TT = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, DOUBLE: 12 } as const;

function buildTiff(opts: {
  w: number;
  h: number;
  data: Float64Array; // fila 0 = norte
  compression?: number;
  scaleX?: number;
  scaleY?: number;
  tieX?: number;
  tieY?: number;
}): ArrayBuffer {
  const { w, h, data } = opts;
  const compression = opts.compression ?? 1;
  const raw = new Uint8Array(new Float64Array(data).buffer); // LE en plataforma LE
  const raster = compression === 8 ? new Uint8Array(deflateSync(raw)) : raw;

  const ext: { bytes: Uint8Array }[] = [];
  const pushExt = (u8: Uint8Array): number => {
    ext.push({ bytes: u8 });
    return ext.length - 1;
  };

  const scaleD = new Float64Array([opts.scaleX ?? 0.001, opts.scaleY ?? 0.001, 0]);
  const tieD = new Float64Array([0, 0, 0, opts.tieX ?? -101.4, opts.tieY ?? 21.0, 0]);

  const entries: Entry[] = [
    { tag: 256, type: TT.LONG, count: 1, value: w },
    { tag: 257, type: TT.LONG, count: 1, value: h },
    { tag: 258, type: TT.SHORT, count: 1, value: 64 },
    { tag: 259, type: TT.SHORT, count: 1, value: compression },
    { tag: 277, type: TT.SHORT, count: 1, value: 1 }, // SamplesPerPixel
    { tag: 273, type: TT.LONG, count: 1, value: 0 }, // StripOffsets — parcheado
    { tag: 278, type: TT.LONG, count: 1, value: h }, // RowsPerStrip = h
    { tag: 279, type: TT.LONG, count: 1, value: raster.length },
    { tag: 284, type: TT.SHORT, count: 1, value: 1 }, // PlanarConfig
    { tag: 339, type: TT.SHORT, count: 1, value: 3 }, // SampleFormat float
    { tag: 33550, type: TT.DOUBLE, count: 3, value: pushExt(new Uint8Array(scaleD.buffer)) },
    { tag: 33922, type: TT.DOUBLE, count: 6, value: pushExt(new Uint8Array(tieD.buffer)) },
  ];
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOff = 8;
  const ifdLen = 2 + entries.length * 12 + 4;
  const extOff0 = ifdOff + ifdLen;
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
    const inlineBytes = e.count * (TS[e.type] ?? 1);
    if (inlineBytes <= 4 && typeof e.value === 'number') {
      if (e.type === TT.SHORT) dv.setUint16(p + 8, e.value, true);
      else dv.setUint32(p + 8, e.value, true);
    } else {
      dv.setUint32(p + 8, extOffsets[e.value as number] ?? 0, true);
    }
    p += 12;
  }
  dv.setUint32(p, 0, true); // next IFD = 0
  ext.forEach((e, i) => u8.set(e.bytes, extOffsets[i]));
  u8.set(raster, rasterOff);
  return buf;
}

/* Campo de fricción sintético 4×4 (mesh 10 m): 0.10..0.85 — cruza los
   tres bordes D12 (0.25/0.5/0.75) ⇒ las 4 clases presentes. */
const FRICTION_FIELD_4X4 = (() => {
  const d = new Float64Array(16);
  for (let i = 0; i < 16; i++) d[i] = 0.1 + i * 0.05;
  return d;
})();
const FRICTION_TIF_OK = new Uint8Array(
  buildTiff({ w: 4, h: 4, data: FRICTION_FIELD_4X4, scaleX: 10, scaleY: 10 })
);
const DATUM_WKT = new TextEncoder().encode(
  'PROJCS["WGS 84 / UTM zone 14N",GEOGCS["WGS 84",DATUM["WGS_1984"]],PROJECTION["Transverse_Mercator"]]'
);

function makeManifest(opts?: { generado?: string; extraMiembro?: object; omitirMiembros?: string[] }): Uint8Array {
  const miembros: Array<{ role: string; path: string; layerType?: string }> = [
    { role: 'A', path: 'a.geojson', layerType: 'vector' },
    { role: 'B', path: 'b.geojson' },
    { role: 'KML', path: 'rutas.kml' },
    { role: 'friction.tif', path: 'friction.tif' },
    { role: 'datum', path: 'datum.prj' },
    { role: 'capa-desconocida', path: 'extra.xyz' },
  ];
  const filtered = (opts?.omitirMiembros ?? []).length
    ? miembros.filter((m) => !(opts?.omitirMiembros ?? []).includes(m.path))
    : miembros;
  if (opts?.extraMiembro) filtered.push(opts.extraMiembro as { role: string; path: string });
  return new TextEncoder().encode(
    JSON.stringify({ version: '1.0.0', mision: 'soledad-sintetica', generado: opts?.generado ?? '2026-09-27T00:00:00Z', miembros: filtered })
  );
}

function goldenInputs(): ZipIn[] {
  return [
    { name: 'manifest.json', data: makeManifest() },
    { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
    { name: 'b.geojson', data: new TextEncoder().encode(B_GEOJSON_DEG) },
    { name: 'rutas.kml', data: new TextEncoder().encode(KML_RUTAS), method: 8 },
    { name: 'friction.tif', data: FRICTION_TIF_OK }, // campo D12 REAL — FR-5 lo decodifica
    { name: 'datum.prj', data: DATUM_WKT },
    { name: 'extra.xyz', data: new Uint8Array([1, 2, 3]) },
  ];
}

/* ------------------------------------------------------------------ */
/* Descompresor DEFLATE contra ground truth node:zlib                 */
/* ------------------------------------------------------------------ */

describe('FR-3 descompresor DEFLATE (ground truth zlib)', () => {
  const samples: Array<{ label: string; data: Uint8Array }> = [
    { label: 'vacío', data: new Uint8Array(0) },
    { label: '1 B', data: new Uint8Array([0x42]) },
    { label: 'texto', data: new TextEncoder().encode('mision soledad '.repeat(400)) },
    {
      label: 'aleatorio 32 KB',
      data: (() => {
        const u = new Uint8Array(32 * 1024);
        let s = 12345;
        for (let i = 0; i < u.length; i++) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          u[i] = s & 0xff;
        }
        return u;
      })(),
    },
    {
      label: 'repetitivo 64 KB (LZ77 largo)',
      data: new TextEncoder().encode('ABCAABCAABCA'.repeat(5600)),
    },
  ];

  const variants: Array<{ label: string; opts: Parameters<typeof deflateRawSync>[1] }> = [
    { label: 'nivel 0 (stored blocks)', opts: { level: 0 } },
    { label: 'nivel 1', opts: { level: 1 } },
    { label: 'nivel 6', opts: { level: 6 } },
    { label: 'nivel 9', opts: { level: 9 } },
    { label: 'estrategia Z_FIXED (bloques fixed-Huffman)', opts: { level: 6, strategy: constants.Z_FIXED } },
    { label: 'estrategia Z_RLE', opts: { level: 9, strategy: constants.Z_RLE } },
  ];

  for (const v of variants) {
    test(`round-trip exacto — ${v.label}`, () => {
      for (const s of samples) {
        const comp = deflateRawSync(s.data, v.opts);
        const res = inflateRaw(comp, 0, comp.length, s.data.length + 64);
        // Estructura completa en una sola comparación (misma fuerza: veredicto,
        // overflow, completitud, longitud y contenido bit-exacto).
        expect([
          res !== null,
          res?.overflow ?? null,
          res?.complete ?? null,
          res?.out.length ?? null,
          res ? Buffer.from(res.out).equals(Buffer.from(s.data)) : null,
        ]).toEqual([true, false, true, s.data.length, true]);
      }
    });
  }

  test('los bloques de zlib con nivel 0 son realmente almacenados (comp ≥ datos)', () => {
    const data = new TextEncoder().encode('x'.repeat(1000));
    const comp = deflateRawSync(data, { level: 0 });
    expect(comp.length).toBeGreaterThanOrEqual(data.length);
  });

  test('stream truncado ⇒ null; stream basura ⇒ null', () => {
    const comp = deflateRawSync(new TextEncoder().encode('mision '.repeat(500)), { level: 6 });
    const basura = new Uint8Array(512);
    let s = 999;
    for (let i = 0; i < basura.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      basura[i] = s & 0xff;
    }
    expect({
      truncado: Boolean(inflateRaw(comp.subarray(0, comp.length >> 1), 0, comp.length >> 1, 1 << 20)?.complete),
      basura: inflateRaw(basura, 0, basura.length, 1 << 20),
    }).toEqual({ truncado: false, basura: null });
  });

  test('bomba de descompresión: cap duro aborta con overflow (nunca asigna más)', () => {
    const data = new TextEncoder().encode('bomba '.repeat(100_000)); // ~600 KB reales
    const comp = deflateRawSync(data, { level: 9 });
    const res = inflateRaw(comp, 0, comp.length, 1024); // cap MUY por debajo
    expect([res !== null, res?.overflow ?? null, (res?.out.length ?? Infinity) <= 1024]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test('refZlib: inflateRawSync de node:zlib confirma que el writer produce streams válidos', () => {
    const data = new TextEncoder().encode('verificación cruzada con zlib real');
    const comp = deflateRawSync(data, { level: 6 });
    const back = inflateRawSync(comp);
    expect(Buffer.from(back).equals(Buffer.from(data))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Golden pack                                                        */
/* ------------------------------------------------------------------ */

describe('FR-3 golden pack', () => {
  test('lector ZIP: entradas con nombre, tamaños y CRC verificados', () => {
    const bytes = new Uint8Array(buildZip(goldenInputs()));
    const zip = readZip(bytes);
    expect(zip.ok).toBe(true);
    if (!zip.ok) return;
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    // Estructura completa en una sola comparación (misma fuerza)
    expect({
      n: zip.entries.length,
      manifestMethod: byName.get('manifest.json')!.method,
      aMethod: byName.get('a.geojson')!.method,
      aLen: byName.get('a.geojson')!.data.length,
      datumCrc: byName.get('datum.prj')!.crc32,
    }).toEqual({
      n: 7,
      manifestMethod: 0,
      aMethod: 8,
      aLen: new TextEncoder().encode(A_GEOJSON_UTM).length,
      datumCrc: crc32(DATUM_WKT),
    });
  });

  test('parseMissionPack: dispatch completo + ficha + geometría combinada', () => {
    const bytes = new Uint8Array(buildZip(goldenInputs()));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect({ format: r.meta.format, label: r.meta.label }).toEqual({ format: 'pack', label: 'Mission Pack' });
    const e = r.meta.entities as Record<string, number>;
    // Ficha completa en una sola comparación estructural (misma fuerza:
    // cada clave se compara con su valor esperado exacto)
    expect({
      entradas: e.entradas,
      miembros: e.miembros,
      procesados: e.procesados,
      auditados: e.auditados,
      noProcesados: e.noProcesados,
      errores: e.errores,
      vertices: e.vertices,
      aristas: e.aristas,
      puntos: e.puntos,
    }).toEqual({
      entradas: 7,
      miembros: 6, // todos declarados en el manifest (A,B,KML,friction,datum,extra)
      procesados: 4, // A + B + KML + friction.tif (FR-5: el campo D12 se DECODIFICA)
      auditados: 1, // datum.prj (friction.tif dejó de ser auditoría — ahora es capa de campo)
      noProcesados: 1, // rol desconocido: extra.xyz
      errores: 0,
      vertices: 3 + 3 + (3 + 5), // arroyo A/B (línea 3 c/u) + KML: arroyo (3) + cerro (anillo 5)
      aristas: 2 + 2 + (2 + 4), // arroyo A/B + KML: arroyo + cerro
      puntos: 0,
    });
    // Auditados con notas honestas (una sola comparación)
    const rows = r.meta.rows;
    expect({
      friction: rows.some((x) => x[0].includes('friction.tif') && x[1].includes('D12')), // nota FR-5: campo decodificado (D12)
      datum: rows.some((x) => x[0] === 'datum:datum.prj'),
    }).toEqual({ friction: true, datum: true });
  });

  test('cruce triangular: A(UTM)↔B(grados)↔KML ⇒ MATCH, ok=true', () => {
    const bytes = new Uint8Array(buildZip(goldenInputs()));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR)!;
    const e = r.meta.entities as Record<string, number>;
    expect({
      match: e.crucesMATCH,
      diverge: e.crucesDIVERGE,
      sinPar: e.crucesSinPar,
      metaDiverge: r.meta.diverge,
    }).toEqual({ match: 3, diverge: 0, sinPar: 2, metaDiverge: false }); // arroyo en los 3 pares; cerro solo en KML
  });

  test('identidad GeoJSON UTM: BBox convertido a WGS84 canónico', () => {
    const ident = geojsonIdentity(A_GEOJSON_UTM)!;
    expect({ n: ident.length, uuid: ident[0].uuid, kind: ident[0].kind }).toEqual({
      n: 1,
      uuid: UUID_ARROYO,
      kind: 'linea',
    });
    // El BBox debe estar en grados (no en metros UTM): lon ≈ -101.35, lat ≈ 21.0
    expect({
      lonOk: Math.abs(ident[0].bbox.lonMin - -101.35) < 1e-5,
      latOk: Math.abs(ident[0].bbox.latMin - 21.0) < 1e-5,
    }).toEqual({ lonOk: true, latOk: true });
  });

  test('identidad KML: cerro como poligono y arroyo como linea', () => {
    const ident = parseKmlIdentity(KML_RUTAS)!;
    const byUuid = new Map(ident.map((f) => [f.uuid, f]));
    expect({ n: ident.length, arroyo: byUuid.get(UUID_ARROYO)!.kind, cerro: byUuid.get(UUID_CERRO)!.kind }).toEqual({
      n: 2,
      arroyo: 'linea',
      cerro: 'poligono',
    });
  });

  test('determinismo byte-exacto del parseo completo', () => {
    const mk = (): ArrayBuffer => {
      const bytes = new Uint8Array(buildZip(goldenInputs()));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    };
    const a = parseMissionPack(mk(), ANCHOR)!;
    const b = parseMissionPack(mk(), ANCHOR)!;
    expect({
      rows: a.meta.rows,
      verts: Buffer.from(a.geom!.verts.buffer).equals(Buffer.from(b.geom!.verts.buffer)),
    }).toEqual({ rows: b.meta.rows, verts: true });
  });

  test('custodia: SHA-256 del pack completo en meta.custody (verificable externamente)', () => {
    const bytes = new Uint8Array(buildZip(goldenInputs()));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR)!;
    const custody = (r.meta as { custody?: string }).custody ?? '';
    const expected = sha256HexBytes(bytes);
    // Una sola comparación estructural: prefijo, digest real y fila H-1
    expect({
      prefix: custody.includes('pack sha256:'),
      digest: custody.includes(expected),
      h1row: r.meta.rows.some((x) => x[0] === 'Manifest digest (H-1)'),
    }).toEqual({ prefix: true, digest: true, h1row: true });
  });

  test('H-1: regenerar el manifest con otra marca de tiempo ⇒ mismo digest', () => {
    const bytes1 = new Uint8Array(buildZip(goldenInputs()));
    const buf1 = bytes1.buffer.slice(bytes1.byteOffset, bytes1.byteOffset + bytes1.byteLength) as ArrayBuffer;
    const r1 = parseMissionPack(buf1, ANCHOR)!;
    const inputs2 = goldenInputs();
    inputs2[0] = { name: 'manifest.json', data: makeManifest({ generado: '2099-12-31T23:59:59Z' }) };
    const bytes2 = new Uint8Array(buildZip(inputs2));
    const buf2 = bytes2.buffer.slice(bytes2.byteOffset, bytes2.byteOffset + bytes2.byteLength) as ArrayBuffer;
    const r2 = parseMissionPack(buf2, ANCHOR)!;
    const d1 = r1.meta.rows.find((x) => x[0] === 'Manifest digest (H-1)')![1];
    const d2 = r2.meta.rows.find((x) => x[0] === 'Manifest digest (H-1)')![1];
    expect(d1).toBe(d2);
    // ...pero el SHA del pack completo SÍ cambia (los bytes son distintos)
    const c1 = (r1.meta as { custody?: string }).custody ?? '';
    const c2 = (r2.meta as { custody?: string }).custody ?? '';
    expect(c1).not.toBe(c2);
  });

  test('H-1: manifest con miembros distintos ⇒ digest distinto', () => {
    const m1 = makeManifest();
    const m2 = makeManifest({ extraMiembro: { role: 'A', path: 'a2.geojson' } });
    const c1 = sha256HexBytes(m1);
    const c2 = sha256HexBytes(m2);
    expect(c1).not.toBe(c2);
    void c1;
    void c2;
    const bytes1 = new Uint8Array(buildZip([{ name: 'manifest.json', data: m1 }, { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 }]));
    const buf1 = bytes1.buffer.slice(bytes1.byteOffset, bytes1.byteOffset + bytes1.byteLength) as ArrayBuffer;
    const r1 = parseMissionPack(buf1, ANCHOR)!;
    const bytes2 = new Uint8Array(buildZip([{ name: 'manifest.json', data: m2 }, { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 }]));
    const buf2 = bytes2.buffer.slice(bytes2.byteOffset, bytes2.byteOffset + bytes2.byteLength) as ArrayBuffer;
    const r2 = parseMissionPack(buf2, ANCHOR)!;
    expect(r1.meta.rows.find((x) => x[0] === 'Manifest digest (H-1)')![1]).not.toBe(
      r2.meta.rows.find((x) => x[0] === 'Manifest digest (H-1)')![1]
    );
  });

  test('miembro GeoJSON fracturado ⇒ error honesto del miembro, el pack sigue', () => {
    const inputs: ZipIn[] = [
      { name: 'manifest.json', data: makeManifest() },
      { name: 'a.geojson', data: new TextEncoder().encode('{ fracturado') },
      { name: 'b.geojson', data: new TextEncoder().encode(B_GEOJSON_DEG) },
      { name: 'rutas.kml', data: new TextEncoder().encode(KML_RUTAS) },
      { name: 'friction.tif', data: FRICTION_TIF_OK }, // decodifica OK — el único error es el GeoJSON fracturado
      { name: 'datum.prj', data: DATUM_WKT },
      { name: 'extra.xyz', data: new Uint8Array([1]) },
    ];
    const bytes = new Uint8Array(buildZip(inputs));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR)!;
    expect((r.meta.entities as Record<string, number>).errores).toBe(1);
    expect(r.meta.rows.some((x) => x[0] === 'A:a.geojson' && x[1].includes('error'))).toBe(true);
  });

  test('DIVERGE: el cerro desplazado en B ⇒ meta.diverge=true con filas de cruce', () => {
    const B_DIVERGE = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { uuid: UUID_CERRO, nombre: 'Cerro movido' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-101.3, 21.05],
                [-101.29, 21.05],
                [-101.29, 21.06],
                [-101.3, 21.06],
                [-101.3, 21.05],
              ],
            ],
          },
        },
      ],
    });
    const inputs: ZipIn[] = [
      { name: 'manifest.json', data: makeManifest() },
      { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
      { name: 'b.geojson', data: new TextEncoder().encode(B_DIVERGE) },
      { name: 'rutas.kml', data: new TextEncoder().encode(KML_RUTAS) },
      { name: 'friction.tif', data: TIFF_STUB },
      { name: 'datum.prj', data: DATUM_WKT },
      { name: 'extra.xyz', data: new Uint8Array([1]) },
    ];
    const bytes = new Uint8Array(buildZip(inputs));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR)!;
    expect(r.meta.diverge).toBe(true);
    const e = r.meta.entities as Record<string, number>;
    expect(e.crucesDIVERGE).toBeGreaterThanOrEqual(1);
    expect(r.meta.rows.some((x) => x[1].startsWith('DIVERGE'))).toBe(true);
  });

  test('CODIFICACION_DISTINTA: B desplazado ~1.7 m ⇒ pase con nota, ok=true', () => {
    const B_CODIF = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { uuid: UUID_ARROYO, nombre: 'Arroyo B' },
          geometry: { type: 'LineString', coordinates: DEG_LINE.map(([lon, lat]) => [lon + 1.8e-5, lat]) },
        },
      ],
    });
    const inputs: ZipIn[] = [
      { name: 'manifest.json', data: makeManifest() },
      { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
      { name: 'b.geojson', data: new TextEncoder().encode(B_CODIF) },
      { name: 'rutas.kml', data: new TextEncoder().encode(KML_RUTAS) },
      { name: 'friction.tif', data: TIFF_STUB },
      { name: 'datum.prj', data: DATUM_WKT },
      { name: 'extra.xyz', data: new Uint8Array([1]) },
    ];
    const bytes = new Uint8Array(buildZip(inputs));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR)!;
    expect(r.meta.diverge).toBe(false);
    const e = r.meta.entities as Record<string, number>;
    expect(e.crucesCodificacion).toBeGreaterThanOrEqual(2); // A↔B y B↔K
    expect(r.meta.rows.some((x) => x[1].startsWith('CODIFICACION_DISTINTA'))).toBe(true);
  });

  test('manifest sin friction.tif ni datum ⇒ solo lo declarado se procesa', () => {
    const inputs: ZipIn[] = [
      { name: 'manifest.json', data: makeManifest({ omitirMiembros: ['friction.tif', 'datum.prj'] }) },
      { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
      { name: 'b.geojson', data: new TextEncoder().encode(B_GEOJSON_DEG) },
      { name: 'rutas.kml', data: new TextEncoder().encode(KML_RUTAS) },
      { name: 'friction.tif', data: TIFF_STUB },
      { name: 'datum.prj', data: DATUM_WKT },
      { name: 'extra.xyz', data: new Uint8Array([1]) },
    ];
    const bytes = new Uint8Array(buildZip(inputs));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR)!;
    const e = r.meta.entities as Record<string, number>;
    expect(e.miembros).toBe(6); // 4 declarados + 2 presentes-no-declarados (honestos)
    // friction.tif y datum.prj quedan como presentes-no-declarados (honestos)
    expect(r.meta.rows.filter((x) => x[1].includes('no declarado en el manifest')).length).toBe(2);
  });

  test('sin ningún miembro con geometría ⇒ null (nada que renderizar)', () => {
    const inputs: ZipIn[] = [
      { name: 'manifest.json', data: makeManifest() },
      { name: 'a.geojson', data: new TextEncoder().encode('{"type":"FeatureCollection","features":[]}') },
      { name: 'b.geojson', data: new TextEncoder().encode('{"type":"FeatureCollection","features":[]}') },
      { name: 'rutas.kml', data: new TextEncoder().encode('<kml xmlns="u"><Document><name>solo</name></Document></kml>') },
      { name: 'friction.tif', data: TIFF_STUB },
      { name: 'datum.prj', data: DATUM_WKT },
      { name: 'extra.xyz', data: new Uint8Array([1]) },
    ];
    const bytes = new Uint8Array(buildZip(inputs));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(parseMissionPack(buf, ANCHOR)).toBeNull();
  });

  test('manifest ausente / fracturado / sin miembros válidos ⇒ null', () => {
    const mk = (manifest: Uint8Array): ArrayBuffer => {
      const bytes = new Uint8Array(buildZip([{ name: 'manifest.json', data: manifest }]));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    };
    expect(parseMissionPack(mk(new TextEncoder().encode('no json')), ANCHOR)).toBeNull();
    expect(parseMissionPack(mk(new TextEncoder().encode('[1,2,3]')), ANCHOR)).toBeNull();
    expect(
      parseMissionPack(mk(new TextEncoder().encode('{"miembros":[{"role":42,"path":"x"}]}')), ANCHOR)
    ).toBeNull();
    // pack sin manifest
    const bytes = new Uint8Array(buildZip([{ name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM) }]));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(parseMissionPack(buf, ANCHOR)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* CATÁLOGO 24 HOSTILES                                               */
/* ------------------------------------------------------------------ */

describe('FR-3 catálogo ZIP 24 hostiles', () => {
  const G = goldenInputs();

  /** Cada entrada: nombre + builder del ZIP hostil. El veredicto esperado
   *  es SIEMPRE rechazo (readZip !ok ⇒ parseMissionPack null). */
  const catalog: Array<[string, () => Uint8Array]> = [
    ['01 EOCD truncado', () => buildZip(G, { truncateTail: 20 })],
    ['02 comment EOCD excede archivo', () => buildZip(G, { commentLenOverride: 0xffff })],
    ['03 cdOffset fuera de límites', () => buildZip(G, { cdOffsetOverride: 0x7ffffff0 })],
    ['04 cdSize excede', () => buildZip(G, { cdSizeOverride: 0x7ffffff0 })],
    ['05 firma del directorio rota', () => {
      const z = buildZip(G);
      const view = new DataView(z.buffer);
      for (let p = 0; p < z.length - 4; p++) {
        if (view.getUint32(p, true) === 0x02014b50) {
          z[p + 1] ^= 0x01; // rompe la firma del primer CD entry
          break;
        }
      }
      return z;
    }],
    ['06 conteo declarado ≠ real', () => buildZip(G, { entriesTotalOverride: 99 })],
    ['07 entradas por disco ≠ total', () => buildZip(G, { entriesThisDiskOverride: 1 })],
    ['08 disco de inicio ≠ 0', () => buildZip(G, { diskStartOverride: 3 })],
    ['09 localizador ZIP64 EOCD64', () => buildZip(G, { appendEocd64Locator: true })],
    ['10 sentinela ZIP64 en entrada (uncompSize)', () => {
      const z = buildZip(G);
      // patch uncomp de la 2ª entrada en el directorio central: buscar sig CD
      const view = new DataView(z.buffer);
      for (let p = 0; p < z.length - 4; p++) {
        if (view.getUint32(p, true) === 0x02014b50) {
          view.setUint32(p + 24, 0xffffffff, true); // uncompSize
          // el segundo CD entry (primer local ya pasó; parcheamos el segundo)
          let found = 0;
          for (let q = p; q < z.length - 4; q++) {
            if (view.getUint32(q, true) === 0x02014b50 && ++found === 2) {
              view.setUint32(q + 24, 0xffffffff, true);
              break;
            }
          }
          break;
        }
      }
      return z;
    }],
    ['11 sentinela ZIP64 en EOCD (cdOffset)', () => {
      const z = buildZip(G);
      const view = new DataView(z.buffer);
      for (let p = z.length - 22; p >= 0; p--) {
        if (view.getUint32(p, true) === 0x06054b50) {
          view.setUint32(p + 14, 0xffffffff, true);
          break;
        }
      }
      return z;
    }],
    ['12 entrada cifrada (bit 0)', () => buildZip(G, { flags: 0x1 })],
    ['13 cifrado fuerte (bit 6)', () => buildZip(G, { flags: 0x40 })],
    ['14 método no soportado (12 bzip2)', () => buildZip(G, { methodOverride: 12 })],
    ['15 cabecera local rota (firma)', () => {
      const z = buildZip(G);
      z[0] = 0x50; z[1] = 0x4b; z[2] = 0x99; z[3] = 0x99;
      return z;
    }],
    ['16 nombre local ≠ central', () => buildZip(G, { breakLocalName: 1 })],
    ['17 tamaños local ≠ central', () => buildZip(G, { mismatchLocalSizes: 1 })],
    ['18 CRC inconsistente (byte de datos alterado)', () => {
      const z = buildZip(G);
      const view = new DataView(z.buffer);
      for (let p = 0; p < z.length - 4; p++) {
        if (view.getUint32(p, true) === 0x04034b50) {
          // primera entrada es manifest.json (stored): corrompe un byte de datos
          const nameLen = view.getUint16(p + 26, true);
          z[p + 30 + nameLen] ^= 0xff;
          break;
        }
      }
      return z;
    }],
    ['19 stream Deflate incompleto (menos de lo declarado)', () => {
      const inputs = goldenInputs();
      const comp = deflateRawSync(inputs[1].data, { level: 6 });
      const truncated = comp.subarray(0, comp.length - 4);
      const z = buildZip([{ ...inputs[1], data: inputs[1].data, method: 8 }]);
      // reconstrucción manual: parchear compSize en local+central+eocd para
      // que la truncación pase los chequeos de longitud y el inflado quede corto
      const full = buildZip(inputs);
      // más simple: build de un pack de 1 entrada con datos truncados
      const one = buildZip([{ name: 'a.geojson', data: new TextEncoder().encode('mision '.repeat(2000)) , method: 8 }]);
      void z; void full; void truncated;
      // truncar el final del archivo NO funciona (rompería EOCD) — parchear
      // compSize a un valor menor que el stream real:
      const view = new DataView(one.buffer);
      for (let p = 0; p < one.length - 4; p++) {
        if (view.getUint32(p, true) === 0x04034b50) {
          const compSize = view.getUint32(p + 18, true);
          view.setUint32(p + 18, compSize - 4, true);
          // y en el directorio central
          for (let q = p; q < one.length - 4; q++) {
            if (view.getUint32(q, true) === 0x02014b50) {
              view.setUint32(q + 20, compSize - 4, true);
              break;
            }
          }
          // y el cdSize/eocdOffset se ajustan solos porque las estructuras
          // no cambian de tamaño — OK
          break;
        }
      }
      return one;
    }],
    ['20 bomba real (stream produce más que lo declarado)', () => {
      // declara uncompSize menor (coherente local/central) ⇒ inflate excede cap
      const inputs = [goldenInputs()[1]]; // a.geojson deflate
      const one = buildZip(inputs);
      const view = new DataView(one.buffer);
      for (let p = 0; p < one.length - 4; p++) {
        if (view.getUint32(p, true) === 0x04034b50) {
          const realUncomp = view.getUint32(p + 22, true);
          const lie = realUncomp - 100;
          view.setUint32(p + 22, lie, true); // local uncomp
          for (let q = p; q < one.length - 4; q++) {
            if (view.getUint32(q, true) === 0x02014b50) {
              view.setUint32(q + 24, lie, true); // central uncomp
              break;
            }
          }
          break;
        }
      }
      return one;
    }],
    ['21 bomba declarada (uncompSize > presupuesto por entrada)', () => {
      const one = buildZip([{ name: 'gigante.bin', data: new Uint8Array([1, 2, 3, 4]) }]);
      const view = new DataView(one.buffer);
      for (let p = 0; p < one.length - 4; p++) {
        if (view.getUint32(p, true) === 0x02014b50) {
          view.setUint32(p + 24, MAX_ENTRY_BYTES + 1, true); // central uncomp
          break;
        }
      }
      return one;
    }],
    ['22 zip-slip ../evil.txt', () =>
      buildZip([{ name: '../evil.txt', data: new Uint8Array([1]) }, { name: 'manifest.json', data: makeManifest() }])],
    ['23 ruta absoluta /etc/x.txt', () =>
      buildZip([{ name: '/etc/x.txt', data: new Uint8Array([1]) }, { name: 'manifest.json', data: makeManifest() }])],
    ['24 letra de unidad C:\\x.txt', () =>
      buildZip([{ name: 'C:\\x.txt', data: new Uint8Array([1]) }, { name: 'manifest.json', data: makeManifest() }])],
  ];

  test('el catálogo declara exactamente 24 entradas (control de tabla)', () => {
    expect(catalog.length).toBe(24);
  });

  // Granularidad del linaje aceptado: UN test por hostil — cada entrada
  // verifica el contrato completo (readZip rechaza con causa · parse ⇒ null).
  for (const [name, build] of catalog) {
    test(`hostil ${name} ⇒ rechazo con causa y parse null`, () => {
      const bytes = build();
      const zip = readZip(bytes);
      expect({ ok: zip.ok, reason: zip.ok ? '' : zip.reason.length > 0 }).toEqual({ ok: false, reason: true });
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      expect(parseMissionPack(buf, ANCHOR)).toBeNull();
    });
  }

  test('stored conocido: el manifest.json guardado sin comprimir se recupera byte-exacto', () => {
    const m = makeManifest();
    const bytes = new Uint8Array(buildZip([{ name: 'manifest.json', data: m }]));
    const zip = readZip(bytes);
    expect(
      zip.ok && zip.entries.length === 1 && Buffer.from(zip.entries[0].data).equals(Buffer.from(m))
    ).toBe(true);
  });

  test('UUID dorado: B con llaves y mayúsculas converge al canónico ⇒ triángulo MATCH', () => {
    // El mismo UUID de tierra en TRES codificaciones sintácticas distintas:
    // A minúsculas plano · B con llaves+mayúsculas · KML con urn:uuid
    const UUID_LANZ = `{${UUID_ARROYO.toUpperCase()}}`;
    const B_GOLD = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { uuid: UUID_LANZ, nombre: 'Arroyo B (llaves)' },
          geometry: { type: 'LineString', coordinates: DEG_LINE },
        },
      ],
    });
    const KML_GOLD = KML_RUTAS.replace(`id="${UUID_ARROYO}"`, `id="urn:uuid:${UUID_ARROYO.toUpperCase()}"`);
    const inputs: ZipIn[] = [
      { name: 'manifest.json', data: makeManifest() },
      { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
      { name: 'b.geojson', data: new TextEncoder().encode(B_GOLD) },
      { name: 'rutas.kml', data: new TextEncoder().encode(KML_GOLD) },
      { name: 'friction.tif', data: TIFF_STUB },
      { name: 'datum.prj', data: DATUM_WKT },
      { name: 'extra.xyz', data: new Uint8Array([1]) },
    ];
    const bytes = new Uint8Array(buildZip(inputs));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = parseMissionPack(buf, ANCHOR)!;
    const e = r.meta.entities as Record<string, number>;
    expect({ match: e.crucesMATCH, diverge: e.crucesDIVERGE }).toEqual({ match: 3, diverge: 0 });
  });

  // Público: el manifiesto DOCS es artefacto de la bóveda interna — se omite si no viaja (conteo honesto)
  test.skipIf(!existsSync('downloads/DOCS_MANIFIESTO_SHA256.txt'))('H-2: manifiesto de docs — cada entrada SHA-256 del disco cuadra (integridad de gobernanza)', () => {
    const raw = readFileSync('downloads/DOCS_MANIFIESTO_SHA256.txt', 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    let bad = 0;
    for (const line of lines) {
      const [hash, ...rest] = line.split(/\s+/);
      const file = rest.join(' ').replace(/^\*/, '');
      try {
        const h = createHash('sha256').update(readFileSync(file)).digest('hex');
        if (h !== hash.toLowerCase()) bad++;
      } catch {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  test('H-3: bitácora no silenciosa — custodia antepuesta y fallo visible en consola (pin estático)', () => {
    const src = readFileSync('src/components/terrain/ingest.ts', 'utf8');
    const iCustody = src.indexOf('f.meta?.custody');
    const iWarn = src.indexOf("'[ingest] bitácora no registrada:'");
    expect({ custody: iCustody > -1, warn: iWarn > -1, orden: iCustody < iWarn }).toEqual({
      custody: true,
      warn: true,
      orden: true,
    });
  });

  test('hostiles extra del catálogo extendido: duplicado, solapamiento, NUL, nombre largo, método local≠central', () => {
    const dup = new Uint8Array(buildZip(goldenInputs(), { duplicateName: true }));
    expect(readZip(dup).ok).toBe(false);

    // Solapamiento: segunda entrada apuntando al local de la primera
    const G2 = goldenInputs();
    const overlap = buildZip(G2, { localOffsetOverride: [0, 0, 0, 0, 0, 0, 0] });
    expect(readZip(overlap).ok).toBe(false);

    const nul = new Uint8Array(buildZip([{ name: 'ma\x00nifest.json', data: makeManifest() }]));
    expect(readZip(nul).ok).toBe(false);

    const longName = 'x'.repeat(600) + '.json';
    const largo = new Uint8Array(buildZip([{ name: longName, data: makeManifest() }]));
    expect(readZip(largo).ok).toBe(false);

    // método local ≠ central: método override solo afecta a central? No —
    // buildZip aplica methodOverride a ambos; simulamos con mutación:
    const mmb = buildZip(goldenInputs());
    const view = new DataView(mmb.buffer);
    let cdSeen = 0;
    for (let p = 0; p < mmb.length - 4; p++) {
      if (view.getUint32(p, true) === 0x02014b50) {
        if (++cdSeen === 2) {
          view.setUint16(p + 10, 12, true); // central method 12
          break;
        }
      }
    }
    expect(readZip(mmb).ok).toBe(false);
  });

  test('stored con compSize ≠ uncompSize ⇒ hostil', () => {
    const one = buildZip([{ name: 'x.txt', data: new Uint8Array([1, 2, 3]) }]);
    const view = new DataView(one.buffer);
    for (let p = 0; p < one.length - 4; p++) {
      if (view.getUint32(p, true) === 0x02014b50) {
        view.setUint32(p + 20, 2, true); // compSize central = 2 (stored ≠ uncomp 3)
        break;
      }
    }
    expect(readZip(one).ok).toBe(false);
  });

  test('bytes aleatorios ⇒ rechazo limpio (no es ZIP)', () => {
    const ruido = new Uint8Array(4096);
    let s = 424242;
    for (let i = 0; i < ruido.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      ruido[i] = s & 0xff;
    }
    expect(readZip(ruido).ok).toBe(false);
    const buf = ruido.buffer.slice(ruido.byteOffset, ruido.byteOffset + ruido.byteLength) as ArrayBuffer;
    expect(parseMissionPack(buf, ANCHOR)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* FR-4 v1.1 defensiva — miembros del manifest route_class/confidence */
/* (checkpoint ): lectura tolerante a alias,    */
/* inválidos ⇒ ignorados (= ausente, defaults). Emisión v1.0 (REQ-10). */
/* ------------------------------------------------------------------ */
describe('FR-4 v1.1 defensiva — miembros del manifest (route_class/confidence)', () => {
  const manifestV11 = (miembro: object): ZipIn[] => [
    {
      name: 'manifest.json',
      data: new TextEncoder().encode(
        JSON.stringify({
          version: '1.0.0',
          mision: 'soledad-sintetica',
          generado: '2026-09-27T00:00:00Z',
          miembros: [miembro, { role: 'B', path: 'b.geojson' }, { role: 'KML', path: 'rutas.kml' }],
        })
      ),
    },
    { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
    { name: 'b.geojson', data: new TextEncoder().encode(B_GEOJSON_DEG) },
    { name: 'rutas.kml', data: new TextEncoder().encode(KML_RUTAS), method: 8 },
  ];
  const parse = (inputs: ZipIn[]): ReturnType<typeof parseMissionPack> => {
    const bytes = new Uint8Array(buildZip(inputs));
    return parseMissionPack(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ANCHOR
    );
  };

  test('member con routeClass/confidence ⇒ meta (primero que declara)', () => {
    const r = parse(manifestV11({ role: 'A', path: 'a.geojson', routeClass: 'emergencia', confidence: 35 }));
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.routeClass).toBe('emergencia');
    expect(r.meta.confidence).toBe(35);
  });

  test('alias route_class/rutaClase tolerados; confidence numérica como string; inválida ignorada', () => {
    const r1 = parse(manifestV11({ role: 'A', path: 'a.geojson', route_class: 'secundaria', confianza: '80' }));
    expect(r1?.meta.routeClass).toBe('secundaria');
    expect(r1?.meta.confidence).toBe(80);
    const r2 = parse(manifestV11({ role: 'A', path: 'a.geojson', rutaClase: 'primaria', confidence: 'alto' }));
    expect(r2?.meta.routeClass).toBe('primaria');
    expect(r2?.meta.confidence).toBeUndefined();
    const r3 = parse(manifestV11({ role: 'A', path: 'a.geojson', confidence: 150 }));
    expect(r3?.meta.confidence).toBeUndefined();
  });

  test('miembro v1.0 (sin attrs) ⇒ meta sin routeClass/confidence (retrocompat byte-idéntica)', () => {
    const r = parse(goldenInputs());
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.routeClass).toBeUndefined();
    expect(r.meta.confidence).toBeUndefined();
  });
});
