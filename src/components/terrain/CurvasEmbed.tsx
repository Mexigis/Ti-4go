/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * CurvasEmbed — el lienzo de curvas vivas como COMPONENTE EMBEBIBLE (WC).
 *
 * Visión (checkpoint de ingeniería; transplante D-2 al árbol unificado):
 * «la capa viva de curvas en CADA pantalla» — el embed
 * se reutiliza en las 9 pantallas del Core Target (B-D1: múltiples
 * instancias simultáneas sin interferencia, cada una con su propio motor y
 * su propio modelo; 0 GPU, 0 red).
 *
 * Diseño:
 *  - Instancia propia de IsoEngine sobre su propio canvas: el idle-stop del
 *    motor garantiza 0 cuadros en reposo por instancia.
 *  - Construcción del modelo DIFERIDA y ESCALONADA (deferMs por índice) para
 *    que N instancias en una página no compitan por el hilo al montar.
 *  - Modo `abstract` (decisión Trails para la pantalla TDA): el mapa puede
 *    quedarse en malla+maestras sin drenaje/etiquetas — la vista drape
 *    completa sigue disponible con `variant="drape"`.
 *  - Sin estado global: no toca el ingest store ni el registro del geoide;
 *    un embed jamás muta el visor principal (B-D1: aislamiento).
 *  - Chip de identidad opcional (pantalla + región) accesible (aria-hidden
 *    decorativo + texto real para AT vía role=img con etiqueta).
 *
 * Adaptación al árbol unificado (honestidad del transplante): clases de
 * tokens shadcn del árbol (border-border · bg-background ·
 * text-muted-foreground) y overrides del motor extraídos a `embedEngineOpts`
 * (función pura, testada en forense_embed_pantallas) — el contrato con el
 * linaje custodiado queda byte-equivalente en conducta.
 */

import { useEffect, useRef, useState } from 'react';
import { IsoEngine } from '@/lib/terrain/engine';
import { buildContours } from '@/lib/terrain/contours';
import { buildTerrain } from '@/lib/terrain/generator';
import { getRegion } from '@/lib/terrain/regions';

/** Overrides de opts del motor por variante (puro — testado en suite). */
export function embedEngineOpts(
  variant: 'drape' | 'abstract',
  day: boolean,
): Record<string, boolean> {
  const opts: Record<string, boolean> = { day, inegi: false };
  if (variant === 'abstract') {
    opts.streams = false;
    opts.divides = false;
    opts.labels = false;
    opts.minor = false;
    opts.cotas = false;
  }
  return opts;
}

export interface CurvasEmbedProps {
  /** Región del catálogo (REGIONS.id). */
  regionId: string;
  /** Altura CSS del lienzo (por defecto 220 px). */
  height?: number;
  /** Pan/zoom con puntero (por defecto true; false = pantalla de solo lectura). */
  interactive?: boolean;
  /** 'drape' = capa viva completa · 'abstract' = malla+maestras (TDA/Trails). */
  variant?: 'drape' | 'abstract';
  /** Retardo de construcción en ms (escalonado multi-instancia, B-D1). */
  deferMs?: number;
  /** Nombre de la pantalla para el chip de identidad. */
  screen?: string;
  className?: string;
}

export function CurvasEmbed({
  regionId,
  height = 220,
  interactive = true,
  variant = 'drape',
  deferMs = 0,
  screen,
  className,
}: CurvasEmbedProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<IsoEngine | null>(null);
  const [ready, setReady] = useState(false);
  const region = getRegion(regionId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    // Construcción escalonada: cada embed espera SU deferMs para no robar
    // el hilo a los demás al montar (9 instancias ≈ repartidas en ~1 s).
    // El estado "ready" solo se toca DENTRO del callback (regla
    // react-hooks/set-state-in-effect): el chip queda honesto por ciclo.
    const t = setTimeout(() => {
      if (cancelled) return;
      setReady(false);
      const eng = new IsoEngine(canvas);
      // Modo Día: la clase va en <html> (ThemeProvider del árbol unificado,
      // attribute="class" · themes dark|day) — misma convención del visor.
      Object.assign(
        eng.opts,
        embedEngineOpts(variant, document.documentElement.classList.contains('day')),
      );
      const model = buildTerrain(region);
      const contours = buildContours(model.grid);
      eng.setModel(model, contours);
      engineRef.current = eng;
      setReady(true);
    }, deferMs);

    return () => {
      cancelled = true;
      clearTimeout(t);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [regionId, variant, deferMs, region]);

  return (
    <figure
      className={`relative overflow-hidden rounded-lg border border-border bg-background ${className ?? ''}`}
      data-testid={`curvas-embed-${regionId}`}
      data-variant={variant}
      style={{ height }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Curvas de nivel — ${region.name}${screen ? ` · pantalla ${screen}` : ''}`}
        className={`h-full w-full ${interactive ? 'cursor-grab touch-none' : 'pointer-events-none'}`}
      />
      {(screen || !ready) && (
        <figcaption
          aria-hidden={ready ? true : undefined}
          className="pointer-events-none absolute left-2 top-2 rounded-md border border-border bg-background/85 px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground backdrop-blur-sm"
        >
          {ready ? screen : `${screen ?? ''} · esculpiendo relieve…`}
        </figcaption>
      )}
    </figure>
  );
}
