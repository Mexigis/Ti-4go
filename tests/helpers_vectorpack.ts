/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * helpers_vectorpack.ts — fixture determinista del canal EX-vectorial
 * (unidad a, directiva checkpoint «Agenda §2 ACEPTADA» trace
 * ``). Compartido por forense_vectorpack.test.ts y el
 * guardián de paridad (forense_paridad_worker_sync) — la guardiana camina
 * el canal nuevo en cada suite.
 *
 * Escritor ZIP mínimo (PKZIP 2.0, misma disciplina que el de
 * forense_paridad_worker_sync) + escritores SHP (PolyLine) y DBF (dBASE
 * III) mínimos pero estructuralmente íntegros: el parser se prueba contra
 * bytes honestos, no contra mocks.
 */

import { crc32 } from '../src/lib/ingest/zip';
import { wgs84ToUtm14n } from '../src/lib/ingest/geojson';

interface ZipIn {
  name: string;
  data: Uint8Array;
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

export const catBytes = cat;
export const i32le = (v: number): Uint8Array =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
export const i32be = (v: number): Uint8Array =>
  new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const u32 = (v: number): Uint8Array =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

export function buildZip(inputs: ZipIn[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const offsets: number[] = [];
  let off = 0;
  const enc = new TextEncoder();
  for (const inp of inputs) {
    const method = 0; // STORED — patrón del EX-vectorial
    const flags = 0x800; // UTF-8
    const crc = crc32(inp.data);
    offsets.push(off);
    const nameB = enc.encode(inp.name);
    const local = cat([
      u32(0x04034b50), u16(20), u16(flags), u16(method),
      u16(0), u16(0), u32(crc), u32(inp.data.length), u32(inp.data.length),
      u16(nameB.length), u16(0), nameB, inp.data,
    ]);
    chunks.push(local);
    central.push(cat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method),
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

/* ------------------------------------------------------------------ */
/* SHP — PolyLine (tipo 3) mínimo pero íntegro                         */
/* ------------------------------------------------------------------ */

export interface ShpFeature {
  /** Pares [x, y] en las unidades del CRS declarado (UTM 14N metros). */
  pts: Array<[number, number]>;
}

export function buildShp(features: ShpFeature[]): Uint8Array {
  const f64 = (v: number): Uint8Array => new Uint8Array(new Float64Array([v]).buffer);
  const i32le = (v: number): Uint8Array =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const i32be = (v: number): Uint8Array =>
    new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

  // Contenido de cada record: tipo(4) + Box(32) + NumParts(4) + NumPoints(4)
  //   + Parts(4·numParts) + Points(16·numPoints)
  const contents: Uint8Array[] = [];
  for (const f of features) {
    const xs = f.pts.map((p) => p[0]);
    const ys = f.pts.map((p) => p[1]);
    const content = cat([
      i32le(3), // PolyLine
      f64(Math.min(...xs)), f64(Math.min(...ys)), f64(Math.max(...xs)), f64(Math.max(...ys)),
      i32le(1), // numParts
      i32le(f.pts.length), // numPoints
      i32le(0), // parts[0]
      ...f.pts.flatMap((p) => [f64(p[0]), f64(p[1])]),
    ]);
    contents.push(content);
  }

  const records: Uint8Array[] = [];
  let recNum = 1;
  for (const content of contents) {
    records.push(cat([i32be(recNum++), i32be(content.length / 2), content]));
  }
  const body = cat(records);
  const totalWords = (100 + body.length) / 2;

  const header = cat([
    i32be(9994), // file code
    u32(0), u32(0), u32(0), u32(0), u32(0), // unused
    i32be(totalWords), // file length (WORDS, BE)
    i32le(1000), // version
    i32le(3), // shape type del archivo
    f64(-101.34), f64(21.04), f64(-101.31), f64(21.06), // bbox XY
    f64(0), f64(0), // bbox Z
    f64(0), f64(0), // bbox M
  ]);
  return cat([header, body]);
}

/* ------------------------------------------------------------------ */
/* DBF — dBASE III mínimo pero íntegro                                 */
/* ------------------------------------------------------------------ */

export interface DbfFieldSpec {
  name: string;
  type: 'C' | 'N' | 'F' | 'D' | 'L';
  len: number;
}

export interface DbfRecordSpec {
  /** Bandera de borrado: «*» ⇒ registro borrado (el parser lo cuenta). */
  deleted?: boolean;
  /** Uint8Array ⇒ celda CRUDA (bytes exactos, simula fuente latin-1). */
  values: Array<string | number | boolean | null | Uint8Array>;
}

export function buildDbf(fields: DbfFieldSpec[], records: DbfRecordSpec[]): Uint8Array {
  const enc = new TextEncoder();
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.reduce((s, f) => s + f.len, 0);

  const fieldDescs: Uint8Array[] = [];
  for (const f of fields) {
    const nameB = enc.encode(f.name.slice(0, 11));
    const namePad = new Uint8Array(11);
    namePad.set(nameB);
    fieldDescs.push(
      cat([namePad, enc.encode(f.type), new Uint8Array(4), new Uint8Array([f.len, 0]), new Uint8Array(14)])
    );
  }

  const recs: Uint8Array[] = [];
  for (const r of records) {
    const parts: Uint8Array[] = [new Uint8Array([r.deleted ? 0x2a : 0x20])];
    r.values.forEach((v, i) => {
      const f = fields[i];
      const cell = new Uint8Array(f.len).fill(0x20); // espacios
      if (v instanceof Uint8Array) {
        // Celda cruda: bytes EXACTOS (simula codificación latin-1 de fuente).
        cell.set(v.subarray(0, f.len));
      } else {
        let text = '';
        if (v === null || v === undefined) text = '';
        else if (typeof v === 'boolean') text = v ? 'T' : 'F';
        else text = String(v);
        const textB = enc.encode(text.slice(0, f.len));
        cell.set(textB);
      }
      parts.push(cell);
    });
    recs.push(cat(parts));
  }

  const header = cat([
    new Uint8Array([0x03]), // dBASE III sin memo
    new Uint8Array([26, 10, 2]), // YY MM DD (determinista)
    u32(records.length),
    u16(headerLen),
    u16(recordLen),
    new Uint8Array(20),
    ...fieldDescs,
    new Uint8Array([0x0d]),
  ]);
  return cat([header, ...recs]);
}

/* ------------------------------------------------------------------ */
/* WKT de .prj (las tres familias del contrato)                        */
/* ------------------------------------------------------------------ */

export const PRJ_UTM14N =
  'PROJCS["WGS_1984_UTM_Zone_14N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-99.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

/** El prj REAL de la fuente INEGI (Task 52) — latin-1: 0xe9 = «é». */
export const PRJ_LCC_INEGI_LATIN1 =
  'PROJCS["M\xe9xico_ITRF92_CCL",GEOGCS["ITRF92_GRS80",DATUM["D_GRS_1980",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",2500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-102.0],PARAMETER["Standard_Parallel_1",17.5],PARAMETER["Standard_Parallel_2",29.5],PARAMETER["Latitude_Of_Origin",12.0],UNIT["Meter",1.0]]';

export const PRJ_WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/* ------------------------------------------------------------------ */
/* Unidad vectorpack completa                                          */
/* ------------------------------------------------------------------ */

export interface VectorpackSpec {
  features: ShpFeature[];
  prj: string;
  cpg?: string | null; // null ⇒ sin .cpg (latin-1 honesto)
  withShx?: boolean;
  /** Registro DBF borrado (0x2a) — el parser lo cuenta y omite. */
  dbfDeleted?: DbfRecordSpec[];
  dbfRecords?: DbfRecordSpec[];
  /** Entradas extra (p. ej. manifest.json) para probar el patrón estricto. */
  extraEntries?: ZipIn[];
  omit?: Array<'prj' | 'dbf'>;
}

export interface VectorpackFields {
  name: string;
  type: DbfFieldSpec['type'];
  len: number;
}

export const CAMPOS_INEGI: VectorpackFields[] = [
  { name: 'NOMVIAL', type: 'C', len: 16 },
  { name: 'TIPOVIA', type: 'C', len: 12 },
  { name: 'CONDICION', type: 'C', len: 14 },
  { name: 'ADMINISTRA', type: 'C', len: 12 },
  { name: 'NUME_CARR', type: 'N', len: 4 },
  { name: 'LONGITUD', type: 'N', len: 12 },
];

/** Ancla del fixture: el centro del ANCHOR del guardián de paridad
 *  (−101.33, 21.00) llevado a UTM 14N con el converso FR-1 del repo — los
 *  segmentos por defecto miden EXACTAMENTE 100 y 400 m en metros UTM. */
export const P0 = wgs84ToUtm14n(-101.33, 21.0)!;

/** Unidad por defecto: 2 segmentos — el 1º de 100 m (LONGITUD 100 ⇒ Δ ≈ 0
 *  para ese feature) y el 2º de 400 m (LONGITUD 300); Σ geom 500 m vs
 *  Σ atributo 400 m ⇒ Δ +25.0 % para la unidad completa. */
export function buildVectorpackZip(spec: Partial<VectorpackSpec> = {}): Uint8Array {
  const {
    features = [
      { pts: [P0, [P0[0] + 100, P0[1]]] }, // 100 m este
      { pts: [[P0[0], P0[1] + 50], [P0[0] + 400, P0[1] + 50]] }, // 400 m este
    ],
    prj = PRJ_UTM14N,
    cpg = 'UTF-8',
    withShx = true,
    dbfDeleted = [],
    dbfRecords,
    extraEntries = [],
    omit = [],
  } = spec;

  const coords = features.map((f) => f.pts);
  const longitudes = dbfRecords
    ? dbfRecords.map((r) => r.values[5])
    : coords.map((_, i) => (i === 0 ? 100 : 300));
  const admin = ['ESTATAL', 'FEDERAL'];

  const dbf = buildDbf(
    CAMPOS_INEGI,
    dbfRecords ?? [
      ...coords.map((_, i) => ({
        values: ['N/A', 'CARRETERA', 'EN OPERACION', admin[i % 2], 2, longitudes[i] as number],
      })),
      ...dbfDeleted.map((r) => ({ ...r, deleted: true })),
    ]
  );

  const entries: ZipIn[] = [];
  if (!omit.includes('prj')) entries.push({ name: 'carreteras.prj', data: new TextEncoder().encode(prj) });
  if (!omit.includes('dbf')) entries.push({ name: 'carreteras.dbf', data: dbf });
  entries.push({ name: 'carreteras.shp', data: buildShp(features) });
  if (withShx) entries.push({ name: 'carreteras.shx', data: new Uint8Array(100) });
  if (cpg) entries.push({ name: 'carreteras.cpg', data: new TextEncoder().encode(cpg) });
  entries.push(...extraEntries);
  return buildZip(entries);
}
