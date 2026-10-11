/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-7 · V-1 sintética (FR-W1) — fixtures GPS deterministas y round-trip
 * contra FR-1 (spec R-B §6/§8 A-9). Coordenadas SINTÉTICAS sembradas
 * (centro de la región + offsets deterministas); JAMÁS coordenadas reales
 * (I-3/W1). UTM 14N vía `wgs84ToUtm14n`/`utm14nToWgs84` de FR-1 — NO se
 * escribe una segunda conversión.
 */
import { wgs84ToUtm14n, utm14nToWgs84 } from '@/lib/ingest/geojson';
import type { GpsFix } from './types';

/** Offsets deterministas alrededor del centro de la región (metros). */
const OFFSETS_M: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0, 0],
  [120, 40],
  [-250, -90],
  [80, -310],
  [-420, 260],
] as const);

/** Convierte offsets métricos a grados (inversa del mapeo de scene.ts). */
export function gpsFixturesSinteticos(
  centerLat: number,
  centerLon: number
): GpsFix[] {
  return OFFSETS_M.map(([dxM, dyM], i) => {
    const lon = centerLon + dxM / (111_320 * Math.cos(centerLat));
    const lat = centerLat + dyM / 110_574;
    /* accuracy determinista creciente (honestidad P-3: siempre ±N m visible).
       PUERTO D-1: fixtures de laboratorio ⇒ source 'simulacion' (honesto) y
       altitud null (no se simula altitud en V-1 — la orto se prueba en orto). */
    return { lat, lon, accuracyM: 4 + i * 7, timestampMs: 0, altitudeM: null, altitudeAccuracyM: null, source: 'simulacion' };
  });
}

/**
 * A-9 (V-1): round-trip WGS84⇄UTM14N con las funciones de FR-1.
 * Devuelve el desvío angular máximo (grados) del round-trip.
 */
export function desvioRoundTripWgs84Utm(
  fixes: ReadonlyArray<GpsFix>
): { maxDesvioGrados: number; pares: Array<{ ok: boolean; desvio: number }> } {
  let maxDesvio = 0;
  const pares: Array<{ ok: boolean; desvio: number }> = [];
  for (const f of fixes) {
    const utm = wgs84ToUtm14n(f.lon, f.lat);
    if (!utm) {
      pares.push({ ok: false, desvio: Number.NaN });
      continue;
    }
    const inverse = utm14nToWgs84(utm[0], utm[1]); // devuelve [lon, lat] (FR-1)
    if (!inverse) {
      pares.push({ ok: false, desvio: Number.NaN });
      continue;
    }
    const desvio = Math.max(Math.abs(inverse[1] - f.lat), Math.abs(inverse[0] - f.lon));
    maxDesvio = Math.max(maxDesvio, desvio);
    pares.push({ ok: true, desvio });
  }
  return { maxDesvioGrados: maxDesvio, pares };
}
