/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-5 — Campo de fricción (ADR D12): capa de campo escalar con semántica
 * de COSTO para el LIENZO (checkpoint de ingeniería,
 * contrato b).
 *
 * El raster de fricción (`friction_mesh_10m.tif` u otro campo de costo)
 * llega por el decodificador GeoTIFF existente (geotiff-dem.ts — CRS,
 * NODATA, strips None/LZW/Deflate/PackBits íntegros) y aquí recibe su
 * SEMÁNTICA: normalización determinista del costo sobre celdas válidas y
 * clasificación E-Ink en 4 clases (0 = paso libre sin trama).
 *
 * Detección de la capa (D12 §2.1):
 *   - archivo suelto: nombre contiene `fricc` (cubre friction y friccion) —
 *     sin la marca sigue siendo MDT (Motor DEM Real intacto);
 *   - Mission Pack: rol FRICTION.TIF / FRICTION / FRICTION_TIF.
 *
 * 0 GPU / CPU puro / determinista. La clase es función PURA del valor:
 * misma celda ⇒ misma clase en ingest, motor y export (WYSIWYG).
 */

import type { DemCrs, DemRaster, DecodedDem } from './geotiff-dem';

/* ------------------------------------------------------------------ */
/* Constantes D12                                                     */
/* ------------------------------------------------------------------ */

/** Detección por nombre (archivo suelto) — D12 §2.1.
 *  ENMIENDA E2E (re-entrada 2026-09-29, ): el patrón
 *  original /fricc/ NO cubría la grafía inglesa «friction» (UNA sola c;
 *  «fricción» la tiene doble) — el fixture friction_mesh_sintetico.tif se
 *  enrutaba a MDT («falso MDT REAL»). Ahora cubre ambas grafías. */
export const FRICTION_NAME_RE = /fricc|friction/i;

/** Fronteras de clase sobre el costo normalizado c ∈ [0,1] (D12 §3). */
export const FRICTION_CLASS_EDGES = [0.25, 0.5, 0.75] as const;

/** Longitud de trazo en px de pantalla por clase (0 = sin trama). */
export const FRICTION_LEN_PX = [0, 3, 5.5, 8] as const;

/** Celda NODATA en el mapa de clases (sin tinta, sin tramo). */
export const FRICTION_NODATA_CLASS = 255;

/** Tope de tinta de la trama sobre el área del campo (D12 §3, presupuesto
 *  E-Ink: el margen par-a-par ≥ 0.004 se mantiene con tinta ≤ 22 %). */
export const LEHMAN_TRAMA_INK_BUDGET = 0.22;

/* ------------------------------------------------------------------ */
/* Tipos                                                              */
/* ------------------------------------------------------------------ */

/** Anclaje escénico mínimo para colocar el campo en metros-mundo. */
export interface FrictionAnchor {
  centerLat: number;
  centerLon: number;
  extentM: number;
  zMinM: number;
  zMaxM: number;
}

/** Campo de fricción listo para el motor: raster crudo + clases D12. */
export interface FrictionField {
  w: number;
  h: number;
  /** Valores crudos de costo (fila 0 = Norte; índice r*w+c). */
  data: DemRaster;
  /** Clase D12 por celda (0..3; 255 = NODATA). */
  classes: Uint8Array;
  /** Celdas por clase [c0, c1, c2, c3]. */
  classCounts: [number, number, number, number];
  /** Rango de costo válido (normalización determinista). */
  vmin: number;
  vmax: number;
  nodata: number | null;
  crs: DemCrs;
  scaleX: number;
  scaleY: number;
  tieX: number;
  tieY: number;
  sampleLabel: string;
  compression: string;
}

/* ------------------------------------------------------------------ */
/* Clasificación (pura — la usa ingest, motor, export y la suite)     */
/* ------------------------------------------------------------------ */

/** Clase D12 de un costo normalizado (fronteras [0.25, 0.5, 0.75]). */
export function frictionClassNorm(c: number): number {
  if (!(c >= FRICTION_CLASS_EDGES[0])) return 0;
  if (c < FRICTION_CLASS_EDGES[1]) return 1;
  if (c < FRICTION_CLASS_EDGES[2]) return 2;
  return 3;
}

/** Clase D12 de un valor crudo dado el rango válido del campo. */
export function frictionClassOf(v: number, vmin: number, vmax: number): number {
  if (!Number.isFinite(v)) return FRICTION_NODATA_CLASS;
  const span = vmax - vmin;
  if (!(span > 0)) return 0; // campo constante: paso libre único (honesto)
  return frictionClassNorm((v - vmin) / span);
}

/* ------------------------------------------------------------------ */
/* Construcción del campo                                             */
/* ------------------------------------------------------------------ */

