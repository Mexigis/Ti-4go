/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-7 · escena — mapeo determinista fix→escena (función PURA, spec R-B §5.1).
 *
 * Equirectangular local con la MISMA convención del marco INEGI / colocación
 * geográfica de D12 §2:
 *   xM = (lon − centerLon) · cos(centerLat) · 111_320
 *   yM = (lat − centerLat) · 110_574
 * dentro = |xM| ≤ extentM/2 && |yM| ≤ extentM/2 (si no: «fuera de región» —
 * el marcador JAMÁS se dibuja fuera del lienzo, sin reproyecciones heroicas).
 * 0 GPU (W5): esto es dato, como un archivo ingestado.
 */
export interface GpsAnchor {
  centerLat: number;
  centerLon: number;
  /** Extent de la región en metros (Anchor de REGIONS). */
  extentM: number;
}

export interface GpsScenePos {
  xM: number;
  yM: number;
  dentro: boolean;
}

/** Radio ecuatorial/polar simplificado de la casa (metros por grado). */
export const M_POR_GRADO_LAT = 110_574 as const;

export function fixToSceneM(
  fixLat: number,
  fixLon: number,
  anchor: GpsAnchor
): GpsScenePos {
  /* centerLat llega en GRADOS (Anchor de REGIONS) — cos exige radianes. */
  const xM = (fixLon - anchor.centerLon) * Math.cos((anchor.centerLat * Math.PI) / 180) * 111_320;
  const yM = (fixLat - anchor.centerLat) * M_POR_GRADO_LAT;
  const dentro =
    Math.abs(xM) <= anchor.extentM / 2 && Math.abs(yM) <= anchor.extentM / 2;
  return { xM, yM, dentro };
}
