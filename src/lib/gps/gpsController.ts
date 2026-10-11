/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-7 · controlador GPS (singleton, patrón del controlador de ingesta —
 * useSyncExternalStore + snapshot inmutable). Spec R-B §3/§6, contrato v1.
 *
 * - P-1: requestStart() SOLO desde interacción explícita del usuario; este
 *   módulo jamás se auto-activa en hidratación ni re-intenta.
 * - P-2: ciclo cerrado — requestStop() hace clearWatch y sube la GENERACIÓN:
 *   los fixes en vuelo de un watch cancelado se descartan (0 efectos).
 * - P-3: degrade honesto — precisión SIEMPRE visible como «±N m» (techo),
 *   jamás se promete precisión fija; sin señal ⇒ estado visible con watch vivo.
 * - P-4: permiso como primera ciudadanía — denegado es terminal, sin reintentos.
 * - I-1/I-2/I-6: 0 coordenadas en consola; 0 red; 0 persistencia — el fix vive
 *   y muere en memoria.
 */
import { useSyncExternalStore } from 'react';
import {
  GPS_TIMEOUT_SIN_SENAL_MS,
  GPS_UMBRAL_DEGRADE_M,
  type GpsFix,
  type GpsState,
  type GpsStatus,
} from './types';
import type { GpsAnchor } from './scene';

type Listener = () => void;

/** Fuente de geolocation inyectable (los tests la sustituyen; A-2). */
type GeoLike = {
  watchPosition(
    ok: (fix: {
      coords: {
        latitude: number;
        longitude: number;
        accuracy: number;
        /** W3C: altitud elipsoidal (m) — null frecuente (puerto D-1). */
        altitude?: number | null;
        altitudeAccuracy?: number | null;
      };
      timestamp: number;
    }) => void,
    err: (e: { code: number; message?: string }) => void,
    opts?: { enableHighAccuracy?: boolean; maximumAge?: number }
  ): number;
  clearWatch(id: number): void;
};

function obtenerGeo(): GeoLike | null {
  if (typeof navigator === 'undefined') return null;
  const g = (navigator as { geolocation?: GeoLike }).geolocation;
  return g ?? null;
}

const ETIQUETAS: Record<GpsStatus, string> = {
  inactivo: '',
  solicitando: 'GPS — solicitando…',
  adquiriendo: 'GPS — buscando señal',
  activo: 'GPS activo',
  degradado: 'GPS (pobre)',
  'sin-senal': 'GPS — sin señal',
  denegado: 'GPS — permiso denegado',
  error: 'GPS — error',
  'no-disponible': 'GPS — no disponible',
};

function estadoInicial(): GpsState {
  return {
    status: 'inactivo',
    fix: null,
    dentroDeRegion: false,
    etiquetaCorta: ETIQUETAS.inactivo,
    lastError: null,
    watchId: null,
  };
}

class GpsController {
  private listeners = new Set<Listener>();
  private estado: GpsState = estadoInicial();
  private generacion = 0;
  private geo: GeoLike | null = null;
  private timeoutSenal: ReturnType<typeof setTimeout> | null = null;
  private anchor: GpsAnchor | null = null;

  /* --- suscripción (useSyncExternalStore) ------------------------- */
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getState = (): GpsState => this.estado;

  /** El viewer aporta el Anchor de la región activa (recálculo determinista). */
  setAnchor = (anchor: GpsAnchor | null): void => {
    this.anchor = anchor;
    if (this.estado.fix) this.recalc();
  };

  private emitir(): void {
    for (const fn of this.listeners) fn();
  }

  private transicion(status: GpsStatus, patch: Partial<GpsState> = {}): void {
    this.estado = {
      ...this.estado,
      ...patch,
      status,
      etiquetaCorta: patch.etiquetaCorta ?? ETIQUETAS[status],
    };
    this.emitir();
  }

  /** P-1 — invocar SOLO desde un handler de interacción del usuario. */
  requestStart = (): void => {
    if (this.estado.status !== 'inactivo' && this.estado.status !== 'sin-senal') return;
    this.geo = obtenerGeo();
    if (!this.geo) {
      this.transicion('no-disponible');
      return;
    }
    const gen = ++this.generacion;
    this.transicion('solicitando');
    const opts = { enableHighAccuracy: true, maximumAge: 0 };
    try {
      const watchId = this.geo.watchPosition(
        (pos) => {
          if (gen !== this.generacion) return; /* P-2: fix en vuelo descartado */
          this.alFix(pos, watchId);
        },
        (err) => {
          if (gen !== this.generacion) return;
          this.alError(err);
        },
        opts
      );
      this.estado = { ...this.estado, watchId, status: 'adquiriendo', etiquetaCorta: ETIQUETAS.adquiriendo };
      this.emitir();
      /* P-3: timeout honesto con watch vivo (12 s sin fix ⇒ sin-senal). */
      this.timeoutSenal = setTimeout(() => {
        if (gen === this.generacion && (this.estado.status === 'adquiriendo' || this.estado.status === 'solicitando')) {
          this.transicion('sin-senal');
        }
      }, GPS_TIMEOUT_SIN_SENAL_MS);
    } catch {
      this.transicion('error', { lastError: 'no se pudo iniciar el sensor' });
    }
  };

