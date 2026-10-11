/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * FR-6 · R-2/R-4/R-5 — BARRA DE CAMPO del lienzo (chrome mínimo de brigada).
 *
 * Spec: docs/fr-specs/FR-6-modo-campo-preset.md §3/§5 · P2 checkpoint
 * re-entrada . Se monta desde TerrainViewer SOLO en
 * Modo Campo (props del embedder); en modo estudio no existe en el DOM.
 *
 *   R-2  estados honestos: «En reposo · bajo consumo / Activo» + «· ahorro»
 *        (mismo contrato que emitHud), targets ≥ FIELD_TARGET_PX (44 px),
 *        foco visible, aria-labels en toda pieza interactiva.
 *   R-4  badge PERSISTENTE de fallback («Tramas: solo export») — el toast
 *        único es refuerzo, no el único canal (riesgo 2 de la spec).
 *   R-5  SLOT GPS: con gpsSlot se renderiza el nodo del embedder (mín.
 *        44 px, sin styling impuesto); sin él, placeholder HONESTO no
 *        interactivo («GPS — pendiente (FR-7)»). 0 lógica GPS: ni este
 *        archivo ni fieldmode.ts mencionan la API de ubicación (A-7, auditado).
 *   R-6  0 red (A-8, test estático) · 0 timers (R-3): la barra es pura
 *        proyección de props; el reloj lo pone el onHud del motor.
 *
 * Telemetría numérica (az/el/zoom/ms/jank): COLAPSADA en campo (G-5
 * recomendado) — el brigadista necesita estado e intervalo, no telemetría;
 * queda disponible en modo estudio y vía __overlayPerf para QA.
 */
import type { ReactNode } from 'react';
import {
  FIELD_FALLBACK_BADGE,
  FIELD_TARGET_PX,
  fieldHasFallback,
} from '@/lib/terrain/fieldmode';
import { GpsChip } from '@/components/terrain/GpsChip';

export interface FieldBarProps {
  /** Motor en reposo (0 cuadros): «En reposo · bajo consumo» (emitHud idle). */
  idle: boolean;
  /** Modo Ahorro activo (manual o por batería): «· ahorro». */
  save: boolean;
  /** Intervalo efectivo de curvas intermedias (LOD) — legible, sin telemetría. */
  interval: number;
  /** R-4 · fallback del hachurado ('' = activo; guard/frame = solo export). */
  hachureFallback: '' | 'guard' | 'frame';
  /** R-4 · fallback del campo de fricción ('' = activo). */
  frictionFallback: '' | 'guard' | 'frame';
  /** R-5 · SLOT GPS del embedder (implementación real = FR-7). */
  gpsSlot?: ReactNode;
  /** Salida de campo (el embedder posee el estado; sin ella no hay botón). */
  onExit?: () => void;
}

export function FieldBar({
  idle,
  save,
  interval,
  hachureFallback,
  frictionFallback,
  gpsSlot,
  onExit,
}: FieldBarProps) {
  const fallback = fieldHasFallback(hachureFallback, frictionFallback);
  const estado = idle ? 'En reposo · bajo consumo' : 'Activo';
  return (
    <div
      data-field-target-px={FIELD_TARGET_PX}
      role="region"
      aria-label="Barra de Modo Campo"
      className="absolute inset-x-0 bottom-0 z-20 flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-card/95 px-3 py-2 backdrop-blur"
    >
      <span className="text-xs font-semibold text-foreground" aria-live="polite">
        {estado}
        {save ? ' · ahorro' : ''}
      </span>
      <span className="text-xs text-muted-foreground" title="Intervalo efectivo de curvas intermedias (el LOD adapta el presupuesto de segmentos)">
        Intervalo: {interval} m
      </span>
      {fallback && (
        <span
          data-testid="field-fallback-badge"
          title="El guard de rendimiento movió las tramas al archivo exportado; en pantalla se suprimen para mantener la fluidez. Re-activar el toggle vuelve a medir."
          className="border border-orange-500/60 bg-orange-500/10 px-2 py-0.5 text-[11px] font-semibold text-orange-500"
        >
          {FIELD_FALLBACK_BADGE}
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        {gpsSlot ? (
          <div className="flex min-h-[44px] items-center">{gpsSlot}</div>
        ) : (
          /* FR-7 · R-5 entregado: chip real bajo demanda (máquina de estados
             honesta, precisión siempre visible, 0 rastreo en background). */
          <GpsChip />
        )}
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            aria-label="Salir de Modo Campo"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-border px-3 text-xs font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Salir de Modo Campo
          </button>
        )}
      </div>
    </div>
  );
}