function isNodata(v: number, nodata: number | null): boolean {
  if (Number.isNaN(v)) return true;
  if (nodata === null) return false;
  if (Number.isNaN(nodata)) return true; // NODATA declarado 'nan'
  return v === nodata;
}

/**
 * Envuelve un raster GeoTIFF decodificado como campo de fricción D12:
 * rango válido (excluye NODATA) + clase por celda + conteos. Lanza Error
 * accionable si el campo no tiene ni una celda válida (todo NODATA).
 */
export function buildFrictionField(dem: DecodedDem): FrictionField {
  const { w, h, data, nodata } = dem;
  let vmin = Infinity;
  let vmax = -Infinity;
  let nodataCount = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    if (isNodata(v, nodata)) {
      nodataCount++;
      continue;
    }
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) {
    throw new Error('Campo de fricción sin valores válidos (¿todo NODATA?) — verifique el export del GeoTIFF (gdal_translate -co COMPRESS=DEFLATE)');
  }
  const classes = new Uint8Array(w * h);
  const classCounts: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    if (isNodata(v, nodata)) {
      classes[i] = FRICTION_NODATA_CLASS;
      continue;
    }
    const cl = frictionClassOf(v, vmin, vmax);
    classes[i] = cl;
    classCounts[cl]++;
  }
  void nodataCount;
  return {
    w,
    h,
    data,
    classes,
    classCounts,
    vmin,
    vmax,
    nodata,
    crs: dem.crs,
    scaleX: dem.scaleX,
    scaleY: dem.scaleY,
    tieX: dem.tieX,
    tieY: dem.tieY,
    sampleLabel: dem.sampleLabel,
    compression: dem.compression,
  };
}

/* ------------------------------------------------------------------ */
/* Colocación escénica (pura — la comparten motor y export)           */
/* ------------------------------------------------------------------ */

export interface FrictionPlacement {
  /** Metros-mundo por celda; Y NEGATIVO (fila 0 = Norte ⇒ y decrece). */
  cellXm: number;
  cellYm: number;
  /** Coordenada mundo del centro del píxel (0,0) (fila 0 = Norte). */
  originX: number;
  originY: number;
  /** 'georef': CRS geográfico anclado a la región · 'centro': honesto. */
  placed: 'georef' | 'centro';
}

/**
 * Coloca el campo en metros-mundo de la escena (D12 §2): CRS geográfico ⇒
 * georreferenciación real con la convención equirectangular local del marco
 * INEGI (mPerLon en el centro de la región); cualquier otro CRS ⇒ colocación
 * por CENTRO de la región activa con nota honesta (v1 no reproyecta UTM).
 * Convención de filas del TIFF: fila 0 = Norte (geotiff-dem.ts) — se
 * preserva SIEMPRE mediante cellYm negativo.
 */
export function frictionPlacement(f: FrictionField, a: FrictionAnchor): FrictionPlacement {
  const rad = (a.centerLat * Math.PI) / 180;
  const mPerLon = 111320 * Math.cos(rad);
  if (f.crs.kind === 'geographic') {
    return {
      cellXm: f.scaleX * mPerLon,
      cellYm: -f.scaleY * 111320,
      originX: (f.tieX + 0.5 * f.scaleX - a.centerLon) * mPerLon,
      originY: (f.tieY - 0.5 * f.scaleY - a.centerLat) * 111320,
      placed: 'georef',
    };
  }
  const cellXm = Math.abs(f.scaleX) || 10;
  // D12 §2 — convención de filas del TIFF: fila 0 = Norte, preservada
  // SIEMPRE mediante cellYm negativo (también en colocación por centro;
  // hallazgo de la suite forense FR-5 — known-answer de orientación).
  const cellYm = -(Math.abs(f.scaleY) || 10);
  return {
    cellXm,
    cellYm,
    originX: (-(f.w - 1) / 2) * cellXm,
    originY: ((f.h - 1) / 2) * -cellYm,
    placed: 'centro',
  };
}

/* ------------------------------------------------------------------ */
/* Ficha D12                                                          */
/* ------------------------------------------------------------------ */

/** Fila de ficha D12 (legible, determinista) para meta.rows. */
export function frictionRows(f: FrictionField): Array<[string, string]> {
  const pct = (n: number): string => `${((n / (f.w * f.h)) * 100).toFixed(1)} %`;
  return [
    ['Campo de fricción (D12)', `costo ${f.vmin.toPrecision(4)} – ${f.vmax.toPrecision(4)} · ${f.sampleLabel} · ${f.compression}`],
    [
      'Clases D12',
      `libre ${pct(f.classCounts[0])} · baja ${pct(f.classCounts[1])} · media ${pct(f.classCounts[2])} · alta ${pct(f.classCounts[3])}`,
    ],
    ['NODATA', f.nodata === null ? 'sin declaración' : `${f.nodata} — excluido del costo y de la trama`],
  ];
}
