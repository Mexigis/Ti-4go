/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * REFACTOR-2 · hook extraído de TerrainViewer (gate triple: suite monótona +
 * smoke 14/14 + E2E dorado — «el refactor que rompe el smoke no se mergea»).
 *
 * FR-7/A-8 · puente GPS ↔ motor: (1) el Anchor de la región activa alimenta
 * el recálculo dentro/fuera de región del controlador GPS (setAnchor es puro
 * estado — 0 llamadas a geolocation aquí; el disparo vive SOLO en el chip);
 * (2) el estado del controlador entra al motor como DATO de escena (W5) —
 * sin fix o sin tono ⇒ marcador ausente; el motor proyecta con su convención
 * de marco. El estado del fix JAMÁS toca geolocation aquí (P-1).
 *
 * Comportamiento byte-idéntico a los dos efectos inline que vivían en
 * TerrainViewer.tsx (bloques FR-7 y A-8) — mismas dependencias, mismo orden.
 */

import { useEffect, type RefObject } from 'react';
import { gpsController, useGpsState } from '@/lib/gps/gpsController';
import { gpsMarkerTone, type GpsMarkerTone } from '@/lib/gps/marker';
import type { GpsState } from '@/lib/gps/types';
import type { IsoEngine } from '@/lib/terrain/engine';

/** Región mínima que alimenta el puente (subset de RegionDef). */
export interface GpsBridgeRegion {
  centerLat: number;
  centerLon: number;
  extent: number;
}

/** Anchor del controlador — forma EXACTA que gpsController.setAnchor espera. */
export interface GpsBridgeAnchor {
  centerLat: number;
  centerLon: number;
  extentM: number;
}

/** Payload del marcador — forma EXACTA que IsoEngine.setGpsMarker espera. */
export interface GpsMarkerPayload {
  lat: number;
  lon: number;
  tone: GpsMarkerTone;
}

/** Mapeo puro región → Anchor (known-answer del forense: extent ⇒ extentM). */
export function anchorFromRegion(region: GpsBridgeRegion): GpsBridgeAnchor {
  return { centerLat: region.centerLat, centerLon: region.centerLon, extentM: region.extent };
}

/**
 * Decisión pura del marcador (extraída para el forense): fix presente Y tono
 * presente ⇒ payload; cualquier ausencia ⇒ marcador nulo (A-8: sin fix o sin
 * tono ⇒ marcador ausente). Sin DOM, sin geolocation — known-answers puros.
 */
export function gpsMarkerPayload(
  gps: Pick<GpsState, 'fix' | 'status'>,
  tone: GpsMarkerTone | null
): GpsMarkerPayload | null {
  if (!gps.fix || !tone) return null;
  return { lat: gps.fix.lat, lon: gps.fix.lon, tone };
}

export interface UseGpsBridgeArgs {
  /** Región activa (el Anchor se re-ancla en cada cambio + cleanup null). */
  region: GpsBridgeRegion;
  /** Motor vivo de la instancia (el marcador es estado de ESA escena). */
  engineRef: RefObject<IsoEngine | null>;
  /** Identidad del HUD — el efecto reaplica al recrearse el motor. */
  onHud: unknown;
}

export function useGpsBridge({ region, engineRef, onHud }: UseGpsBridgeArgs): void {
  /* FR-7 · contrato v1: el Anchor de la región activa alimenta el recálculo
     dentro/fuera de región del controlador GPS (setAnchor es puro estado —
     0 llamadas a geolocation aquí; el disparo vive SOLO en el chip). */
  useEffect(() => {
    gpsController.setAnchor(anchorFromRegion(region));
    return () => {
      gpsController.setAnchor(null);
    };
  }, [region]);

  /* A-8 · marcador GPS en el motor: el estado del controlador es DATO de
     escena (W5) — sin fix o sin tono ⇒ marcador ausente; el motor proyecta
     con su convención de marco. El estado del fix JAMÁS toca geolocation
     aquí (P-1: el disparo vive SOLO en el chip de FR-6). Reaplica también
     al recrearse el motor (onHud — misma identidad de instancia). */
  const gps = useGpsState();
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    const tone = gpsMarkerTone(gps.status);
    eng.setGpsMarker(gpsMarkerPayload(gps, tone), anchorFromRegion(region));
  }, [gps, region, onHud, engineRef]);
}
