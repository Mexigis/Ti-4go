/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EX-vectorial — canal shapefile (ESRI) para el patrón topopack.
 *
 * Directiva checkpoint «Agenda §2 ACEPTADA» (),
 * unidad (a) puerto vectorial carreteras: la reproyección pesada
 * (LCC⇒UTM14N) vive EX-side (`scripts/make_roads_vectorpack.sh`, estilo
 * EX-005); el navegador SOLO decodifica el shapefile ya en UTM 14N y
 * convierte vértice a vértice con el converso Snyder FR-1 del repo
 * (ingest/geojson.ts) — la misma vía canónica del canal GeoJSON.
 * Jamás reproyección en el navegador.
 *
 * Contrato:
 *   - Patrón estricto del ZIP: exactamente 1×.shp + 1×.dbf + 1×.prj
 *     (sidecars tolerados: .shx/.cpg/.qix/.sbn/.sbx/.xml). Cualquier otra
 *     entrada ⇒ NO es vectorpack (cae al siguiente canal del dispatcher).
 *   - .prj OBLIGATORIO y clasificado (classifyPrj): UTM 14N (EPSG:32614 /
 *     «UTM zone 14N» / Transverse_Mercator con meridiano central −99° y
 *     k0 0.9996), geográfico WGS84, o NO-SOPORTADO (p. ej. el LCC-2SP
 *     ITRF92 de la fuente INEGI — rechazo honesto con la guía
 *     EX-vectorial).
 *   - SHP: shapes 1/11 (punto), 3/13/23 (línea), 5/15/25 (polígono) y
 *     8/18/28 (multipunto) — el bloque XY es idéntico; Z/M se ignora con
 *     nota (nada inventado). Tipos no soportados: contados y omitidos.
 *     Presupuestos duros MAX_VERTS/MAX_SEGS (parsers.ts).
 *   - DBF: dBASE III; campos C/N/F/D/L; codificación UTF-8 si .cpg lo
 *     declara, latin-1 manual en caso contrario (determinista, sin
 *     TextDecoder legacy). Registros borrados (0x2a): contados, jamás
 *     renderizados.
 *   - La cota JAMÁS se inventa: z = NaN por vértice ⇒ DRAPE-1 la drapea
 *     sobre el MDT activo (lift 2–3 px) — la verificación cruzada de las
 *     curvas reales.
 *
 * 0 GPU · CPU puro · determinista: mismo ZIP + misma región ⇒ misma
 * geometría byte a byte.
 */

import { MAX_VERTS, MAX_SEGS } from './parsers';

/* ------------------------------------------------------------------ */
/* Clasificación del .prj                                             */
/* ------------------------------------------------------------------ */

export type ShapefileCrs = 'utm14n' | 'wgs84' | 'unsupported';

export interface PrjClass {
  crs: ShapefileCrs;
  /** Etiqueta legible para la ficha (incluye el veredicto). */
  label: string;
}

/**
 * Clasifica el WKT del .prj por palabras clave — determinista. Un PROJCS
 * que no sea UTM 14N ⇒ unsupported (la guía EX-vectorial viaja en el error
 * del dispatcher: convertir EX-side, jamás en el navegador).
 */
