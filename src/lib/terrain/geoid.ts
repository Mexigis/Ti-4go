/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GPS-ORTO — Modelo de geoide GGM25 (INEGI) → cota ortométrica.
 * Re-landing del mínimo contractual (rollback #3, §9 2026-09-27) bajo la
 * spec verbatim del checkpoint: parser BIL+HDR 0-dependencias (~150 líneas),
 * catálogo hostil BIL, `toOrthometric()` y registro del geoid activo.
 *
 * Contrato:
 *   - ENTRADA: par (.hdr ESRI BIL, .bil Float32LE/Int16LE) — la ruta
 *     escritorio ingesta el ZIP nacional real (upload → geoidpack.ts →
 *     worker → registro activo); la ruta mission-pack (sub-grid dentro del
 *     pack) espera V-3 y NO existe aquí todavía (honesto).
 *   - N = separación geooidal (geoide sobre el elipsoide ⇒ positiva).
 *     Cota ortométrica H = h_elipsoidal − N (ortométrica = nivel medio).
 *   - FR-7 (regla de datos): el chip GPS SIEMPRE reporta elipsoidal; la
 *     conversión ocurre SOLO con geoid activo y posición en cobertura.
 *     Sin geoid: la cota se muestra elipsoidal-DECLARADA — jamás se hornea
 *     un valor (lección del checkpoint: «los datos falsos apagan la señal
 *     que los corrige»).
 *   - HOSTIL ⇒ null sin excepciones (misma filosofía FR-1/FR-2/FR-3):
 *     catálogo abajo. NaN (NODATA "-nan" del GGM25 real) en una celda CON
 *     peso bilinear > 0 ⇒ muestra null = «fuera de cobertura» honesta;
 *     en los bordes exactos la celda de peso 0 no participa.
 *   - ADR D10 (nota de datum): la rejilla declara GCS_GRS_1980; GRS80 ≈
 *     WGS84 (semiejes idénticos, aplanamiento distinto en el 9º decimal ⇒
 *     < 1 cm en este contexto). La muestra se trata como WGS84 y la nota
 *     viaja en la ficha y en el cajetín.
 *   - 0 GPU · determinista: mismos bytes ⇒ mismas muestras (test pines).
 *
 * Presupuestos: MAX_BIL_BYTES 64 MB (el GGM25 nacional real = 25.2 MB),
 * dims ≤ 20 000, XDIM/YDIM ∈ (0, 1°].
 */

export const MAX_BIL_BYTES = 64 * 1024 * 1024;
export const MAX_GEOID_DIMS = 20_000;

/** Tolerancia DECLARADA del laboratorio para la consistencia cota-chip vs
 *  curvas del mapa (composición: bilinear 1′ del geoide + bilinear ~40 m
 *  del MDT + Float32). La validación con dispositivo real es FR-9. */
export const LAB_TOLERANCE_M = 1.0;

/** Etiqueta de datum SIN geoid activo (regla FR-7: elipsoidal-declarado). */
export const DATUM_ELLIPSOIDAL = 'elipsoidal WGS84 (declarada)';

export type GeoidPixelType = 'float32' | 'int16';

export interface GeoidMeta {
  /** Nombre corto del modelo (del miembro del ZIP, p.ej. "GGM25"). */
  name: string;
  pixelType: GeoidPixelType;
  littleEndian: boolean;
  nrows: number;
  ncols: number;
  ulxmap: number;
  ulymap: number;
  xdim: number;
  ydim: number;
  /** Valor NODATA efectivo (NaN para el GGM25 real). */
  nodata: number;
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

export interface GeoidModel {
  meta: GeoidMeta;
  /** Separación geooidal N(lon,lat) en m; null = fuera de cobertura u
   *  NODATA (honesto — nunca se interpola a través de NaN). */
  sample(lon: number, lat: number): number | null;
}

export interface OrthoResult {
  /** Cota ortométrica H = h − N (m s.n.m. de nivel medio). */
  hOrto: number;
  /** Separación geooidal aplicada (m). */
  n: number;
}

/* ------------------------------------------------------------------ */
/* Parser de cabecera (texto tolerante, validación estricta)           */
/* ------------------------------------------------------------------ */

interface HdrFields {
  byteorder: string;
  layout: string;
  nrows: number;
  ncols: number;
  nbands: number;
  nbits: number;
  bandRowBytes: number;
  totalRowBytes: number;
  pixeltype: string;
  ulxmap: number;
  ulymap: number;
  xdim: number;
  ydim: number;
  nodata: number; // NaN si no declarado o "-nan"
}

const HDR_INT_KEYS = ['nrows', 'ncols', 'nbands', 'nbits', 'bandrowbytes', 'totalrowbytes'] as const;
const HDR_FLOAT_KEYS = ['ulxmap', 'ulymap', 'xdim', 'ydim'] as const;

/** Parsea el .hdr: claves KEY=valor con espacio arbitrario. Devuelve null
 *  si falta una clave requerida o un número requerido no es finito. */
export function parseGeoidHdr(hdrText: string): HdrFields | null {
  if (hdrText.length > 8192) return null; // presupuesto: una cabecera BIL es tiny
  const map = new Map<string, string>();
  // Tolerante: separadores \r\n / \n y también claves en la misma línea.
  for (const rawLine of hdrText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^([A-Za-z_]+)\s+(.+)$/.exec(line);
    if (!m) return null; // línea sin clave ⇒ cabecera no-BIL ⇒ hostil
    const key = m[1].toLowerCase();
    if (!map.has(key)) map.set(key, m[2].trim());
  }
  const byteorder = map.get('byteorder');
  const layout = map.get('layout');
  const pixeltype = map.get('pixeltype');
  if (!byteorder || !layout || !pixeltype) return null;

  const ints: Record<string, number> = {};
  for (const k of HDR_INT_KEYS) {
    const v = map.get(k);
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    ints[k] = n;
  }
  const floats: Record<string, number> = {};
  for (const k of HDR_FLOAT_KEYS) {
    const v = map.get(k);
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    floats[k] = n;
  }
  // NODATA: opcional; "-nan"/"nan"/"NaN" ⇒ NaN (caso GGM25 real).
  let nodata = NaN;
  const nd = map.get('nodata');
  if (nd !== undefined) {
    if (/^-?nan$/i.test(nd)) nodata = NaN;
    else {
      const n = Number(nd);
      if (!Number.isFinite(n)) return null;
      nodata = n;
    }
  }
  return {
    byteorder: byteorder.toUpperCase(),
    layout: layout.toUpperCase(),
    nrows: ints.nrows,
    ncols: ints.ncols,
    nbands: ints.nbands,
    nbits: ints.nbits,
    bandRowBytes: ints.bandrowbytes,
    totalRowBytes: ints.totalrowbytes,
    pixeltype: pixeltype.toUpperCase(),
    ulxmap: floats.ulxmap,
    ulymap: floats.ulymap,
    xdim: floats.xdim,
    ydim: floats.ydim,
    nodata,
  };
}

/* ------------------------------------------------------------------ */
/* Parser BIL → GeoidModel                                             */
/* ------------------------------------------------------------------ */

/** Construye el modelo desde el par hdr+bil. HOSTIL ⇒ null (catálogo):
 *  01 hdr ausente/fracturado (clave faltante o número inválido)
 *  02 LAYOUT ≠ BIL
 *  03 BYTEORDER ≠ I (big-endian «M»: rechazo honesto de contrato)
 *  04 NBANDS ≠ 1
 *  05 (PIXELTYPE,NBITS) ∉ { (FLOAT,32), (INT,16) }
 *  06 NROWS/NCOLS ≤ 0 o > 20 000
 *  07 BANDROWBYTES ≠ NCOLS·NBITS/8
 *  08 TOTALROWBYTES < BANDROWBYTES (NBANDS=1 ⇒ iguales)
 *  09 longitud BIL ≠ TOTALROWBYTES·NROWS (truncado o relleno)
 *  10 XDIM/YDIM ≤ 0 o > 1° (grados fuera de rango razonable)
 *  11 ULXMAP ∉ [−180,180] o ULYMAP ∉ [−90,90]
 *  12 presupuesto: NCOLS·NROWS·(NBITS/8) > MAX_BIL_BYTES
 */
export function parseGeoidBil(
  hdrText: string,
  bilBytes: Uint8Array,
  name = 'GGM25'
): GeoidModel | null {
  const h = parseGeoidHdr(hdrText);
  if (!h) return null; // 01
  if (h.layout !== 'BIL') return null; // 02
  if (h.byteorder !== 'I') return null; // 03
  if (h.nbands !== 1) return null; // 04
  const isF32 = h.pixeltype === 'FLOAT' && h.nbits === 32;
  const isI16 = h.pixeltype === 'INT' && h.nbits === 16;
  if (!isF32 && !isI16) return null; // 05
  if (h.nrows <= 0 || h.ncols <= 0 || h.nrows > MAX_GEOID_DIMS || h.ncols > MAX_GEOID_DIMS)
    return null; // 06
  const bytesPer = isF32 ? 4 : 2;
  if (h.bandRowBytes !== h.ncols * bytesPer) return null; // 07
  if (h.totalRowBytes < h.bandRowBytes) return null; // 08
  if (bilBytes.length !== h.totalRowBytes * h.nrows) return null; // 09
  if (!(h.xdim > 0 && h.xdim <= 1) || !(h.ydim > 0 && h.ydim <= 1)) return null; // 10
  if (
    h.ulxmap < -180 ||
    h.ulxmap > 180 ||
    h.ulymap < -90 ||
    h.ulymap > 90 ||
    h.ulxmap + (h.ncols - 1) * h.xdim > 180.0001 ||
    h.ulymap - (h.nrows - 1) * h.ydim < -90.0001
  )
    return null; // 11
  if (h.ncols * h.nrows * bytesPer > MAX_BIL_BYTES) return null; // 12

  const meta: GeoidMeta = {
    name,
    pixelType: isF32 ? 'float32' : 'int16',
    littleEndian: true,
    nrows: h.nrows,
    ncols: h.ncols,
    ulxmap: h.ulxmap,
    ulymap: h.ulymap,
    xdim: h.xdim,
    ydim: h.ydim,
    nodata: h.nodata,
    lonMin: h.ulxmap,
    lonMax: h.ulxmap + (h.ncols - 1) * h.xdim,
    latMax: h.ulymap,
    latMin: h.ulymap - (h.nrows - 1) * h.ydim,
  };

  // Vista tipada sobre los bytes (LE por contrato BYTEORDER I).
  const dv = new DataView(bilBytes.buffer, bilBytes.byteOffset, bilBytes.byteLength);
  const readCell = (row: number, col: number): number => {
    const off = row * h.totalRowBytes + col * bytesPer;
    return isF32 ? dv.getFloat32(off, true) : dv.getInt16(off, true);
  };

  const isNodata = (v: number): boolean =>
    Number.isNaN(v) || (Number.isNaN(h.nodata) ? false : v === h.nodata);

  const sample = (lon: number, lat: number): number | null => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    // Fuera de cobertura ⇒ null honesto (sin extrapolación). Épsilon de
    // borde: −102+0.01 ≠ −101.99 en flotante — una coordenada EXACTA del
    // borde derecho/inferior debe muestrear el nodo de borde, no caer.
    const EPS = 1e-9;
    if (
      lon < meta.lonMin - EPS ||
      lon > meta.lonMax + EPS ||
      lat < meta.latMin - EPS ||
      lat > meta.latMax + EPS
    )
      return null;
    const fc = (lon - meta.ulxmap) / meta.xdim;
    const fr = (meta.ulymap - lat) / meta.ydim;
    let c0 = Math.floor(fc);
    let r0 = Math.floor(fr);
    // Borde exacto derecho/inferior: usa la última celda sin interpolar.
    if (c0 > h.ncols - 2) c0 = h.ncols - 2;
    if (r0 > h.nrows - 2) r0 = h.nrows - 2;
    if (c0 < 0 || r0 < 0) return null;
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const tc = Math.min(Math.max(fc - c0, 0), 1);
    const tr = Math.min(Math.max(fr - r0, 0), 1);
    const v00 = readCell(r0, c0);
    const v10 = readCell(r0, c1);
    const v01 = readCell(r1, c0);
    const v11 = readCell(r1, c1);
    // NODATA ⇒ null honesto (no se inventa valor). Solo participan las
    // celdas con peso > 0: en los bordes exactos (tc o tr = 1) la celda
    // lejana NO contribuye y su NODATA no anula la muestra.
    const w00 = (1 - tc) * (1 - tr);
    const w10 = tc * (1 - tr);
    const w01 = (1 - tc) * tr;
    const w11 = tc * tr;
    if (
      (w00 > 0 && isNodata(v00)) ||
      (w10 > 0 && isNodata(v10)) ||
      (w01 > 0 && isNodata(v01)) ||
      (w11 > 0 && isNodata(v11))
    )
      return null;
    // Interpolación que respeta pesos EXACTOS: t=0/1 devuelve el nodo sin
    // aritmética — una celda de peso 0 (p.ej. NODATA en el borde lejano)
    // nunca envenena el resultado con NaN.
    const lerp = (a: number, b: number, t: number): number =>
      t === 1 ? b : t === 0 ? a : a + (b - a) * t;
    const top = lerp(v00, v10, tc);
    const bot = lerp(v01, v11, tc);
    const n = lerp(top, bot, tr);
    return Number.isFinite(n) ? n : null;
  };

  return { meta, sample };
}

/* ------------------------------------------------------------------ */
/* GPS-ORTO: conversión a ortométrica                                  */
/* ------------------------------------------------------------------ */

/** H = h_elipsoidal − N. Devuelve null si h no es finito o la posición
 *  queda fuera de cobertura del modelo (el llamador decide la regla FR-7:
 *  sin N honesto NO hay conversión — la cota permanece elipsoidal). */
export function toOrthometric(
  hEllips: number,
  lon: number,
  lat: number,
  model: GeoidModel
): OrthoResult | null {
  if (!Number.isFinite(hEllips)) return null;
  const n = model.sample(lon, lat);
  if (n === null) return null;
  const hOrto = hEllips - n;
  return Number.isFinite(hOrto) ? { hOrto, n } : null;
}

/* ------------------------------------------------------------------ */
/* Registro del geoid activo (ruta escritorio — hilo principal)        */
/* ------------------------------------------------------------------ */

let ACTIVE: { model: GeoidModel } | null = null;

/** Activa el modelo (reemplaza al anterior; la ficha y el cajetín lo
 *  reflejan vía datumLabel()). Idempotente para el mismo modelo. */
export function setActiveGeoid(model: GeoidModel): void {
  ACTIVE = { model };
}

/** Desactiva (regla FR-7: el lienzo vuelve a elipsoidal-declarado). */
export function clearActiveGeoid(): void {
  ACTIVE = null;
}

export function getActiveGeoid(): GeoidModel | null {
  return ACTIVE ? ACTIVE.model : null;
}

/** Fila de datum para ficha y cajetín. */
export function datumLabel(): string {
  return ACTIVE ? `${ACTIVE.model.meta.name} (ortométrica)` : DATUM_ELLIPSOIDAL;
}

/** ¿Hay geoid activo? (habilita la conversión del chip FR-7) */
export function hasActiveGeoid(): boolean {
  return ACTIVE !== null;
}
