/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * D-2 RUTAS WC · forense del transplante de las 9 pantallas host (checkpoint
 * ): `CurvasEmbed` + `/pantallas` + `/embed` llegan
 * del linaje local al árbol
 * unificado.
 *
 * Estrategia honesta (sin motor ni navegador real — la integración del
 * motor se verifica E2E sobre el host demo, como manda el gate):
 *  - V1 CONTRATO de la nueve (PANTALLAS): 9 pantallas, ids únicos, regiones
 *    ∈ REGIONS, mapeo verbatim ×4, TDA abstracta (decisión Trails).
 *  - V2 MARKUP del embed (renderToStaticMarkup): role=img + aria-label con
 *    región real + chip de identidad + data-testid/variant + altura.
 *  - V3 PARAMS del host embebible (parseEmbedParams puro): defaults,
 *    clamping honesto de altura, interactive=0, arrays del gateway.
 *  - V4 OVERRIDES del motor (embedEngineOpts puro): drape = marco INEGI
 *    fuera + Modo Día; abstract = malla+maestras (sin drenaje/etiquetas).
 */

import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getRegion, REGIONS } from '@/lib/terrain/regions';
import { CurvasEmbed, embedEngineOpts } from '@/components/terrain/CurvasEmbed';
import { PANTALLAS } from '@/app/pantallas/page';
import { parseEmbedParams } from '@/app/embed/page';

/* ------------------------------------------------------------------ */
/* V1 — CONTRATO de la nueve (PANTALLAS)                               */
/* ------------------------------------------------------------------ */

describe('forense D-2 · PANTALLAS (la nueve del Core Target)', () => {
  test('V1.1 — exactamente 9 pantallas con ids únicos', () => {
    expect(PANTALLAS).toHaveLength(9);
    const ids = new Set(PANTALLAS.map((p) => p.id));
    expect(ids.size).toBe(9);
  });

  test('V1.2 — toda región pertenece al catálogo REGIONS del árbol unificado', () => {
    const valid = new Set(REGIONS.map((r) => r.id));
    for (const p of PANTALLAS) expect(valid.has(p.region)).toBe(true);
  });

  test('V1.3 — las 4 primeras son el mapeo verbatim de campo (screenshots)', () => {
    for (const p of PANTALLAS.slice(0, 4)) {
      expect(p.ref).toContain('mapeo verbatim');
      expect(p.ref).toMatch(/screenshot \d{6}/);
    }
  });

  test('V1.4 — las 5 restantes son denominaciones de trabajo (Core Target)', () => {
    for (const p of PANTALLAS.slice(4)) expect(p.ref).toBe('Core Target');
  });

  test('V1.5 — TDA permanece abstracta y las variantes son solo drape|abstract', () => {
    const tda = PANTALLAS.find((p) => p.id === 'tda');
    expect(tda).toBeDefined();
    expect(tda?.variant).toBe('abstract');
    for (const p of PANTALLAS) {
      expect(['drape', 'abstract'] as const).toContain(p.variant);
    }
  });
});

/* ------------------------------------------------------------------ */
/* V2 — MARKUP del embed (contrato accesible del lienzo)               */
/* ------------------------------------------------------------------ */

