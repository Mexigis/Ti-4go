/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-7 · GGM25 — Lector BIL+HDR 0-dependencias del geoide gravimétrico
 * (unidad ratificada D-1, ).
 *
 * Entrada canónica: el ZIP nacional de INEGI (GGM25.hdr + GGM25.bil +
 * GGM25.prj) vía el lector ZIP existente (FR-3, zip.ts — cero trabajo de
 * contenedor propio). También acepta los miembros sueltos (par HDR+BIL
 * opcionalmente con PRJ) para el sub-grid regional del Mission Pack.
 *
 * Contrato de la unidad (spec del checkpoint GGM25):
 *   - HDR ASCII tolerante: claves separadas por espacio, mayúsculas o no;
 *     claves desconocidas se ignoran; las OBLIGATORIAS ausentes ⇒ rechazo.
 *   - Presupuesto PREVIO a la lectura: NROWS×NCOLS×4 (NBITS=32, FLOAT) se
 *     valida contra el tamaño del .bil ANTES de asignar; truncado o
 *     sobrante ⇒ rechazo limpio con la cuenta EXACTA de bytes.
 *   - BYTEORDER honrado: «I» = little-endian, «M» = big-endian (la
 *     declaración del HDR manda; nada se asume por plataforma).
 *   - LAYOUT ≠ BIL ⇒ rechazo. NBANDS ≠ 1 o NBITS ≠ 32 ⇒ rechazo.
 *   - NODATA se respeta (numérico o NaN — el GGM25 real declara «-nan»).
 *   - Rejilla 100 % NODATA ⇒ rechazo (hostil grid-NaN).
 *   - CRS: geográfico por defecto WGS84/ITRF2008; el .prj del ZIP (si
 *     existe) se valida contra esa familia (WGS84/GRS80/ITRF — GRS80 ≈
 *     WGS84 como aproximación documentada, ADR D10); divergencia ⇒
 *     rechazo honesto (nada se reproyecta).
 *
 * Convención de rejilla (Esri BIL, verificada contra GDAL/EHdr): ULXMAP y
 * ULYMAP son el CENTRO de la celda (0,0); la fila 0 es el NORTE. La
 * interpolación bilineal es la MISMA de sampleDemElevation (geotiff-dem.ts)
 * en espíritu: fuera de cobertura o en NODATA ⇒ NaN (honesto).
 *
 * Reglas del régimen: FR-W5 (0 GPU — CPU puro determinista), W1 (este
 * módulo no commitea datos de misión; las fixtures de la suite son
 * sintéticas o referencias públicas del modelo), V-3 (el sub-grid es un
 * DERIVADO de INEGI: su distribución es decisión del instituto, pendiente).
 */

import { readZip } from './zip';

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export interface GeoidModel {
  /** Nombre base (del .hdr/.bil) — etiqueta del datum: «GGM25». */
  name: string;
  w: number;
  h: number;
  /** Centro de la celda UL (convención Esri BIL, verificada con GDAL). */
  ulx: number;
  uly: number;
  /** Grados por celda (XDIM/YDIM del HDR). */
  dx: number;
  dy: number;
  /** Declaración honrada del HDR: «I» (LE) o «M» (BE). */
  byteorder: 'I' | 'M';
  /** Undulación en m — LE normalizado internamente (fila 0 = norte). */
  data: Float32Array;
  /** NODATA declarado (NaN si el HDR declara -nan/NaN; null si ausente). */
  nodata: number | null;
  /** Rango sobre celdas válidas (rejilla 100 % NODATA ⇒ rechazo antes). */
  min: number;
  max: number;
  /** Presupuesto exacto: w*h*4 bytes. */
  bytes: number;
  /** Procedencia del datum horizontal (W1: nota, no promesa). */
  crsNote: string;
}

export type GeoidRead =
  | { ok: true; model: GeoidModel }
  | { ok: false; reason: string };