  /** P-2 — simétrico de requestStart: siempre termina en inactivo. */
  requestStop = (): void => {
    this.generacion++;
    if (this.timeoutSenal !== null) {
      clearTimeout(this.timeoutSenal);
      this.timeoutSenal = null;
    }
    if (this.geo && this.estado.watchId !== null) {
      try {
        this.geo.clearWatch(this.estado.watchId);
      } catch {
        /* clearWatch best-effort — el estado manda */
      }
    }
    this.estado = estadoInicial();
    this.emitir();
  };

  /**
   * FR-W1 (puerto D-1): canal de DEMO de laboratorio — inyecta un fix con
   * fuente 'simulacion' construido por gps/orto.ts `simulateFixAt` (N real
   * del geoid activo + z del MDT del lienzo). La UI lo etiqueta SIEMPRE
   * como simulación; jamás recibe datos de sensor. P-1: solo desde
   * interacción del usuario (botón «Demo laboratorio»).
   */
  inyectarFixDemo = (fix: GpsFix): void => {
    if (fix.source !== 'simulacion') return; /* guard honesto del canal */
    this.generacion++; /* P-2: fixes de watch en vuelo quedan descartados */
    if (this.timeoutSenal !== null) {
      clearTimeout(this.timeoutSenal);
      this.timeoutSenal = null;
    }
    this.estado = {
      ...this.estado,
      status: 'activo',
      fix,
      etiquetaCorta: `GPS — demo (FR-W1) ±${fix.accuracyM} m`,
      lastError: null,
      watchId: null,
    };
    this.recalc();
  };

  private alFix(
    pos: {
      coords: {
        latitude: number;
        longitude: number;
        accuracy: number;
        altitude?: number | null;
        altitudeAccuracy?: number | null;
      };
      timestamp: number;
    },
    watchId: number
  ): void {
    /* Hostiles ⇒ descarte silencioso (rango WGS84 válido). */
    const { latitude: lat, longitude: lon, accuracy, altitude, altitudeAccuracy } = pos.coords;
    if (
      !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(accuracy) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180 || accuracy < 0
    ) {
      return;
    }
    if (this.timeoutSenal !== null) {
      clearTimeout(this.timeoutSenal);
      this.timeoutSenal = null;
    }
    /* P-3: precisión SIEMPRE visible — «±N m» con N = techo del reporte. */
    const acc = Math.ceil(accuracy);
    /* PUERTO D-1: altitud elipsoidal del chip — null si el dispositivo no
     * la reporta (honesto FR-7: jamás se hornea un valor). */
    const altM = typeof altitude === 'number' && Number.isFinite(altitude) ? altitude : null;
    const altAccM =
      typeof altitudeAccuracy === 'number' && Number.isFinite(altitudeAccuracy)
        ? altitudeAccuracy
        : null;
    const fix: GpsFix = {
      lat,
      lon,
      accuracyM: acc,
      timestampMs: pos.timestamp,
      altitudeM: altM,
      altitudeAccuracyM: altAccM,
      source: 'chip',
    };
    const status: GpsStatus = accuracy > GPS_UMBRAL_DEGRADE_M ? 'degradado' : 'activo';
    this.estado = {
      ...this.estado,
      status,
      fix,
      etiquetaCorta: `${ETIQUETAS[status]} ±${acc} m`,
      lastError: null,
      watchId,
    };
    this.recalc();
  }

  private alError(err: { code: number; message?: string }): void {
    /* I-1: el mensaje NO incluye coordenadas — solo causa accionable. */
    if (err.code === 1) {
      this.transicion('denegado', { lastError: 'habilita la ubicación en los ajustes del sitio' });
      return;
    }
    this.transicion('error', { lastError: err.code === 3 ? 'el sensor tardó demasiado' : 'sensor no disponible' });
  }

  private recalc(): void {
    const fix = this.estado.fix;
    if (!fix || !this.anchor) {
      if (this.estado.dentroDeRegion !== false) {
        this.estado = { ...this.estado, dentroDeRegion: false };
        this.emitir();
      }
      return;
    }
    const dx = (fix.lon - this.anchor.centerLon) * Math.cos((this.anchor.centerLat * Math.PI) / 180) * 111_320;
    const dy = (fix.lat - this.anchor.centerLat) * 110_574;
    const dentro = Math.abs(dx) <= this.anchor.extentM / 2 && Math.abs(dy) <= this.anchor.extentM / 2;
    if (dentro !== this.estado.dentroDeRegion) {
      this.estado = { ...this.estado, dentroDeRegion: dentro };
      this.emitir();
    }
  }
}

export const gpsController = new GpsController();

/** Fuente única de estado para el chip del SLOT (contrato v1 de la spec §4). */
export function useGpsState(): GpsState {
  return useSyncExternalStore(gpsController.subscribe, gpsController.getState, gpsController.getState);
}
