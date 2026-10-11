/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * /pantallas — Tablero de las 9 pantallas del Core Target (visión revisión de ingeniería).
 *
 * Transplante D-2 (checkpoint ): ruta del linaje
 * local custodiado (`ventana-local-21328b2.bundle`) adaptada a la
 * arquitectura unificada (tokens shadcn + catálogo REGIONS propio).
 *
 * El criterio de aceptación del ecosistema (directiva del propietario, trace
 * ``) exige que la capa viva de curvas esté en CADA pantalla;
 * esta ruta es la EVIDENCIA B-D1: 9 instancias simultáneas de CurvasEmbed en
 * una sola página, cada una con su propio motor (idle-stop ⇒ 0 cuadros en
 * reposo por instancia), construcción escalonada y aislamiento total entre
 * instancias (sin estado global compartido).
 *
 * Las 4 primeras filas son el mapeo verbatim del checkpoint (screenshots de
 * campo); las 5 restantes completan el nueve del Core Target (denominaciones
 * de trabajo, sujetas al mapeo definitivo del propietario).
 */

import { CurvasEmbed } from '@/components/terrain/CurvasEmbed';

/** La nueve: pantalla → región → variante (4 mapeadas + 5 Core Target). */
export const PANTALLAS: Array<{
  id: string;
  nombre: string;
  ref: string;
  region: string;
  variant: 'drape' | 'abstract';
}> = [
  { id: 'campo', nombre: 'Captura de campo', ref: 'screenshot 215531 · mapeo verbatim', region: 'soledad', variant: 'drape' },
  { id: 'incidente', nombre: 'Incidente', ref: 'screenshot 215550 · mapeo verbatim', region: 'soledad', variant: 'drape' },
  { id: 'cci', nombre: 'CCI · tablero de comando', ref: 'screenshot 215543 · mapeo verbatim', region: 'bufa', variant: 'drape' },
  { id: 'tda', nombre: 'TDA · análisis (abstracto + drape opcional)', ref: 'screenshot 215612 · mapeo verbatim', region: 'bufa', variant: 'abstract' },
  { id: 'brigada', nombre: 'Brigadas · estado de cuadrillas', ref: 'Core Target', region: 'esperanza', variant: 'drape' },
  { id: 'recursos', nombre: 'Recursos · catálogo', ref: 'Core Target', region: 'esperanza', variant: 'drape' },
  { id: 'alertas', nombre: 'Alertas · vigilancia', ref: 'Core Target', region: 'santarosa', variant: 'drape' },
  { id: 'clima', nombre: 'Clima · estación', ref: 'Core Target', region: 'santarosa', variant: 'drape' },
  { id: 'historico', nombre: 'Histórico · reproducción', ref: 'Core Target', region: 'soledad', variant: 'abstract' },
];

export default function PantallasPage() {
  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground md:px-8">
      <header className="mx-auto max-w-6xl">
        <h1 className="text-lg font-semibold tracking-tight md:text-xl">
          Core Target · las 9 pantallas con la capa viva de curvas
        </h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground md:text-sm">
          Criterio de aceptación del ecosistema (visión revisión de ingeniería): el terreno
          Ti-4GO es el suelo de la plataforma y sus curvas vivas aparecen en
          cada pantalla. Esta página monta <strong>9 instancias simultáneas</strong> del
          embed (B-D1 multi-instancia): cada lienzo tiene su propio motor con
          idle-stop — 0 cuadros en reposo por pantalla — y construcción
          escalonada del modelo. Las 4 primeras son el mapeo verbatim de campo
          (screenshots 215531 · 215550 · 215543 · 215612); TDA permanece
          abstracta con vista drape opcional (decisión Trails).
        </p>
      </header>

      <section
        aria-label="Tablero de 9 pantallas"
        className="mx-auto mt-5 grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {PANTALLAS.map((p, i) => (
          <div key={p.id} className="flex flex-col gap-1.5">
            <CurvasEmbed
              regionId={p.region}
              variant={p.variant}
              screen={p.nombre}
              height={190}
              deferMs={120 * i}
            />
            <p className="text-[11px] leading-tight text-muted-foreground">
              <span className="font-medium text-foreground">{p.nombre}</span>
              <span className="mx-1.5 text-line-strong">·</span>
              {p.ref}
            </p>
          </div>
        ))}
      </section>

      <footer className="mx-auto mt-6 max-w-6xl text-[11px] leading-relaxed text-muted-foreground/70">
        0 GPU · 0 red · Canvas 2D CPU puro · determinista (misma región ⇒ mismo
        modelo). El embed no comparte estado con el visor principal ni con el
        registro del geoide — aislamiento B-D1 verificado en la suite forense
        y en E2E.
      </footer>
    </main>
  );
}