/* ------------------------------------------------------------------ */
/* HDR ASCII tolerante                                                 */
/* ------------------------------------------------------------------ */

const REQUERIDOS = [
  'BYTEORDER', 'LAYOUT', 'NROWS', 'NCOLS', 'NBANDS', 'NBITS',
  'XDIM', 'YDIM', 'ULXMAP', 'ULYMAP',
] as const;

/** Límite de sanidad: un modelo de geoides no excede esto (20000² ×4 B). */
const MAX_DIM = 20_000;
/** Tope duro del raster decodificado (coincide con el presupuesto ZIP). */
const MAX_GRID_BYTES = 64 * 1024 * 1024;
/** Épsilon de borde en GRADOS (puerto D-1): una coordenada EXACTA del
 *  borde este/sur debe muestrear el nodo de borde, no caer por flotante. */
const EPS_BORDE = 1e-9;

function parseHdr(hdr: Uint8Array): { ok: true; kv: Map<string, string> } | { ok: false; reason: string } {
  let txt: string;
  try {
    txt = new TextDecoder('utf-8', { fatal: true }).decode(hdr);
  } catch {
    txt = '';
    for (let i = 0; i < hdr.length; i++) txt += String.fromCharCode(hdr[i]);
  }
  const kv = new Map<string, string>();
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(.*?)\s*$/.exec(line);
    if (!m) continue; // línea vacía o sin valor — tolerada (no declara)
    if (!kv.has(m[1].toUpperCase())) kv.set(m[1].toUpperCase(), m[2]);
  }
  for (const k of REQUERIDOS) {
    if (!kv.has(k)) return { ok: false, reason: `HDR sin «${k}» — campo obligatorio ausente` };
  }
  return { ok: true, kv };
}

/* ------------------------------------------------------------------ */
/* PRJ — validación de familia (sin reproyecciones heroicas)           */
/* ------------------------------------------------------------------ */

function validatePrj(prj: Uint8Array): { ok: true; note: string } | { ok: false; reason: string } {
  let txt = '';
  for (let i = 0; i < prj.length; i++) txt += String.fromCharCode(prj[i]);
  const up = txt.toUpperCase();
  if (up.includes('PROJCS')) {
    return { ok: false, reason: 'PRJ proyectado (PROJCS) — el modelo debe ser geográfico; no se reproyecta' };
  }
  if (!up.includes('GEOGCS')) {
    return { ok: false, reason: 'PRJ sin GEOGCS — no interpretable como geográfico' };
  }
  // Familia datum: WGS84 (WGS_84/WGS_1984) / GRS80 (GRS_1980) / ITRF —
  // con separador espacio o guion bajo (el PRJ real usa «GRS_1980»).
  const fam = up.match(/WGS[\s_]?(19)?84|GRS[\s_]?1980|GRS[\s_]?80|ITRF/);
  if (!fam) {
    const datum = up.match(/DATUM\["([^"]+)"/);
    return {
      ok: false,
      reason: `datum ${datum ? `«${datum[1]}»` : 'no reconocido'} — familia esperada WGS84/GRS80/ITRF (divergencia honesta)`,
    };
  }
  const gcs = up.match(/GEOGCS\["([^"]+)"/);
  return {
    ok: true,
    note: `${gcs ? gcs[1] : 'GEOGCS'} — ${fam[0]} ≈ WGS84 (aproximación documentada, ADR D10)`,
  };
}

/* ------------------------------------------------------------------ */
/* Núcleo: par HDR+BIL(+PRJ) → GeoidModel                              */
/* ------------------------------------------------------------------ */

