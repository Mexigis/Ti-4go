/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PARIDAD WORKER/SYNC — cierre de la clase «el fallback enmascara al primario».
 *
 * Clase de bugs ratificada por el propietario ():
 *   1. Task 9 — DataCloneError: el forense sync pasaba y el navegador
 *      (canal worker) fallaba.
 *   2. E2E dorado air-gap (commit 10c30a2) — ingest.worker no propagaba
 *      result.field del pack: el rol FRICTION* quedaba silenciado vía
 *      worker y solo vivía en el fallback sync (por eso el forense pasaba
 *      y el lienzo del navegador perdía la capa D12). FIX: `field = field
 *      ?? result.field`.
 *
 * Patrón común de la clase: cuando el canal PRIMARIO (worker) diverge del
 * canal de respaldo (parseSync/parseFile) y la suite solo mira al segundo,
 * el fallback ENMASCARA el bug en pruebas y lo revela el terreno. Este
 * forense ataca la clase de raíz: payload del worker ≡ esquema de parseSync,
 * PARAMÉTRICO POR CAMPO sobre fixtures deterministas.
 *
 *   sync   ParseResult                     = { meta, geom, field?, geoid? }
 *   worker IngestWorkerResponse «done ok»  = { fileId, type, ok, meta,
 *          geom, dem?, demError?, field?, geoid? }
 *
 * Invariantes:
 *   P0 INSTRUMENTO — el worker contesta en-proceso (shim postMessage/
 *      onmessage en globalThis; el módulo registra ctx.onmessage = self).
 *   P1 ESQUEMA — keys(parseFile(·)) ⊆ CAMPOS_SYNC: un campo NUEVO en
 *      ParseResult sin asiento en la tabla ⇒ rojo hasta cablearlo al worker
 *      y sentarlo en el esquema. La tabla es el cierre de la clase.
 *   P2 PARIDAD — matriz fixture×campo: sync definido ⇒ worker definido e
 *      igual (meta: núcleo igual + rows de sync como PREFIJO — el worker
 *      añade filas de decodificación, jamás muta las del parseo; geom/
 *      field: elemento a elemento). sync no definido ⇒ worker tampoco
 *      (salvo el enriquecimiento DOCUMENTADO del fricc suelto).
 *   P3 ENVELOPE — nada fuera de la envolvente done-ok; extras ⊆ {dem,
 *      demError} (Task 18/D12) con exclusividad dem XOR demError; field
 *      presente exactamente donde el contrato lo declara; progress con
 *      su envolvente propia.
 *   P4 REGRESIÓN — el bug histórico exacto: pack MXP1 con rol FRICTION*
 *      ⇒ worker.field definido y ≡ sync.field (FrictionField completo).
 *
 * HALLAZGO registrado (divergencia documentada, NO bug de esta suite):
 * el fallback sync del controller (IngestController.parseSync) NO decodifica
 * DEM ni fricc suelto — el worker SÍ. Dirección SEGURA (el primario aporta
 * MÁS). La dirección PELIGROSA (fallback aporta más que el primario) es la
 * que P1+P2 vuelven imposible de aquí en adelante.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/lib/ingest/zip';
import { wgs84ToUtm14n } from '../src/lib/ingest/geojson';
import { parseFile } from '../src/lib/ingest/parsers';
import type { Anchor, IngestMeta } from '../src/lib/ingest/parsers';
import type { FrictionField } from '../src/lib/ingest/friction';
import type { IngestWorkerResponse } from '../src/components/terrain/ingest.worker';
import { buildVectorpackZip } from './helpers_vectorpack';

type DoneOk = Extract<IngestWorkerResponse, { type: 'done'; ok: true }>;
type Cualquiera = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* ESQUEMA de la paridad — el asiento de la clase                      */
/* ------------------------------------------------------------------ */

/** Campos del esquema SYNC (ParseResult, parsers.ts). Si parseFile gana
 *  un campo nuevo y no se sienta aquí, P1 se pone roja en TODOS los
 *  fixtures — el autor debe cablearlo al worker y declararlo.
 *  FR-7 · GGM25: «geoid» entró por la puerta grande — la unidad geoid.ts
 *  (ratificación D-1, ) lo cableó al worker con
 *  `geoid = geoid ?? result.geoid` y sentó esta fila ANTES del gate. */