export function classifyPrj(raw: string): PrjClass {
  const s = raw;
  if (/PROJCS/i.test(s)) {
    // Contenido sobre nombre (regla de la casa): un PROJCS es UTM 14N solo
    // si su PROYECCIÓN es Transverse_Mercator con meridiano central −99° y
    // k0 0.9996 — un WKT llamado «UTM Zone 14N» con parámetros distintos es
    // rechazado (el nombre jamás manda sobre los parámetros).
    if (
      /Transverse_Mercator/i.test(s) &&
      /central[_\s]?meridian[\",\s]*-99(\.0+)?/i.test(s) &&
      /scale[_\s]?factor[\",\s]*0\.9996/i.test(s)
    ) {
      return { crs: 'utm14n', label: 'EPSG:32614 (UTM 14N) — declarado en .prj' };
    }
    const name = /PROJCS\["([^"]+)"/.exec(s)?.[1] ?? 'proyectado';
    return { crs: 'unsupported', label: `${name} — proyección no soportada en el navegador` };
  }
  if (/GEOGCS/i.test(s) && /WGS[_\s]?(84|1984)/i.test(s)) {
    return { crs: 'wgs84', label: 'geográfico WGS84 — declarado en .prj' };
  }
  return { crs: 'unsupported', label: '.prj no reconocido' };
}

/* ------------------------------------------------------------------ */
/* DBF (dBASE III) — atributos                                        */
/* ------------------------------------------------------------------ */

export interface DbfField {
  name: string;
  type: string;
  len: number;
}

export type DbfValue = string | number | boolean | null;

export interface DbfReading {
  fields: DbfField[];
  records: Array<Record<string, DbfValue>>;
  /** Registros con bandera de borrado (0x2a): contados, jamás renderizados. */
  deleted: number;
  /** Nota de recorte por presupuesto (honesta, va a la ficha). */
  truncated?: string;
}

/** Decodifica una celda DBF: recorta espacios/NULLs finales; UTF-8 o
 *  latin-1 manual (código U+0000–U+00FF 1:1 — determinista). */
function decodeDbfCell(bytes: Uint8Array, utf8: boolean): string {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  const b = bytes.subarray(0, end);
  if (utf8) return new TextDecoder('utf-8', { fatal: false }).decode(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Presupuesto honesto de registros del canal vectorpack (unidad de campo:
 *  decenas; el catálogo nacional vive EX-side). */
export const MAX_DBF_RECORDS = 100_000;

export function readDbf(data: Uint8Array, utf8: boolean): DbfReading | null {
  if (data.length < 33) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numRecords = dv.getInt32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recordLen = dv.getUint16(10, true);
  if (numRecords < 0 || headerLen < 33 || recordLen < 1) return null;

  const fields: DbfField[] = [];
  let off = 32;
  while (off + 32 <= headerLen && data[off] !== 0x0d) {
    let name = '';
    for (let i = 0; i < 11; i++) {
      const c = data[off + i];
      if (c === 0x00) break;
      name += String.fromCharCode(c);
    }
    const type = String.fromCharCode(data[off + 11]);
    const len = data[off + 16];
    if (!name.trim() || len < 1) return null; // descriptor roto ⇒ malformado
    fields.push({ name: name.trim(), type, len });
    off += 32;
  }
  if (fields.length === 0 || fields.length > 256) return null;
  let sum = 1; // bandera de borrado
  for (const f of fields) sum += f.len;
  if (sum !== recordLen) return null; // incoherencia estructural ⇒ malformado

  const records: Array<Record<string, DbfValue>> = [];
  let deleted = 0;
  let ro = headerLen;
  const cap = Math.min(numRecords, MAX_DBF_RECORDS);
  for (let r = 0; r < cap; r++) {
    if (ro + recordLen > data.length) break;
    const flag = data[ro];
    if (flag === 0x2a) {
      deleted++;
      ro += recordLen;
      continue;
    }
    const rec: Record<string, DbfValue> = {};
    let fo = ro + 1;
    for (const f of fields) {
      const raw = data.subarray(fo, fo + f.len);
      fo += f.len;
      switch (f.type) {
        case 'N':
        case 'F': {
          const s = decodeDbfCell(raw, utf8);
          if (s === '') rec[f.name] = null;
          else {
            const v = Number(s);
            rec[f.name] = Number.isFinite(v) ? v : s; // N feo ⇒ texto honesto
          }
          break;
        }
        case 'C':
        case 'D':
          rec[f.name] = decodeDbfCell(raw, utf8);
          break;
        case 'L': {
          const c = raw[0];
          rec[f.name] = c === 0x54 || c === 0x59 ? true : c === 0x46 || c === 0x4e ? false : null;
          break;
        }
        default:
          // M/memo u otros: puntero bruto como texto — jamás inventado.
          rec[f.name] = decodeDbfCell(raw, utf8);
      }
    }
    records.push(rec);
    ro += recordLen;
  }
  const truncated =
    numRecords > cap
      ? `Registros truncados por presupuesto: ${cap.toLocaleString('es-MX')} de ${numRecords.toLocaleString('es-MX')}`
      : undefined;
  return { fields, records, deleted, truncated };
}

/* ------------------------------------------------------------------ */
/* SHP — geometría                                                    */
/* ------------------------------------------------------------------ */

export interface ShpReading {
  xs: number[];
  ys: number[];
  segs: number[];
  pts: number[];
  /** Conteo por tipo de shape (ficha honesta). */
  typeCounts: Record<string, number>;
  /** Shapes de tipo no soportado: contados y omitidos. */
  skipped: number;
  bbox: [number, number, number, number];
  shapeTypeFile: number;
  /** Notas de presupuesto/omisión (honesta, van a la ficha). */
  notes: string[];
}

const SHP_NAMES: Record<number, string> = {
  1: 'Point',
  3: 'PolyLine',
  5: 'Polygon',
  8: 'MultiPoint',
  11: 'PointZ',
  13: 'PolyLineZ',
  15: 'PolygonZ',
  18: 'MultiPointZ',
  23: 'PolyLineM',
  25: 'PolygonM',
  28: 'MultiPointM',
};

export function readShp(
  data: Uint8Array,
  budget: { verts: number; segs: number }
): ShpReading | null {
  if (data.length < 100) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getInt32(0, false) !== 9994) return null; // magic (big-endian)
  if (dv.getInt32(28, true) !== 1000) return null; // versión
  const shapeTypeFile = dv.getInt32(32, true);
  const bbox: [number, number, number, number] = [
    dv.getFloat64(36, true),
    dv.getFloat64(44, true),
    dv.getFloat64(52, true),
    dv.getFloat64(60, true),
  ];

  const xs: number[] = [];
  const ys: number[] = [];
  const segs: number[] = [];
  const pts: number[] = [];
  const typeCounts: Record<string, number> = {};
  const notes: string[] = [];
  let skipped = 0;
  let vertsFull = false;
  let segsFull = false;

  let off = 100;
  while (off + 8 <= data.length) {
    const contentWords = dv.getInt32(off + 4, false);
    if (contentWords < 0) return null;
    const contentBytes = contentWords * 2;
    if (off + 8 + contentBytes > data.length) return null;
    const base = off + 8;
    const type = dv.getInt32(base, true);
    const name = SHP_NAMES[type];
    if (!name) {
      skipped++;
      off += 8 + contentBytes;
      continue;
    }
    typeCounts[name] = (typeCounts[name] ?? 0) + 1;

    const isPoint = type === 1 || type === 11;
    const isLine = type === 3 || type === 13 || type === 23;
    const isPoly = type === 5 || type === 15 || type === 25;
    const isMulti = type === 8 || type === 18 || type === 28;

    if (isPoint) {
      if (contentBytes < 20) return null;
      if (xs.length + 1 > budget.verts) vertsFull = true;
      else {
        xs.push(dv.getFloat64(base + 4, true));
        ys.push(dv.getFloat64(base + 12, true));
        pts.push(xs.length - 1);
      }
    } else if (isLine || isPoly || isMulti) {
      // Box(32 B) + NumParts + NumPoints (+ Parts[]) — MultiPoint sin parts.
      if (contentBytes < (isMulti ? 12 : 44)) return null;
      const numParts = isMulti ? 1 : dv.getInt32(base + 36, true);
      const numPoints = dv.getInt32(base + (isMulti ? 8 : 40), true);
      if (numPoints < 1 || numParts < 1) return null;
      const partsOff = base + (isMulti ? 12 : 44);
      const pointsOff = partsOff + (isMulti ? 0 : numParts * 4);
      if (pointsOff + numPoints * 16 > base + contentBytes) return null;
      const parts: number[] = [];
      if (!isMulti) {
        for (let p = 0; p < numParts; p++) {
          const v = dv.getInt32(partsOff + p * 4, true);
          if (v < 0 || v >= numPoints) return null; // parts roto ⇒ malformado
          parts.push(v);
        }
      } else parts.push(0);
      parts.push(numPoints);

      for (let p = 0; p + 1 < parts.length; p++) {
        const s = parts[p];
        const e = parts[p + 1];
        if (e <= s) continue; // parte degenerada: omisión honesta
        const start = xs.length;
        for (let i = s; i < e; i++) {
          if (xs.length >= budget.verts) {
            vertsFull = true;
            break;
          }
          xs.push(dv.getFloat64(pointsOff + i * 16, true));
          ys.push(dv.getFloat64(pointsOff + i * 16 + 8, true));
        }
        if (e - s >= 2) {
          for (let i = start + 1; i < xs.length; i++) {
            if (segs.length + 2 > budget.segs) {
              segsFull = true;
              break;
            }
            segs.push(i - 1, i);
          }
          // Polígono: anillo cerrado (primera == última posición del anillo)
          if (isPoly && !segsFull && xs.length > start && segs.length + 2 <= budget.segs) {
            segs.push(xs.length - 1, start);
          }
        }
        if (isMulti) for (let i = start; i < xs.length; i++) pts.push(i);
        if (vertsFull || segsFull) break;
      }
      if (vertsFull || segsFull) break;
    } else {
      skipped++;
    }
    off += 8 + contentBytes;
  }

  if (skipped > 0)
    notes.push(
      `${skipped.toLocaleString('es-MX')} shape(s) de tipo no soportado omitidos (Z/M de otra familia se leen por su bloque XY)`
    );
  if (vertsFull)
    notes.push(
      `Datos truncados por presupuesto: tope ${MAX_VERTS.toLocaleString('es-MX')} vértices`
    );
  if (segsFull)
    notes.push(`Datos truncados por presupuesto: tope ${MAX_SEGS.toLocaleString('es-MX')} aristas`);

  return { xs, ys, segs, pts, typeCounts, skipped, bbox, shapeTypeFile, notes };
}