export function parseBilGeoid(
  hdr: Uint8Array,
  bil: Uint8Array,
  prj: Uint8Array | null,
  name = 'geoid'
): GeoidRead {
  const h = parseHdr(hdr);
  if (!h.ok) return h;

  const kv = h.kv;
  const layout = (kv.get('LAYOUT') ?? '').toUpperCase();
  if (layout !== 'BIL') return { ok: false, reason: `LAYOUT «${layout}» ≠ BIL — no soportado por contrato` };

  const bo = (kv.get('BYTEORDER') ?? '').toUpperCase();
  if (bo !== 'I' && bo !== 'M') {
    return { ok: false, reason: `BYTEORDER «${bo}» desconocido — el HDR declara I (LE) o M (BE)` };
  }

  if ((kv.get('NBANDS') ?? '').trim() !== '1') {
    return { ok: false, reason: `NBANDS «${kv.get('NBANDS')}» ≠ 1 — el geoides es de banda única` };
  }
  if ((kv.get('NBITS') ?? '').trim() !== '32') {
    return { ok: false, reason: `NBITS «${kv.get('NBITS')}» no soportado — el modelo se lee como FLOAT32 (32)` };
  }

  const nrows = Number(kv.get('NROWS'));
  const ncols = Number(kv.get('NCOLS'));
  if (!Number.isInteger(nrows) || !Number.isInteger(ncols) || nrows < 2 || ncols < 2 || nrows > MAX_DIM || ncols > MAX_DIM) {
    return { ok: false, reason: `dims absurdas: NROWS=${kv.get('NROWS')} NCOLS=${kv.get('NCOLS')} (se esperan enteros 2..${MAX_DIM})` };
  }

  const xdim = Number(kv.get('XDIM'));
  const ydim = Number(kv.get('YDIM'));
  if (!Number.isFinite(xdim) || !Number.isFinite(ydim) || xdim <= 0 || ydim <= 0 || xdim > 1 || ydim > 1) {
    return { ok: false, reason: `XDIM/YDIM inválidos: ${kv.get('XDIM')}/${kv.get('YDIM')} (grados, 0 < d ≤ 1)` };
  }

  const ulx = Number(kv.get('ULXMAP'));
  const uly = Number(kv.get('ULYMAP'));
  if (!Number.isFinite(ulx) || !Number.isFinite(uly) || Math.abs(ulx) > 180 || Math.abs(uly) > 90) {
    return { ok: false, reason: `ULXMAP/ULYMAP fuera de rango geográfico: ${kv.get('ULXMAP')}/${kv.get('ULYMAP')}` };
  }

  // Presupuesto EXACTO antes de asignar (truncado o sobrante ⇒ rechazo).
  const expected = nrows * ncols * 4;
  if (expected > MAX_GRID_BYTES) {
    return { ok: false, reason: `presupuesto del grid excedido: ${expected} B declarados > ${MAX_GRID_BYTES}` };
  }
  if (bil.length < expected) {
    return { ok: false, reason: `BIL truncado: ${bil.length} B de ${expected} declarados (faltan ${expected - bil.length})` };
  }
  if (bil.length > expected) {
    return { ok: false, reason: `BIL con sobrante: ${bil.length} B de ${expected} declarados (+${bil.length - expected} B exactos)` };
  }

  // Lectura binaria con el byteorder DECLARADO (honrado, no de plataforma).
  const data = new Float32Array(nrows * ncols);
  if (bo === 'I') {
    // Fast path LE: copia alineada + vista (mismo resultado que DataView LE).
    data.set(new Float32Array(bil.buffer.slice(bil.byteOffset, bil.byteOffset + expected)));
  } else {
    const dv = new DataView(bil.buffer, bil.byteOffset, expected);
    for (let i = 0; i < data.length; i++) data[i] = dv.getFloat32(i * 4, false);
  }

  // NODATA declarado: numérico o NaN («-nan» del GGM25 real ⇒ NaN).
  let nodata: number | null = null;
  const ndRaw = kv.get('NODATA');
  if (ndRaw !== undefined) nodata = Number(ndRaw); // '-nan' → NaN (honrado)

  // Barrido único: min/max sobre celdas válidas + hostil grid-NaN.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isNaN(v)) continue;
    if (nodata !== null && !Number.isNaN(nodata) && v === nodata) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ok: false, reason: 'sin valores válidos (¿todo NODATA?) — hostil grid-NaN' };
  }

  // CRS: default honesto; .prj validado contra la familia.
  let crsNote = 'WGS84/ITRF2008 (default — sin .prj en el contenedor)';
  if (prj) {
    const p = validatePrj(prj);
    if (!p.ok) return p;
    crsNote = p.note;
  }

  return {
    ok: true,
    model: {
      name, w: ncols, h: nrows, ulx, uly, dx: xdim, dy: ydim,
      byteorder: bo as 'I' | 'M', data, nodata, min, max, bytes: expected, crsNote,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Envoltura ZIP (FR-3): el contenedor nacional entra por zip.ts       */
/* ------------------------------------------------------------------ */

function baseOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

export function parseGgm25Zip(bytes: Uint8Array): GeoidRead {
  const zip = readZip(bytes);
  if (!zip.ok) return { ok: false, reason: `ZIP hostil — ${zip.reason}` };
  let hdr: { name: string; data: Uint8Array } | null = null;
  let bil: { name: string; data: Uint8Array } | null = null;
  let prj: Uint8Array | null = null;
  let prjCount = 0;
  for (const e of zip.entries) {
    const lower = e.name.toLowerCase();
    if (lower.endsWith('.hdr')) {
      if (hdr) return { ok: false, reason: `múltiples .hdr («${hdr.name}» y «${e.name}») — par ambiguo` };
      hdr = { name: e.name, data: e.data };
    } else if (lower.endsWith('.bil')) {
      if (bil) return { ok: false, reason: `múltiples .bil («${bil.name}» y «${e.name}») — par ambiguo` };
      bil = { name: e.name, data: e.data };
    } else if (lower.endsWith('.prj')) {
      prjCount++;
      prj = e.data;
    }
    // metadata (.xml/.txt/…) tolerada: zip.ts ya verificó CRC y presupuestos.
  }
  if (prjCount > 1) return { ok: false, reason: `múltiples .prj (${prjCount}) — referencia ambigua` };
  if (!hdr || !bil) {
    return { ok: false, reason: `contenedor sin par HDR+BIL (hdr:${hdr ? 'sí' : 'no'} · bil:${bil ? 'sí' : 'no'})` };
  }
  if (baseOf(hdr.name) !== baseOf(bil.name)) {
    return { ok: false, reason: `miembros desparejados: «${hdr.name}» vs «${bil.name}»` };
  }
  return parseBilGeoid(hdr.data, bil.data, prj, baseOf(hdr.name));
}

/* ------------------------------------------------------------------ */
/* API — bilineal existente (misma fórmula que sampleDemElevation)     */
/* ------------------------------------------------------------------ */

/**
 * Undulación del geoides N(lat,lon) en metros (elipsoide − superficie
 * geoide). NaN fuera de cobertura, en NODATA o con vecindad NODATA.
 *
 * PUERTO D-1 (GPS-ORTO, 2026-10-02): tres mejoras del linaje local
 * (LEDGER DE DELTAS D-1 — informe de cierre
 * 2026-10-01 §4), de comportamiento LATENTE con el GGM25 real (0 celdas
 * NODATA ⇒ indistinguible) y REALES con cualquier grid con NODATA:
 *   1. Épsilon de borde (EPS=1e-9°): una coordenada EXACTA del borde
 *      este/sur muestrea el nodo de borde — antes caía en NaN por
 *      `i >= w-1` (flotante: −102+0.01 ≠ −101.99).
 *   2. NODATA-por-pesos: una celda solo anula la muestra si su peso
 *      bilineal es > 0; en el borde exacto (t=0/1) la celda lejana NO
 *      participa y su NODATA jamás envenena el resultado.
 *   3. Lerp bit-exacto: t=0/1 devuelve el NODO sin aritmética
 *      (`a+(b−a)·1` no siempre es `b` en IEEE-754) — paridad exacta
 *      con el nodo. Para 0<t<1 la fórmula es LA MISMA de antes
 *      (`a+(b−a)·t`) ⇒ resultados bit-idénticos en el interior.
 */
export function undulation(model: GeoidModel, lat: number, lon: number): number {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NaN;
  // centro del píxel: ULXMAP + c·XDIM (este) · ULYMAP − r·YDIM (sur)
  // Épsilon de borde en GRADOS (fiel a la custodia D-1): una coordenada
  // dentro de EPS del límite de cobertura es COBERTURA — el nodo de borde
  // se alcanza por el clamp de la última banda (t=1 bit-exacto).
  const maxX = model.w - 1;
  const maxY = model.h - 1;
  const lonMax = model.ulx + maxX * model.dx;
  const latMin = model.uly - maxY * model.dy;
  if (lon < model.ulx - EPS_BORDE || lon > lonMax + EPS_BORDE) return NaN;
  if (lat < latMin - EPS_BORDE || lat > model.uly + EPS_BORDE) return NaN;
  const xf = (lon - model.ulx) / model.dx;
  const yf = (model.uly - lat) / model.dy;
  let i = Math.floor(xf);
  let j = Math.floor(yf);
  // Borde exacto derecho/inferior: última celda, sin celda fantasma.
  if (i > maxX - 1) i = maxX - 1;
  if (j > maxY - 1) j = maxY - 1;
  if (i < 0 || j < 0) return NaN;
  const fx = Math.min(Math.max(xf - i, 0), 1);
  const fy = Math.min(Math.max(yf - j, 0), 1);
  const d = model.data;
  const v00 = d[j * model.w + i];
  const v10 = d[j * model.w + i + 1];
  const v01 = d[(j + 1) * model.w + i];
  const v11 = d[(j + 1) * model.w + i + 1];
  const nd = model.nodata;
  const bad = (v: number): boolean =>
    Number.isNaN(v) || (nd !== null && !Number.isNaN(nd) && v === nd);
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  if (
    (w00 > 0 && bad(v00)) ||
    (w10 > 0 && bad(v10)) ||
    (w01 > 0 && bad(v01)) ||
    (w11 > 0 && bad(v11))
  )
    return NaN;
  const lerp = (a: number, b: number, t: number): number =>
    t === 1 ? b : t === 0 ? a : a + (b - a) * t;
  const top = lerp(v00, v10, fx);
  const bottom = lerp(v01, v11, fx);
  return lerp(top, bottom, fy);
}

/**
 * Cota ortométrica H = h − N (h elipsoidal del receptor GNSS). NaN si el
 * punto cae fuera de cobertura o en NODATA (honesto — jamás se inventa).
 */
export function toOrthometric(
  model: GeoidModel,
  lat: number,
  lon: number,
  hEllipsoidalM: number
): number {
  const n = undulation(model, lat, lon);
  return Number.isNaN(n) ? NaN : hEllipsoidalM - n;
}

/** Filas de ficha deterministas (sin tiempos — la paridad worker/sync). */
export function geoidFichaRows(model: GeoidModel): Array<[string, string]> {
  const fmt = (v: number): string => v.toLocaleString('es-MX', { maximumFractionDigits: 3 });
  return [
    ['Datum vertical', `«${model.name}» (ortométrica) — N de undulación`],
    ['Geoid (rejilla)', `${model.w.toLocaleString('es-MX')} × ${model.h.toLocaleString('es-MX')} celdas · ${fmt(model.dx * 60)}′/celda`],
    ['Undulación', `${fmt(model.min)} … ${fmt(model.max)} m`],
    ['CRS horizontal', model.crsNote],
  ];
}
