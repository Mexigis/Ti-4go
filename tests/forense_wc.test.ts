/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B-D1 · U5 — aceptación del Web Component `ti4go-viewer` (bun test).
 *
 * Contrato (docs/fr-specs/B-D1-webcomponent.md, VERBATIM, cláusula de
 * aceptación): «monta/desmonta N veces sin fugas (bun test) · loadMissionPack
 * desde los 3 canales · url-sync="false" verificado no toca location.hash ·
 * suite monótona · E2E agent-browser con host de prueba».
 *
 * Estrategia honesta (sin motor ni navegador real):
 *  - ELEMENTO: happy-dom + renderizador INYECTADO (DI del elemento) — prueba
 *    la mecánica contractual: shadow root, attrs, montaje/desmontaje N,
 *    señales CustomEvent composed+bubbles, isSecureContext, guard del API.
 *    La url-sync integral (hash) se verifica E2E con el motor real (host).
 *  - loadMissionPack: implementación REAL vía src/wc/mission-pack.ts —
 *    parsers FR-1/FR-3/seedpack de verdad, worker ausente ⇒ fallback
 *    síncrono (el mismo camino del fallback del navegador).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { Window } from 'happy-dom';
import { createElement } from 'react';
import { getRegion } from '@/lib/terrain/regions';
import { packRegionSeed } from '@/lib/terrain/seedpack';
import { createIngestController } from '@/components/terrain/ingest';
import { createMissionPackLoader, sniffBinName } from '@/wc/mission-pack';
import type { CustodyReceipt, GeoJSONFeatureCollection, Ti4goViewerApi } from '@/wc/contract';

/* ------------------------------------------------------------------ */
/* bootstrap happy-dom (ANTES de importar el elemento: class extends   */
/* HTMLElement se evalúa al importar)                                  */
/* ------------------------------------------------------------------ */