const CAMPOS_SYNC = ['meta', 'geom', 'field', 'geoid'] as const;

/** Envolvente «done ok» del worker (ingest.worker.ts). Nada fuera. */
const ENVOLVENTE_DONE_OK = [
  'fileId', 'type', 'ok', 'meta', 'geom', 'dem', 'demError', 'demName', 'field', 'geoid',
] as const;

/** Extras del worker FUERA del esquema sync, con asiento documentado:
 *  dem/demError = Motor DEM Real (Task 18) — solo vía worker.
 *  demName = Unidad RECORTADOR (transplante inverso, trace
 *  ) — nombre del .tif extraído del ZIP topográfico
 *  ('demzip'); nombre preferente del DEM en el store. Solo vía worker. */
const EXTRAS_DOCUMENTADOS = ['dem', 'demError', 'demName'] as const;

/* ------------------------------------------------------------------ */
/* Fixtures deterministas (mínimo autocontenido; los generadores son   */
/* versión fiel de los de forense_pack.test.ts — known-good)           */
/* ------------------------------------------------------------------ */

const ANCHOR: Anchor = {
  extentM: 8000,
  zMinM: 1950,
  zMaxM: 2600,
  centerLat: 21.0,
  centerLon: -101.33,
  regionName: 'prueba-paridad',
};

interface ZipIn {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
}

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

const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const u32 = (v: number): Uint8Array =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