describe('forense D-2 · CurvasEmbed (markup SSR del lienzo embebible)', () => {
  test('V2.1 — role=img + aria-label con región real y pantalla', () => {
    const screen = 'CCI · tablero de comando';
    const html = renderToStaticMarkup(
      createElement(CurvasEmbed, { regionId: 'bufa', screen, height: 190 }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="Curvas de nivel — ${getRegion('bufa').name} · pantalla ${screen}"`);
  });

  test('V2.2 — data-testid + data-variant + altura CSS honesta', () => {
    const html = renderToStaticMarkup(
      createElement(CurvasEmbed, { regionId: 'soledad', variant: 'abstract', height: 190 }),
    );
    expect(html).toContain('data-testid="curvas-embed-soledad"');
    expect(html).toContain('data-variant="abstract"');
    expect(html).toContain('height:190px');
  });

  test('V2.3 — sin screen: aria-label queda con la región y no hay chip listo', () => {
    const html = renderToStaticMarkup(createElement(CurvasEmbed, { regionId: 'santarosa' }));
    expect(html).toContain(`aria-label="Curvas de nivel — ${getRegion('santarosa').name}"`);
    // SSR arranca con ready=false ⇒ el chip «esculpiendo relieve…» avisa
    expect(html).toContain('esculpiendo relieve');
  });

  test('V2.4 — región desconocida ⇒ fallback honesto al catálogo (nunca crashea)', () => {
    const html = renderToStaticMarkup(
      createElement(CurvasEmbed, { regionId: 'region-fantasma' }),
    );
    expect(html).toContain('data-testid="curvas-embed-region-fantasma"');
    // getRegion cae a REGIONS[0] — el aria-label usa esa región real
    expect(html).toContain(`aria-label="Curvas de nivel — ${REGIONS[0].name}"`);
  });

  test('V2.5 — interactive=false apaga el puntero (pantalla de solo lectura)', () => {
    const html = renderToStaticMarkup(
      createElement(CurvasEmbed, { regionId: 'soledad', interactive: false }),
    );
    expect(html).toContain('pointer-events-none');
    expect(html).not.toContain('cursor-grab');
  });
});

/* ------------------------------------------------------------------ */
/* V3 — PARAMS del host embebible (parseEmbedParams puro)              */
/* ------------------------------------------------------------------ */

describe('forense D-2 · /embed parseEmbedParams (contrato del host)', () => {
  test('V3.1 — defaults honestos: soledad · drape · interactivo · 320 px', () => {
    const p = parseEmbedParams({});
    expect(p).toEqual({
      region: 'soledad',
      variant: 'drape',
      screen: undefined,
      interactive: true,
      height: 320,
    });
  });

  test('V3.2 — variant fuera de catálogo ⇒ drape (jamás inventa abstracto)', () => {
    expect(parseEmbedParams({ variant: 'abstract' }).variant).toBe('abstract');
    expect(parseEmbedParams({ variant: 'iso' }).variant).toBe('drape');
    expect(parseEmbedParams({ variant: ['abstract', 'drape'] }).variant).toBe('abstract');
  });

  test('V3.3 — interactive=0 apaga; cualquier otro valor deja interactivo', () => {
    expect(parseEmbedParams({ interactive: '0' }).interactive).toBe(false);
    expect(parseEmbedParams({ interactive: '1' }).interactive).toBe(true);
    expect(parseEmbedParams({ interactive: 'no' }).interactive).toBe(true);
  });

  test('V3.4 — altura con clamping honesto: banda [120, 2000], resto 320', () => {
    expect(parseEmbedParams({ h: '500' }).height).toBe(500);
    expect(parseEmbedParams({ h: '120' }).height).toBe(120);
    expect(parseEmbedParams({ h: '2000' }).height).toBe(2000);
    expect(parseEmbedParams({ h: '50' }).height).toBe(320);    // < 120
    expect(parseEmbedParams({ h: '5000' }).height).toBe(320);  // > 2000
    expect(parseEmbedParams({ h: 'abc' }).height).toBe(320);   // NaN
    expect(parseEmbedParams({ h: '-300' }).height).toBe(320);  // negativa
    expect(parseEmbedParams({}).height).toBe(320);             // ausente
  });

  test('V3.5 — arrays del gateway: toma el primer valor', () => {
    const p = parseEmbedParams({ region: ['bufa', 'soledad'], screen: ['Incidente'] });
    expect(p.region).toBe('bufa');
    expect(p.screen).toBe('Incidente');
  });
});

/* ------------------------------------------------------------------ */
/* V4 — OVERRIDES del motor (embedEngineOpts puro)                     */
/* ------------------------------------------------------------------ */

describe('forense D-2 · embedEngineOpts (overrides por variante)', () => {
  test('V4.1 — drape: Modo Día leído de <html> y marco INEGI fuera (lienzo chico)', () => {
    expect(embedEngineOpts('drape', false)).toEqual({ day: false, inegi: false });
    expect(embedEngineOpts('drape', true)).toEqual({ day: true, inegi: false });
  });

  test('V4.2 — abstract: malla+maestras sin drenaje/etiquetas (decisión Trails)', () => {
    expect(embedEngineOpts('abstract', false)).toEqual({
      day: false,
      inegi: false,
      streams: false,
      divides: false,
      labels: false,
      minor: false,
      cotas: false,
    });
  });

  test('V4.3 — drape NUNCA toca las capas vivas (solo day/inegi)', () => {
    const opts = embedEngineOpts('drape', false);
    expect(Object.keys(opts).sort()).toEqual(['day', 'inegi']);
  });
});