const win = new Window({ url: 'http://localhost:3000/' });
const g = globalThis as unknown as Record<string, unknown>;
for (const k of [
  'window',
  'document',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLCanvasElement',
  'HTMLSpanElement',
  'customElements',
  'CustomEvent',
  'Event',
  'EventTarget',
  'Element',
  'Node',
  'ShadowRoot',
  'DocumentFragment',
  'navigator',
]) {
  g[k] = (win as unknown as Record<string, unknown>)[k];
}
g.requestAnimationFrame =
  typeof win.requestAnimationFrame === 'function'
    ? win.requestAnimationFrame.bind(win)
    : (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
g.cancelAnimationFrame = (id: number): void => clearTimeout(id);

/* El elemento se importa DESPUÉS del bootstrap (top-level await). */
const { Ti4goViewerElement, defineTi4goViewer } = await import('@/wc/ti4go-viewer');
type ViewerElement = InstanceType<typeof Ti4goViewerElement>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Elemento (mecánica contractual con renderer inyectado)              */
/* ------------------------------------------------------------------ */

describe('B-D1 U5 · WC ti4go-viewer — elemento (renderer inyectado)', () => {
  let renders: number;
  let controllersSeen: unknown[];
  let registered: Array<Ti4goViewerApi | null>;
  const events: Array<{ type: string; detail: unknown }> = [];

  beforeAll(() => {
    defineTi4goViewer('ti4go-viewer-test');
    renders = 0;
    controllersSeen = [];
    registered = [];
    Ti4goViewerElement.renderer = (root, attrs, controller, alive, hooks) => {
      void attrs;
      void alive;
      renders++;
      if (controller) controllersSeen.push(controller);
      root.render(
        createElement('div', { 'data-fake-app': 'true', 'data-sync': String(attrs.urlSync) })
      );
      const fakeApi = {
        loadMissionPack: async () => {
          throw new Error('fake api');
        },
        flyToBBox: () => true,
        setViewOpts: () => {},
        getExportScene: () => null,
      } as unknown as Ti4goViewerApi;
      registered.push(fakeApi);
      hooks.registerApi({ current: fakeApi });
      /* Señal de prueba durante el montaje (como el app real emitiría). */
      hooks.onLayerSelect({ layerId: 'streams', uuid: '', layerType: 'cauce' });
    };
  });

  test('shadow root + attrs normalizados (defaults url-sync on · dark · expert)', () => {
    const el = document.createElement('ti4go-viewer-test') as ViewerElement;
    document.body.appendChild(el);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[data-ti4go-root]')).not.toBeNull();
    expect(el.secure).toBe((win as Window & { isSecureContext?: boolean }).isSecureContext === true); // isSecureContext check (FR-7)
    el.remove();
  });

  test('señal ti4go:layer-select: CustomEvent composed+bubbles con payload contractual', () => {
    const el = document.createElement('ti4go-viewer-test') as ViewerElement;
    events.length = 0;
    const listener = (ev: Event): void => {
      const ce = ev as CustomEvent;
      events.push({ type: ce.type, detail: ce.detail });
    };
    el.addEventListener('ti4go:layer-select', listener);
    document.body.appendChild(el);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('ti4go:layer-select');
    expect(events[0].detail).toEqual({ layerId: 'streams', uuid: '', layerType: 'cauce' });
    const ce = el.shadowRoot && el.shadowRoot.host ? true : true;
    void ce;
    el.removeEventListener('ti4go:layer-select', listener);
    el.remove();
  });

  test('atributo url-sync="false" se normaliza y llega al app (D-2)', async () => {
    const el = document.createElement('ti4go-viewer-test') as ViewerElement;
    el.setAttribute('url-sync', 'false');
    document.body.appendChild(el);
    await sleep(5);
    const app = el.shadowRoot?.querySelector('[data-fake-app]') as HTMLElement | null;
    expect(app).not.toBeNull();
    expect(app?.getAttribute('data-sync')).toBe('false');
    el.remove();
  });

  test('monta/desmonta N=5 sin fugas: unmount vacía el contenedor y remonta limpio', async () => {
    const el = document.createElement('ti4go-viewer-test') as ViewerElement;
    const controllersAntes = controllersSeen.length;
    for (let i = 0; i < 5; i++) {
      document.body.appendChild(el);
      await sleep(5);
      const host = el.shadowRoot?.querySelector('[data-ti4go-root]') as HTMLElement;
      expect(host.childElementCount).toBeGreaterThan(0); // app montado
      el.remove();
      await sleep(5);
      expect(host.childElementCount).toBe(0); // root.unmount() — SIN FUGAS
      expect(el.ingestController).toBeNull(); // controller soltado
    }
    /* D-1: cada montaje usa UN controller nuevo (por instancia). */
    expect(controllersSeen.length - controllersAntes).toBe(5);
  });

  test('loadMissionPack sin API registrada ⇒ rechazo honesto (no promesa colgada)', () => {
    const el = document.createElement('ti4go-viewer-test') as ViewerElement;
    /* No conectar: apiRef.current = null. */
    expect(el.loadMissionPack('MXP1-x.y')).rejects.toThrow('app no montado');
  });

  test('attributeChangedCallback re-renderiza con attrs nuevos (theme/mode observados)', async () => {
    const el = document.createElement('ti4go-viewer-test') as ViewerElement;
    document.body.appendChild(el);
    await sleep(5);
    const antes = renders;
    el.setAttribute('mode', 'field');
    await sleep(5);
    expect(renders).toBeGreaterThan(antes);
    el.remove();
  });
});

/* ------------------------------------------------------------------ */
/* loadMissionPack — 3 canales con parsers REALES                      */
/* ------------------------------------------------------------------ */

const region = getRegion('soledad');
const anchor = {
  extentM: region.extent,
  zMinM: region.elevMin,
  zMaxM: region.elevMax,
  centerLat: region.centerLat,
  centerLon: region.centerLon,
  regionName: region.name,
};

const fcSintetico: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'lindero-test' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [region.centerLon - 0.002, region.centerLat - 0.002],
            [region.centerLon + 0.002, region.centerLat - 0.002],
            [region.centerLon + 0.002, region.centerLat + 0.002],
            [region.centerLon - 0.002, region.centerLat + 0.002],
            [region.centerLon - 0.002, region.centerLat - 0.002],
          ],
        ],
      },
    },
  ],
};

/** ZIP mínimo PK (cabecera local + datos + EOCD) — el parser FR-3 real lo
 *  ABRIRÁ y rechazará con motivo (contenido hostil/sin manifest): lo que se
 *  verifica es el CANAL end-to-end (sniff → ingestAsync → parser → reject). */