/** Escritor ZIP mínimo (PKZIP 2.0) — solo lo que el lector de packs exige. */
function buildZip(inputs: ZipIn[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const offsets: number[] = [];
  let off = 0;
  const enc = new TextEncoder();
  for (const inp of inputs) {
    const method = inp.method ?? 0;
    const flags = 0x800; // UTF-8 (como el escritor de forense_pack)
    const crc = crc32(inp.data);
    const data = method === 8 ? deflateRawSync(inp.data) : inp.data;
    offsets.push(off);
    const nameB = enc.encode(inp.name);
    const local = cat([
      u32(0x04034b50), u16(20), u16(flags), u16(method),
      u16(0), u16(0), u32(crc), u32(data.length), u32(inp.data.length),
      u16(nameB.length), u16(0), nameB, data,
    ]);
    chunks.push(local);
    central.push(cat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method),
      u16(0), u16(0), u32(crc), u32(data.length), u32(inp.data.length),
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

/* --- builder TIFF sintético LE (copia fiel del de forense_pack) ----- */

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
  const raw = new Uint8Array(new Float64Array(data).buffer);
  const raster = compression === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;

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
    { tag: 277, type: TT.SHORT, count: 1, value: 1 },
    { tag: 273, type: TT.LONG, count: 1, value: 0 }, // StripOffsets — parcheado
    { tag: 278, type: TT.LONG, count: 1, value: h },
    { tag: 279, type: TT.LONG, count: 1, value: raster.length },
    { tag: 284, type: TT.SHORT, count: 1, value: 1 },
    { tag: 339, type: TT.SHORT, count: 1, value: 3 },
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
  u8[0] = 0x49;
  u8[1] = 0x49; // 'II'
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

/* --- golden pack (roles A/B/KML/FRICTION/datum/desconocido) --------- */

const UUID_ARROYO = 'a0b1c2d3-1111-4222-8333-444455556666';
const UUID_CERRO = 'b1b2c3d4-2222-4333-8444-555566667777';

const DEG_LINE: Array<[number, number]> = [
  [-101.35, 21.0],
  [-101.34, 21.01],
  [-101.33, 21.02],
];

function degToUtm(lon: number, lat: number): [number, number] {
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

const DATUM_WKT = new TextEncoder().encode(
  'PROJCS["WGS 84 / UTM zone 14N",GEOGCS["WGS 84",DATUM["WGS_1984"]],PROJECTION["Transverse_Mercator"]]'
);

function makeManifest(): Uint8Array {
  const miembros: Array<{ role: string; path: string; layerType?: string }> = [
    { role: 'A', path: 'a.geojson', layerType: 'vector' },
    { role: 'B', path: 'b.geojson' },
    { role: 'KML', path: 'rutas.kml' },
    { role: 'friction.tif', path: 'friction.tif' },
    { role: 'datum', path: 'datum.prj' },
    { role: 'capa-desconocida', path: 'extra.xyz' },
  ];
  return new TextEncoder().encode(
    JSON.stringify({
      version: '1.0.0',
      mision: 'soledad-sintetica',
      generado: '2026-09-27T00:00:00Z',
      miembros,
    })
  );
}

function goldenInputs(): ZipIn[] {
  return [
    { name: 'manifest.json', data: makeManifest() },
    { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
    { name: 'b.geojson', data: new TextEncoder().encode(B_GEOJSON_DEG) },
    { name: 'rutas.kml', data: new TextEncoder().encode(KML_RUTAS), method: 8 },
    { name: 'friction.tif', data: new Uint8Array(FRICC_TIF) }, // campo D12 REAL
    { name: 'datum.prj', data: DATUM_WKT },
    { name: 'extra.xyz', data: new Uint8Array([1, 2, 3]) },
  ];
}

function abOf(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const FRICC_TIF = buildTiff({ w: 4, h: 4, data: FRICTION_FIELD_4X4, scaleX: 10, scaleY: 10 });
const PACK_BYTES = buildZip(goldenInputs());

/** FR-7 · GGM25: rejilla sintética 6×5 determinista (v = i*10 − j*7,
 *  enteros exactos en Float32) + HDR fiel al formato Esri BIL + PRJ con
 *  el WKT PÚBLICO del modelo real (metadato, no dato de misión — W1 OK). */
const GEOID_W = 6;
const GEOID_H = 5;
const GEOID_ULX = -101.35;
const GEOID_ULY = 21.1;
const GEOID_DX = 0.01666666666;

const GEOID_GRID = (() => {
  const d = new Float32Array(GEOID_W * GEOID_H);
  for (let j = 0; j < GEOID_H; j++)
    for (let i = 0; i < GEOID_W; i++) d[j * GEOID_W + i] = i * 10 - j * 7;
  return d;
})();

const GEOID_HDR_TEXT = [
  'BYTEORDER      I',
  'LAYOUT         BIL',
  `NROWS          ${GEOID_H}`,
  `NCOLS          ${GEOID_W}`,
  'NBANDS         1',
  'NBITS          32',
  'BANDROWBYTES   24',
  'TOTALROWBYTES  24',
  'PIXELTYPE      FLOAT',
  `ULXMAP         ${GEOID_ULX}`,
  `ULYMAP         ${GEOID_ULY}`,
  `XDIM           ${GEOID_DX}`,
  `YDIM           ${GEOID_DX}`,
  'NODATA         -9999',
  '',
].join('\n');

const GEOID_PRJ_TEXT =
  'GEOGCS["GCS_GRS_1980",DATUM["D_GRS_1980",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

function makeGeoidManifest(): Uint8Array {
  const miembros: Array<{ role: string; path: string }> = [
    { role: 'A', path: 'a.geojson' },
    { role: 'GEOID-HDR', path: 'geoid.hdr' },
    { role: 'GEOID-BIL', path: 'geoid.bil' },
    { role: 'GEOID-PRJ', path: 'geoid.prj' },
  ];
  return new TextEncoder().encode(
    JSON.stringify({
      version: '1.0.0',
      mision: 'soledad-con-datum',
      generado: '2026-10-01T00:00:00Z',
      miembros,
    })
  );
}

const PACK_GEOID_BYTES = buildZip([
  { name: 'manifest.json', data: makeGeoidManifest() },
  { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON_UTM), method: 8 },
  { name: 'geoid.hdr', data: new TextEncoder().encode(GEOID_HDR_TEXT) },
  { name: 'geoid.bil', data: new Uint8Array(GEOID_GRID.buffer.slice(0)) },
  { name: 'geoid.prj', data: new TextEncoder().encode(GEOID_PRJ_TEXT) },
]);

/* ------------------------------------------------------------------ */
/* Matriz de fixtures — cada entrada declara su contrato de presencia  */
/* ------------------------------------------------------------------ */

interface Fixture {
  id: string;
  nombre: string;
  name: string;
  buf: ArrayBuffer;
  /** field presente en el payload del worker (contrato declarado). */
  fieldEsperado: boolean;
  /** dem presente en el payload del worker (Motor DEM Real, Task 18). */
  demEsperado: boolean;
  /** geoid presente en el payload del worker (FR-7 · GGM25). */
  geoidEsperado: boolean;
}

const FIXTURES: Fixture[] = [
  {
    id: 'pack-mxp1',
    nombre: 'pack MXP1 golden — rol FRICTION* DENTRO (clase del bug)',
    name: 'mision.zip',
    buf: abOf(PACK_BYTES),
    fieldEsperado: true,
    demEsperado: false,
    geoidEsperado: false,
  },
  {
    id: 'fricc-suelto',
    nombre: 'fricc suelto — enriquecimiento D12 SOLO vía worker',
    name: 'friction.tif',
    buf: FRICC_TIF,
    fieldEsperado: true,
    demEsperado: false,
    geoidEsperado: false,
  },
  {
    id: 'dem-suelto',
    nombre: 'DEM suelto — decodificación Task 18 solo vía worker',
    name: 'elevacion.tif',
    buf: FRICC_TIF,
    fieldEsperado: false,
    demEsperado: true,
    geoidEsperado: false,
  },
  {
    id: 'geojson',
    nombre: 'GeoJSON UTM 14N — sin extras de ningún tipo',
    name: 'a.geojson',
    buf: abOf(new TextEncoder().encode(A_GEOJSON_UTM)),
    fieldEsperado: false,
    demEsperado: false,
    geoidEsperado: false,
  },
  {
    id: 'pack-geoid',
    nombre: 'pack con roles GEOID-* — datum vertical en el esquema (FR-7)',
    name: 'mision-geoid.zip',
    buf: abOf(PACK_GEOID_BYTES),
    fieldEsperado: false,
    demEsperado: false,
    geoidEsperado: true,
  },
  {
    id: 'vectorpack',
    nombre: 'EX-vectorial — shapefile UTM 14N en ZIP (meta+geom, sin extras)',
    name: 'carreteras.zip',
    buf: abOf(buildVectorpackZip()),
    fieldEsperado: false,
    demEsperado: false,
    geoidEsperado: false,
  },
];

/* ------------------------------------------------------------------ */
/* Comparadores de igualdad (deep, con TypedArray elemento a elemento) */
/* ------------------------------------------------------------------ */

type VistaNumerica = { length: number; constructor: { name: string } } & ArrayLike<number>;

function deepEqValores(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const va = a as unknown as VistaNumerica;
    const vb = b as unknown as VistaNumerica;
    if (va.constructor.name !== vb.constructor.name || va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) if (!Object.is(va[i], vb[i])) return false;
    return true;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqValores(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Cualquiera);
    const kb = Object.keys(b as Cualquiera);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!deepEqValores((a as Cualquiera)[k], (b as Cualquiera)[k])) return false;
    }
    return true;
  }
  return false;
}

/** Paridad de meta: núcleo (todas las claves de sync fuera de rows) IGUAL,
 *  rows de sync como PREFIJO de las del worker (el worker AÑADE filas de
 *  decodificación al final — jamás muta las del parseo). */
function metaParity(syncMeta: IngestMeta, workerMeta: IngestMeta): void {
  const sa = syncMeta as unknown as Cualquiera;
  const wb = workerMeta as unknown as Cualquiera;
  for (const k of Object.keys(sa)) {
    if (k === 'rows') continue;
    expect(deepEqValores(sa[k], wb[k])).toBe(true);
  }
  expect(workerMeta.rows.length).toBeGreaterThanOrEqual(syncMeta.rows.length);
  for (let i = 0; i < syncMeta.rows.length; i++) {
    expect(deepEqValores(workerMeta.rows[i], syncMeta.rows[i])).toBe(true);
  }
}

/** Paridad de FrictionField — el campo exacto de la clase del bug. */
function friccEq(a: FrictionField, b: FrictionField): void {
  expect(b.w).toBe(a.w);
  expect(b.h).toBe(a.h);
  expect(b.vmin).toBe(a.vmin);
  expect(b.vmax).toBe(a.vmax);
  expect(b.nodata).toBe(a.nodata);
  expect(b.scaleX).toBe(a.scaleX);
  expect(b.scaleY).toBe(a.scaleY);
  expect(b.tieX).toBe(a.tieX);
  expect(b.tieY).toBe(a.tieY);
  expect(b.sampleLabel).toBe(a.sampleLabel);
  expect(b.compression).toBe(a.compression);
  expect(b.classCounts).toEqual(a.classCounts);
  expect(deepEqValores(a.crs, b.crs)).toBe(true);
  expect(deepEqValores(a.data, b.data)).toBe(true);
  expect(deepEqValores(a.classes, b.classes)).toBe(true);
}

/* ------------------------------------------------------------------ */
/* Harness: el worker EN-PROCESO (shim postMessage/onmessage)          */
/* ------------------------------------------------------------------ */

let capturadas: Cualquiera[] = [];
let postOriginal: unknown;
let onmsgOriginal: unknown;

beforeAll(async () => {
  postOriginal = (globalThis as unknown as Cualquiera).postMessage;
  onmsgOriginal = (globalThis as unknown as Cualquiera).onmessage;
  (globalThis as unknown as Cualquiera).postMessage = (msg: unknown) => {
    capturadas.push(msg as Cualquiera);
  };
  /* Import EN TIEMPO de test: el módulo registra ctx.onmessage sobre
     self (= globalThis en bun) — exactamente el protocolo del navegador. */
  await import('../src/components/terrain/ingest.worker');
});

afterAll(() => {
  (globalThis as unknown as Cualquiera).postMessage = postOriginal;
  (globalThis as unknown as Cualquiera).onmessage = onmsgOriginal;
});

async function runWorker(
  name: string,
  buf: ArrayBuffer
): Promise<{ done: DoneOk; progreso: Cualquiera[] }> {
  capturadas = [];
  const req = { id: 1, fileId: 7, name, size: buf.byteLength, buf, anchor: ANCHOR };
  const h = (globalThis as unknown as Cualquiera).onmessage;
  if (typeof h !== 'function') throw new Error('P0: el worker no registró ctx.onmessage');
  h({ data: req });
  const t0 = Date.now();
  for (;;) {
    const done = capturadas.find((m) => m['type'] === 'done' && m['fileId'] === 7) as
      | DoneOk
      | undefined;
    if (done) {
      return {
        done,
        progreso: capturadas.filter((m) => m['type'] === 'progress'),
      };
    }
    if (Date.now() - t0 > 5000) throw new Error('P0: worker sin «done» en 5 s');
    await Bun.sleep(2);
  }
}

/* ------------------------------------------------------------------ */
/* LA SUITE                                                            */
/* ------------------------------------------------------------------ */

describe('Paridad worker/sync — cierre de clase «el fallback enmascara al primario»', () => {
  test('P0 — instrumento: worker registrado en globalThis y responde done', async () => {
    const { done } = await runWorker('a.geojson', FIXTURES[3].buf);
    expect(done.ok).toBe(true);
    expect(done.meta.format).toBe('geojson');
  });

  for (const fx of FIXTURES) {
    describe(`fixture ${fx.id} — ${fx.nombre}`, () => {
      test('P1 — keys(parseFile) ⊆ CAMPOS_SYNC (sin campo huérfano sin asiento)', () => {
        const sync = parseFile(fx.name, fx.buf, ANCHOR);
        for (const k of Object.keys(sync)) {
          expect((CAMPOS_SYNC as readonly string[]).includes(k)).toBe(true);
        }
        expect(Object.keys(sync).length).toBeGreaterThan(0);
      });

      for (const campo of CAMPOS_SYNC) {
        test(`P2 — campo «${campo}»: sync ≡ worker`, async () => {
          const sync = parseFile(fx.name, fx.buf, ANCHOR);
          const { done } = await runWorker(fx.name, fx.buf);
          expect(done.ok).toBe(true);
          const sv = (sync as unknown as Cualquiera)[campo];
          const wv = (done as unknown as Cualquiera)[campo];
          if (sv === undefined) {
            if (campo === 'field' && fx.id === 'fricc-suelto') {
              /* Divergencia DOCUMENTADA (dirección segura): el worker
                 enriquece el fricc suelto que el fallback no decodifica. */
              expect(wv).toBeDefined();
            } else {
              expect(wv ?? null).toBeNull(); // el worker no inventa campos
            }
            return;
          }
          expect(wv).toBeDefined();
          if (campo === 'meta') {
            metaParity(sv as IngestMeta, wv as IngestMeta);
          } else {
            expect(deepEqValores(sv, wv)).toBe(true);
          }
        });
      }

      test('P3 — envolvente done-ok: nada fuera del esquema', async () => {
        const { done } = await runWorker(fx.name, fx.buf);
        for (const k of Object.keys(done)) {
          expect((ENVOLVENTE_DONE_OK as readonly string[]).includes(k)).toBe(true);
        }
      });

      test('P3 — extras documentados: {dem, demError, demName} + contrato de presencia', async () => {
        const { done } = await runWorker(fx.name, fx.buf);
        const extras = Object.keys(done).filter(
          (k) => !(CAMPOS_SYNC as readonly string[]).includes(k)
        );
        for (const k of extras) {
          expect(
            ['fileId', 'type', 'ok', ...EXTRAS_DOCUMENTADOS].includes(k)
          ).toBe(true);
        }
        if (fx.demEsperado) {
          expect(done.dem).toBeDefined();
          expect(done.demError ?? null).toBeNull();
        } else {
          expect(done.dem ?? null).toBeNull();
          expect(done.demError ?? null).toBeNull();
        }
        expect(done.field ? true : false).toBe(fx.fieldEsperado);
        expect(done.geoid ? true : false).toBe(fx.geoidEsperado);
      });

      test('P3 — progress con envolvente propia (≥1 mensaje)', async () => {
        const { progreso } = await runWorker(fx.name, fx.buf);
        expect(progreso.length).toBeGreaterThan(0);
        for (const p of progreso) {
          for (const k of Object.keys(p)) {
            expect(['fileId', 'type', 'stage', 'pct'].includes(k)).toBe(true);
          }
        }
      });
    });
  }

  test('P4 — REGRESIÓN del bug histórico: pack MXP1 con rol FRICTION* ⇒ worker.field ≡ sync.field', async () => {
    const fx = FIXTURES[0]; // pack golden: el caso que el E2E dorado encontró roto
    const sync = parseFile(fx.name, fx.buf, ANCHOR);
    const { done } = await runWorker(fx.name, fx.buf);
    expect(done.ok).toBe(true);
    expect(sync.field).toBeDefined(); // el fallback sync lo traía (mascara)
    expect(done.field).toBeDefined(); // el worker lo SILENCIABA — fix field ?? result.field
    friccEq(sync.field as FrictionField, done.field as FrictionField);
  });

  test('P5 — REGRESIÓN proyectada FR-7: pack con roles GEOID-* ⇒ worker.geoid ≡ sync.geoid', async () => {
    const fx = FIXTURES[4]; // pack-geoid
    const sync = parseFile(fx.name, fx.buf, ANCHOR);
    const { done } = await runWorker(fx.name, fx.buf);
    expect(done.ok).toBe(true);
    const sg = sync.geoid;
    const wg = done.geoid;
    expect(sg).toBeDefined();
    expect(wg).toBeDefined(); // el worker lo propaga — asiento geoid ?? result.geoid
    expect(wg!.name).toBe('geoid'); // base del path del miembro
    expect(wg!.w).toBe(GEOID_W);
    expect(wg!.h).toBe(GEOID_H);
    expect(wg!.byteorder).toBe('I');
    expect(wg!.min).toBe(-28);
    expect(wg!.max).toBe(50);
    expect(deepEqValores(sg, wg)).toBe(true);
  });
});
