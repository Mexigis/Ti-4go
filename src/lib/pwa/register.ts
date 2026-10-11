/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-8 · registro honesto del Service Worker (spec §3.3/§3.7).
 *
 * - Dev / SSR / sin SW ⇒ null (R4: 0 interferencia con HMR).
 * - `actualizacion-disponible` SOLO cuando hay un SW nuevo en `waiting`
 *   Y la página ya está controlada (actualización real pendiente).
 * - `applyUpdate()` = consentimiento explícito del usuario: envía
 *   SKIP_WAITING y programa la ÚNICA recarga (controllerchange, once).
 *   0 timers, 0 auto-recarga, 0 clients.claim agresivo.
 */
export type SwUpdateState = 'no-soportado' | 'al-dia' | 'actualizacion-disponible';

export interface SwHandle {
  /** Estado corriente (lectura puntual; el cambio llega por el callback). */
  readonly state: SwUpdateState;
  /** Solo desde el click «Recargar ahora» del UpdateBanner. */
  applyUpdate(): void;
  /** Limpieza al desmontar (listener de controllerchange si quedó armado). */
  dispose(): void;
}

export function registerSw(onStateChange?: (s: SwUpdateState) => void): SwHandle | null {
  if (typeof window === 'undefined') return null;
  /* R4 — dev sin SW: el registro solo opera en producción/air-gap. */
  if (process.env.NODE_ENV !== 'production') return null;
  if (!('serviceWorker' in navigator)) {
    onStateChange?.('no-soportado');
    return null;
  }

  let state: SwUpdateState = 'al-dia';
  let waiting: ServiceWorker | null = null;
  let armed = false;

  const emit = (s: SwUpdateState): void => {
    state = s;
    onStateChange?.(s);
  };

  const checkWaiting = (reg: ServiceWorkerRegistration): void => {
    /* Sin controlador (primera instalación) NO hay banner: la próxima carga
       ya nace controlada por el SW nuevo — nada se pierde (§3.7). */
    if (reg.waiting && navigator.serviceWorker.controller) {
      waiting = reg.waiting;
      emit('actualizacion-disponible');
    }
  };

  void navigator.serviceWorker.register('/sw.js').then(
    (reg) => {
      checkWaiting(reg);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') checkWaiting(reg);
        });
      });
    },
    () => emit('no-soportado')
  );

  const onControllerChange = (): void => {
    /* Única recarga del ciclo — SOLO después del consentimiento (A8-4). */
    location.reload();
  };

  return {
    get state(): SwUpdateState {
      return state;
    },
    applyUpdate(): void {
      if (armed) return;
      armed = true;
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, {
        once: true,
      });
      waiting?.postMessage({ type: 'SKIP_WAITING' });
    },
    dispose(): void {
      if (armed) {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      }
    },
  };
}