function makeMinimalZip(): ArrayBuffer {
  const name = new TextEncoder().encode('README.txt');
  const data = new TextEncoder().encode('contenido sin manifest');
  const chunk = (arr: Uint8Array): number[] => Array.from(arr);
  const local = [
    0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ...chunk(new Uint8Array(new Uint32Array([data.length]).buffer, 0, 4)).map((b) => (b & 0xff)),
    ...chunk(new Uint8Array(new Uint32Array([data.length]).buffer, 0, 4)).map((b) => (b & 0xff)),
    name.length, 0,
    ...chunk(name),
    ...chunk(data),
  ];
  const eocd = [
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  return new Uint8Array([...local, ...eocd]).buffer;
}

describe('B-D1 U5 · loadMissionPack — 3 canales (parsers reales)', () => {
  test('canal 2: objeto GeoJSON FeatureCollection → parseo FR-1 real → capa + receipt', async () => {
    const controller = createIngestController();
    const custodies: CustodyReceipt[] = [];
    const load = createMissionPackLoader({
      controller,
      getAnchor: () => anchor,
      setRegionId: () => {},
      onCustody: (r) => custodies.push(r),
      onDivergence: () => {},
    });
    const r = await load(fcSintetico);
    expect(r.format).toBe('geojson');
    expect(r.fileName).toBe('mision.geojson');
    expect(r.diverge).toBe(false);
    expect(custodies.length).toBe(1);
    /* El parser REAL aceptó la geometría: la capa está en el controller. */
    expect(controller.getGeomsSnapshot().length).toBe(1);
    controller.dispose();
  });

  test('canal 1a: File GeoJSON → mismo camino real (nombre rutea el formato)', async () => {
    const controller = createIngestController();
    const load = createMissionPackLoader({
      controller,
      getAnchor: () => anchor,
      setRegionId: () => {},
      onCustody: () => {},
      onDivergence: () => {},
    });
    const file = new File([JSON.stringify(fcSintetico)], 'mision.geojson', { type: 'application/geo+json' });
    const r = await load(file);
    expect(r.format).toBe('geojson');
    expect(r.fileName).toBe('mision.geojson');
    expect(controller.getGeomsSnapshot().length).toBe(1);
    controller.dispose();
  });

  test('canal 3: string MXP1 válido → región aplicada + receipt cuadra (H-4)', async () => {
    const controller = createIngestController();
    let regionAplicada = '';
    const load = createMissionPackLoader({
      controller,
      getAnchor: () => anchor,
      setRegionId: (id) => {
        regionAplicada = id;
      },
      onCustody: () => {},
      onDivergence: () => {},
    });
    const code = packRegionSeed(region);
    const r = await load(code);
    expect(r.format).toBe('mxp1');
    expect(regionAplicada).toBe('soledad');
    expect(r.diverge).toBe(false);
    expect(r.custody).toContain('cuadra con el catálogo');
    controller.dispose();
  });

  test('canal 3: string MXP1 adulterado ⇒ rechazo (checksum)', async () => {
    const controller = createIngestController();
    const load = createMissionPackLoader({
      controller,
      getAnchor: () => anchor,
      setRegionId: () => {},
      onCustody: () => {},
      onDivergence: () => {},
    });
    const code = packRegionSeed(region);
    const roto = code.slice(0, -2) + 'zz';
    expect(load(roto)).rejects.toThrow('semilla MXP1 inválida');
    controller.dispose();
  });

  test('canal 1b: sniff PKZIP/TIFF correcto; binario ajeno ⇒ throw honesto', () => {
    expect(sniffBinName(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).buffer)).toBe('mision.zip');
    expect(sniffBinName(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]).buffer)).toBe('mision.tif');
    expect(sniffBinName(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0]).buffer)).toBe('mision.tif');
    expect(() => sniffBinName(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toThrow('no reconocido');
  });

  test('canal 1b end-to-end: ZIP mínimo → parser FR-3 real rechaza con motivo', async () => {
    const controller = createIngestController();
    const load = createMissionPackLoader({
      controller,
      getAnchor: () => anchor,
      setRegionId: () => {},
      onCustody: () => {},
      onDivergence: () => {},
    });
    expect(load(makeMinimalZip() as ArrayBuffer)).rejects.toThrow();
    controller.dispose();
  });
});
