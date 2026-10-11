/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

import { useMemo } from 'react';
import { Crosshair } from 'lucide-react';
import { gpsController, useGpsState } from '@/lib/gps/gpsController';
import { resolveCota } from '@/lib/gps/orto';
import { useGeoidModels } from './ingest';

/**
 * FR-7 · chip GPS del SLOT de Modo Campo (contrato v1, spec R-B §4).
 *
 * - Fuente única de estado: `useGpsState()` (singleton del controlador).
 * - P-1: requestStart/requestStop ocurren SOLO en este handler de click —
 *   jamás en montaje, hidratación ni efectos (montaje único del SLOT).
 * - P-3: la etiqueta SIEMPRE muestra «±N m» cuando hay fix y la máquina
 *   comunica el estado real (sin señal / denegado / error / fuera de región).
 * - I-1: la etiqueta NUNCA contiene coordenadas (son del fix, no de la UI).
 * - Targets ≥ 44 px (R-2); texto sin tecnicismos.
 */
export function GpsChip(): React.ReactNode {
  const st = useGpsState();
  const encendido = st.status !== 'inactivo';
  /* PUERTO D-1 (chip→toOrthometric): con fix + altitud del chip + geoid
   * activo en cobertura, la etiqueta muestra la COTA ORTOMÉTRICA (H = h − N).
   * Sin geoid o sin altitud: SOLO el estado (honesto — jamás una cota
   * elipsoidal disfrazada de ortométrica). I-1 intacto: la cota no es una
   * coordenada; jamás se muestran lat/lon. */
  const geoids = useGeoidModels();
  const model = geoids.length ? geoids[geoids.length - 1].model : null;
  const cota = useMemo(() => (st.fix ? resolveCota(st.fix, model) : null), [st.fix, model]);
  const cotaTxt =
    cota?.cota != null && cota.n !== null
      ? ` · ${Math.round(cota.cota).toLocaleString('es-MX')} m`
      : '';

  const etiqueta =
    st.status === 'inactivo'
      ? 'GPS'
      : st.etiquetaCorta +
        cotaTxt +
        (st.fix && !st.dentroDeRegion ? ' · fuera de región' : '');

  const a11y =
    st.status === 'inactivo'
      ? 'GPS inactivo. Activar para obtener la posición actual'
      : `Estado GPS: ${st.etiquetaCorta.replace(/^GPS —?\s*/i, '')}${
          st.fix && !st.dentroDeRegion ? ', fuera de la región activa' : ''
        }. ${encendido ? 'Desactivar' : 'Activar'} la ubicación`;

  return (
    <button
      type="button"
      onClick={() => (encendido ? gpsController.requestStop() : gpsController.requestStart())}
      aria-label={a11y}
      aria-pressed={encendido}
      title={
        encendido
          ? 'Toca para detener la ubicación (el sensor se apaga por completo)'
          : 'Toca para obtener tu posición una vez (bajo demanda, sin rastreo)'
      }
      className={`flex min-h-[44px] items-center gap-1.5 px-2 text-xs font-medium${
        st.status === 'denegado' || st.status === 'error' || st.status === 'no-disponible'
          ? ' text-destructive'
          : ' text-muted-foreground'
      }`}
    >
      <Crosshair className="h-4 w-4 shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{etiqueta}</span>
    </button>
  );
}
