/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * /embed — pantalla única embebible (iframe / vista de integración).
 *
 * Transplante D-2 (checkpoint ) desde el linaje
 * local custodiado (`ventana-local-21328b2.bundle`), con UNA adaptación
 * honesta a la arquitectura vigente: el host de la bóveda era Server
 * Component con `searchParams` — aquí es Componente Cliente
 * (`useSearchParams` + frontera Suspense) para seguir siendo compatible con
 * el export estático del vehículo air-gap (AIRGAP_EXPORT=1 ⇒ output:
 * "export"; los API dinámicos de servidor NO se prerenderizan). Los params
 * y su semántica quedan byte-idénticos (`parseEmbedParams`, puro y testado
 * en forense_embed_pantallas).
 *
 * Params: ?region=soledad|esperanza|bufa|santarosa · &variant=drape|abstract
 *         &screen=Nombre · &interactive=0 · &h=px
 * Sin shell, sin navegación: solo el lienzo de curvas vivas — la unidad de
 * reuso de la visión «curvas en cada pantalla» (checkpoint de ingeniería).
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { CurvasEmbed } from '@/components/terrain/CurvasEmbed';

export interface EmbedParams {
  region: string;
  variant: 'drape' | 'abstract';
  screen?: string;
  interactive: boolean;
  height: number;
}

/** Parser puro de los params del embed (contrato del host embebible). */
export function parseEmbedParams(
  sp: Record<string, string | string[] | undefined>,
): EmbedParams {
  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const region = one('region') ?? 'soledad';
  const variant = one('variant') === 'abstract' ? 'abstract' : 'drape';
  const screen = one('screen');
  const interactive = one('interactive') !== '0';
  const h = Number(one('h') ?? 0);
  const height = Number.isFinite(h) && h >= 120 && h <= 2000 ? h : 320;
  return { region, variant, screen, interactive, height };
}

function EmbedCanvas() {
  const sp = useSearchParams();
  const p = parseEmbedParams(Object.fromEntries(sp.entries()));

  return (
    <main className="min-h-screen bg-background p-1">
      {/* h1 sr-only: la vista embebible no muestra shell, pero axe exige un
          encabezado de nivel 1 en toda página (WCAG-hallazgos, Task 42). */}
      <h1 className="sr-only">
        Curvas de nivel embebidas — {p.screen ?? p.region}
      </h1>
      <CurvasEmbed
        regionId={p.region}
        variant={p.variant}
        screen={p.screen}
        interactive={p.interactive}
        height={p.height}
      />
    </main>
  );
}

export default function EmbedPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background p-1">
          <h1 className="sr-only">Curvas de nivel embebidas</h1>
        </main>
      }
    >
      <EmbedCanvas />
    </Suspense>
  );
}
