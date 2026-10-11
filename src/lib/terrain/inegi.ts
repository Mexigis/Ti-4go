/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Marco cartográfico INEGI (Mapa Topográfico Nacional) de referencia para
 * las microcuencas de Guanajuato.
 *
 * Datos verificados:
 *  - Las cartas del MTN a escala 1:50 000 cubren 20′ de longitud × 15′ de
 *    latitud (~960 km² por carta) — INEGI, "Guía para la interpretación de
 *    cartografía topográfica".
 *  - La indexación dentro de cada cuadrángulo (p. ej. F14C43) usa filas
 *    A–E (norte → sur) y columnas 1–5 (poniente → oriente).
 *  - Las cartas F14C43D4, F14C43E3, F14C53A2 y F14C53B1 abarcan en conjunto
 *    la zona de estudio de la Cuenca de la Soledad (marco documentado en
 *    tesis de la Universidad de Guanajuato, repositorio.ugto.mx).
 *
 * El relieve mostrado en el visor es procedural; las cartas se presentan
 * como referencia cartográfica oficial de la zona, no como fuente del MDT.
 */

export interface InegiSheet {
  /** Clave completa de la carta, p. ej. "F14C43D4" */
  code: string;
  /** Cuadrángulo 1:250 000 al que pertenece */
  quad: string;
  /** Fila dentro del cuadrángulo (A–E, norte → sur) */
  row: string;
  /** Columna dentro del cuadrángulo (1–5, poniente → oriente) */
  col: number;
}

export const INEGI_SCALE = '1:50 000';
export const INEGI_FORMAT = '20′ × 15′ · ~960 km² por carta';

/** Filas de indexación A–E */
export const INEGI_ROWS = ['A', 'B', 'C', 'D', 'E'] as const;

/** Las cuatro cartas que cubren la zona de estudio (orden dado por el usuario) */
export const INEGI_SHEETS: InegiSheet[] = [
  { code: 'F14C43D4', quad: 'F14C43', row: 'D', col: 4 },
  { code: 'F14C43E3', quad: 'F14C43', row: 'E', col: 3 },
  { code: 'F14C53A2', quad: 'F14C53', row: 'A', col: 2 },
  { code: 'F14C53B1', quad: 'F14C53', row: 'B', col: 1 },
];

/** Códigos unidos con separador, para sellos y pies de figura */
export function inegiCodesJoin(sep = ' · '): string {
  return INEGI_SHEETS.map((s) => s.code).join(sep);
}

/** Formatea una latitud/longitud decimal como grados y minutos, p. ej. 21°04′ */
export function formatDegMin(deg: number): string {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.round((abs - d) * 60);
  const mm = m === 60 ? 0 : m;
  const dd = m === 60 ? d + 1 : d;
  return `${dd}°${String(mm).padStart(2, '0')}′`;
}
