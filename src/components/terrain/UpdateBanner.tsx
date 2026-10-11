/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { registerSw, type SwHandle, type SwUpdateState } from '@/lib/pwa/register';

/**
 * FR-8 · banner honesto de actualización (spec §3.7, A8-4).
 *
 * - Aparece SOLO con un SW nuevo en `waiting` (nunca interrumpe: role=status,
 *   aria-live polite, sin foco robado).
 * - JAMÁS auto-recarga: 0 timers, 0 recarga en efectos; la recarga ocurre
 *   ÚNICAMENTE en el handler del click «Recargar ahora» (SKIP_WAITING ⇒
 *   controllerchange ⇒ reload — una sola vez, con consentimiento).
 * - «Más tarde» descarta el banner por esta sesión; el SW sigue en waiting
 *   y la escena en memoria queda intacta (el brigadista decide, §3.7).
 * - Targets ≥ 44 px (R-2); el scope .field-mode cubre su estilo en campo.
 */
export function UpdateBanner(): React.ReactNode {
  const [state, setState] = useState<SwUpdateState>('al-dia');
  const [dismissed, setDismissed] = useState(false);
  /* El handle vive en un ref: applyUpdate se lee en el click — 0 re-renders
     por registro (setState solo con un evento real de actualización). */
  const handleRef = useRef<SwHandle | null>(null);

  useEffect(() => {
    const h = registerSw(setState);
    handleRef.current = h;
    return () => h?.dispose();
  }, []);

  if (state !== 'actualizacion-disponible' || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-16 z-40 mx-auto flex w-[min(92vw,460px)] flex-wrap items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-3 shadow-md backdrop-blur"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-orange-500" aria-hidden />
      <p className="min-w-0 flex-1 text-sm font-medium leading-snug">
        Nueva versión del visor lista
        <span className="block text-xs text-muted-foreground">
          Recargar aplica la actualización. Tu escena actual se conserva hasta entonces.
        </span>
      </p>
      <Button size="sm" className="h-11 px-4" onClick={() => handleRef.current?.applyUpdate()}>
        Recargar ahora
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-11 px-4"
        onClick={() => setDismissed(true)}
      >
        Más tarde
      </Button>
    </div>
  );
}
