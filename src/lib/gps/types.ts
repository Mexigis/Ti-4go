/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-7 · tipos del GPS bajo demanda (spec R-B §6, contrato v1 con el SLOT de
 * FR-6). Máquina finita de 9 estados (§3.2) — FR-W3 rige: ninguna llamada a
 * geolocation sin acción explícita previa (P-1); el fix es DATO en memoria,
 * nunca persistido (I-6) ni mostrado sin su precisión (P-3).
 */
export type GpsStatus =
  | 'inactivo'
  | 'solicitando'
  | 'adquiriendo'
  | 'activo'
  | 'degradado'
  | 'sin-senal'
  | 'denegado'
  | 'error'
  | 'no-disponible';

export interface GpsFix {
  /** WGS84 grados (rango validado — hostil ⇒ descarte). */
  lat: number;
  lon: number;
  /** coords.accuracy del dispositivo (≥ 0) — se presenta SIEMPRE como «±N m». */
  accuracyM: number;
  /** Marca del dispositivo (sin reloj propio). */
  timestampMs: number;
  /** Altitud ELIPSOIDAL del chip (m) — W3C coords.altitude; null cuando el
   *  dispositivo no la reporta (honesto, FR-7: jamás se hornea un valor).
   *  PUERTO D-1: la conversión a ortométrica vive en gps/orto.ts y ocurre
   *  SOLO con geoid activo + fix en cobertura. */
  altitudeM: number | null;
  /** coords.altitudeAccuracy (m) — null frecuente en dispositivos. */
  altitudeAccuracyM: number | null;
  /** 'chip' = fix real del dispositivo · 'simulacion' = FR-W1 laboratorio. */
  source: 'chip' | 'simulacion';
}

export interface GpsState {
  status: GpsStatus;
  fix: GpsFix | null;
  /** El fix cae dentro del extentM del Anchor activo (spec §5.1). */
  dentroDeRegion: boolean;
  /** Lista para el chip de FR-6 — SIN coordenadas crudas (I-1). */
  etiquetaCorta: string;
  /** Accionable y SIN coordenadas (I-1). */
  lastError: string | null;
  watchId: number | null;
}

/** Umbral de degrade (spec §3.2 — 25 m, valor PROPUESTA de la spec). */
export const GPS_UMBRAL_DEGRADE_M = 25 as const;
/** Timeout honesto de señal (spec §3.2 — 12 s con watch vivo). */
export const GPS_TIMEOUT_SIN_SENAL_MS = 12_000 as const;
