/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * B-D1 · U3+U4 — app interno del Web Component `ti4go-viewer`.
 *
 * Este componente vive DENTRO del shadow root (montado por createRoot desde
 * `ti4go-viewer.ts`). Sus responsabilidades:
 *  - Proveer el `IngestControllerContext` con el controller POR INSTANCIA (D-1).
 *  - Mapear el atributo `theme` al tema de la UI (next-themes, contexto propio
 *    del embebido — no muta el tema del documento anfitrión):
 *      dark → forcedTheme "dark" · day → "day" · eink → "dark" + lienzo E-Ink
 *      (ViewOpts.eink vía initialOpts — tinta B/N pura del lienzo).
 *  - Mapear `mode`: field → preset Modo Campo (FR-6, props del embedder);
 *    expert → estudio (comportamiento default).
 *  - Propagar `urlSync` (D-2: apagable por atributo, 0 acceso al hash).
 *  - Entregar al elemento la API del viewer vía Ti4goHostHooks.registerApi
 *    y las señales same-document (camera-change/layer-select/custody/
 *    divergence) como CustomEvents del elemento (U4).
 *  - Banner honesto si `window.isSecureContext` es false (ancla FR-7: GPS).
 *
 * GPS: `gpsController` permanece GLOBAL-dispositivo (el hardware de geolocali-
 * zación es único por navegador; N instancias comparten el chip — decisión
 * documentada en la spec, no es parte de la deuda D-1).
 */

import { useEffect, useMemo } from 'react';
import { ThemeProvider } from 'next-themes';
import { TerrainViewer } from '@/components/terrain/TerrainViewer';
import { IngestControllerContext, type IngestController } from '@/components/terrain/ingest';
import { EmbedPortalProvider } from '@/lib/embed-portal';
import type { Ti4goAttrs, Ti4goHostHooks, Ti4goViewerApi } from './contract';

export interface Ti4goViewerAppProps {
  attrs: Ti4goAttrs;
  controller: IngestController;
  /** Resultado del check isSecureContext del elemento (ancla FR-7). */
  secure: boolean;
  /** Hooks host←elemento (identidad estable: el elemento los crea una vez). */
  hooks: Ti4goHostHooks;
}

export function Ti4goViewerApp({ attrs, controller, secure, hooks }: Ti4goViewerAppProps) {
  /* Holder PLANO estable {current} que el viewer rellena con su API; el
     elemento lo consume (useMemo: identidad estable entre renders). */
  const apiHolder = useMemo(() => ({ current: null as Ti4goViewerApi | null }), []);
  useEffect(() => {
    hooks.registerApi(apiHolder);
    return () => hooks.registerApi(null);
  }, [hooks]);

  const forcedTheme = attrs.theme === 'day' ? 'day' : 'dark';
  const initialOpts = attrs.theme === 'eink' ? { eink: true } : undefined;
  return (
    <IngestControllerContext.Provider value={controller}>
      {/* Cura de portal v1.0.2: Sheet/Select portan DENTRO del shadow (el
          provider monta [data-ti4go-portals] como hermano posterior del app —
          el selector ancla del baseline [data-ti4go-root] > .h-\[100dvh\]
          queda intacto). En la ruta / el contexto es null ⇒ document.body. */}
      <EmbedPortalProvider>
        <ThemeProvider attribute="class" forcedTheme={forcedTheme} enableSystem={false} disableTransitionOnChange>
          {!secure && (
            <div
              role="alert"
              className="relative z-30 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400"
            >
              Contexto NO seguro (isSecureContext = false) — GPS deshabilitado por contrato (ancla FR-7). El visor sigue
              operativo.
            </div>
          )}
          <TerrainViewer
            urlSync={attrs.urlSync}
            fieldMode={attrs.mode === 'field'}
            initialOpts={initialOpts}
            /* Task 61: polaridad del lienzo POR INSTANCIA — resolvedTheme de
               next-themes observa el <html> del anfitrión (con N instancias
               de temas distintos, todas seguirían a la última que montó). */
            dayOverride={attrs.theme === 'day'}
            apiRef={apiHolder}
            onCameraChange={hooks.onCameraChange}
            onLayerSelect={hooks.onLayerSelect}
            onCustody={hooks.onCustody}
            onDivergence={hooks.onDivergence}
          />
        </ThemeProvider>
      </EmbedPortalProvider>
    </IngestControllerContext.Provider>
  );
}
