/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * gps/orto.ts — GPS-ORTO: reglas honestas de conversión de cota y
 * consistencia contra las curvas del mapa (FR-7).
 *
 * PUERTO D-1 (directiva del propietario, agenda documento interno de reinicio §2.1,
 * 2026-10-02): núcleo puro del linaje local ADAPTADO a la arquitectura
 * del árbol — las rutas y contratos cambian, las REGLAS no:
 *   - geoid: el árbol lo resuelve con `src/lib/ingest/geoid.ts`
 *     (`undulation` NaN-semantics, golden GGM25 doble lector) — no con el
 *     geoid del linaje local (`model.sample` null-semantics).
 *   - escena: mapeo `fixToSceneM` de `src/lib/gps/scene.ts` (equirectangular
 *     local, convención marco INEGI) — no `wgs84ToScene` UTM14N del
 *     linaje local. La demo es AUTO-CONSISTENTE: mismo mapeo en ida y
 *     vuelta ⇒ el delta contra las curvas no depende del mapeo elegido.
 *   - muestreo del MDT: SAMPLER INYECTADO (`(xM,yM) ⇒ number|null`) — el
 *     panel aporta el muestreo honesto (`sampleGridZ` con bounds) del
 *     modelo ACTIVO (procedural o DEM real del CEM); el módulo no conoce
 *     el Grid (Surgical Changes).
 *
 * Reglas FR-7 (verbatim del checkpoint, custodia gps.ts):
 *   - El chip SIEMPRE reporta elipsoidal (W3C coords.altitude). La
 *     conversión a ortométrica ocurre ÚNICAMENTE con geoid activo y fix
 *     en cobertura. Sin geoid ⇒ cota elipsoidal-DECLARADA, sin conversión,
 *     sin valores horneados (lección «los datos falsos apagan la señal
 *     que los corrige»).
 *   - Tolerancia declarada (laboratorio): LAB_TOLERANCE_M — la
 *     consistencia cota-chip vs curvas se mide contra el MDT del lienzo;
 *     la validación con dispositivo físico es la columna FR-9.
 *   - La simulación de laboratorio (FR-W1) construye un fix con la N REAL
 *     del geoid activo y la z del MDT del lienzo — la UI la etiqueta
 *     SIEMPRE como «simulación», jamás como fix real.
 */

import { undulation, type GeoidModel } from '@/lib/ingest/geoid';
import type { GpsFix } from './types';

/** Tolerancia de laboratorio (m): «cota del chip consistente con las
 *  curvas del mapa (± tolerancia declarada)». Valor del checkpoint. */
export const LAB_TOLERANCE_M = 1.0 as const;

/** Etiqueta de datum SIN geoid activo (fila de cajetín honesta). */
export const DATUM_ELLIPSOIDAL = 'elipsoidal WGS84 (declarada)' as const;

/* ------------------------------------------------------------------ */
/* Regla FR-7: decidir la cota del fix                                 */
/* ------------------------------------------------------------------ */

export interface CotaResult {
  /** Cota a mostrar (m). null = el chip no reportó altitud. */
  cota: number | null;
  /** Etiqueta de datum vigente (fila de cajetín). */
  datum: string;
  /** Separación geooidal aplicada (null si no hubo conversión). */
  n: number | null;
  /** Nota honesta de la regla aplicada (para la ficha/UI). */
  note: string;
}

/** Regla FR-7 completa: decide si la cota del fix se convierte.
 *  La etiqueta de datum es la DEL MODELO USADO — nunca miente. */
export function resolveCota(fix: GpsFix, model: GeoidModel | null): CotaResult {
  if (fix.altitudeM === null || !Number.isFinite(fix.altitudeM)) {
    return {
      cota: null,
      datum: DATUM_ELLIPSOIDAL,
      n: null,
      note: 'sin cota del chip — el dispositivo no reportó altitud',
    };
  }
  if (!model) {
    return {
      cota: fix.altitudeM,
      datum: DATUM_ELLIPSOIDAL,
      n: null,
      note: 'geoid no activo — cota elipsoidal declarada, SIN conversión (FR-7)',
    };
  }
  const n = undulation(model, fix.lat, fix.lon);
  if (!Number.isFinite(n)) {
    return {
      cota: fix.altitudeM,
      datum: DATUM_ELLIPSOIDAL,
      n: null,
      note: 'posición fuera de cobertura del geoide — cota elipsoidal declarada (FR-7)',
    };
  }
  return {
    cota: fix.altitudeM - n,
    datum: `${model.name} (ortométrica)`,
    n,
    note: 'cota ortométrica H = h − N',
  };
}

/* ------------------------------------------------------------------ */
/* Consistencia cota-chip vs curvas del mapa                           */
/* ------------------------------------------------------------------ */

/** Muestreo honesto del MDT del lienzo en (xM,yM) de escena: null fuera
 *  del recorte (un fix fuera del MDT NO se ancla al borde). */
export type ZSampler = (xM: number, yM: number) => number | null;

export interface CurvasCheck {
  ok: boolean;
  /** z del MDT en la posición (m) — la cota que dibujan las curvas. */
  zDem: number | null;
  /** Delta cota-chip − z-MDT (m). */
  delta: number | null;
  tolM: number;
  /** Banda de curva (intervalo 1 m) de cada cota, para el informe. */
  bandDem: number | null;
  bandCota: number | null;
  reason: string;
}

/** Aceptación GPS-ORTO: «cota del chip consistente con las curvas del
 *  mapa (± tolerancia declarada)». La banda de curva es floor(cota/1 m). */
export function curvasConsistency(
  zAt: ZSampler,
  xM: number,
  yM: number,
  cota: number,
  tolM: number = LAB_TOLERANCE_M
): CurvasCheck {
  const zDem = zAt(xM, yM);
  if (zDem === null || !Number.isFinite(zDem)) {
    return {
      ok: false,
      zDem: null,
      delta: null,
      tolM,
      bandDem: null,
      bandCota: null,
      reason: 'posición fuera del MDT del lienzo',
    };
  }
  const delta = cota - zDem;
  const ok = Math.abs(delta) <= tolM;
  return {
    ok,
    zDem,
    delta,
    tolM,
    bandDem: Math.floor(zDem),
    bandCota: Math.floor(cota),
    reason: ok ? 'consistente ± tolerancia declarada' : 'excede la tolerancia declarada',
  };
}

/* ------------------------------------------------------------------ */
/* Simulación de laboratorio (FR-W1 — siempre etiquetada)              */
/* ------------------------------------------------------------------ */

/** Construye un fix de laboratorio en (lon,lat): h = z_MDT + N_real.
 *  Tras resolveCota la cota regresa a z_MDT ⇒ consistente con las curvas.
 *  null si la posición cae fuera del MDT o del geoide (honesto). */
export function simulateFixAt(
  lon: number,
  lat: number,
  zAt: ZSampler,
  toScene: (lon: number, lat: number) => { xM: number; yM: number; dentro: boolean } | null,
  model: GeoidModel | null,
  accM = 3.0
): GpsFix | null {
  const pt = toScene(lon, lat);
  if (!pt || !pt.dentro) return null;
  const z = zAt(pt.xM, pt.yM);
  if (z === null) return null;
  let hEllips = z;
  if (model) {
    const n = undulation(model, lat, lon);
    if (!Number.isFinite(n)) return null;
    hEllips = z + n;
  }
  return {
    lon,
    lat,
    altitudeM: hEllips,
    altitudeAccuracyM: null,
    accuracyM: accM,
    timestampMs: 0,
    source: 'simulacion',
  };
}
