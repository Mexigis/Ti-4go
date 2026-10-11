/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B-D1 · U3+U4 — Web Component `ti4go-viewer` (Shadow DOM · same-document).
 *
 * Contrato (docs/fr-specs/B-D1-webcomponent.md, VERBATIM):
 *  - Shadow DOM; custom element `ti4go-viewer`.
 *  - Comunicación same-document: métodos públicos + CustomEvent — NO
 *    postMessage, jamás '*'.
 *  - Atributos: url-sync="false" · theme="dark|day|eink" · mode="field|expert".
 *  - URL-sync apagable por ATRIBUTO (D-2), no detección de iframe.
 *  - Factory del IngestController y workers POR INSTANCIA (D-1): cada
 *    elemento crea su controller vía createIngestController().
 *  - Entry ESM dedicado que monta la app con createRoot dentro del shadow
 *    root (NO vite, NO lib-mode).
 *  - Instancia inactiva = 0 CPU por diseño (el motor detiene el bucle en
 *    reposo); el costo real de N instancias = memoria.
 *  - isSecureContext check al conectar (ancla FR-7).
 *  - Distribución: SOLO repo privado (artefacto en release / dependencia
 *    git) — npm público y CDN EXCLUIDOS (secuencia Apache 2.0 post
 *    validación de campo).
 *
 * Inyección de dependencias para `bun test` (sin motor ni navegador real):
 * `Ti4goViewerElement.renderer` es sustituible por un renderizador ligero.
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createIngestController, type IngestController } from '@/components/terrain/ingest';
import type { ExportScene, ViewOpts } from '@/lib/terrain/engine';
import { WC_BASELINE_CSS } from './wc-baseline';
import { WC_CHROME_CSS } from './wc-chrome';
import type {
  CustodyReceipt,
  GeoJSONFeatureCollection,
  Ti4goAttrs,
  Ti4goBBox,
  Ti4goHostHooks,
  Ti4goMode,
  Ti4goTheme,
  Ti4goViewerApi,
} from './contract';

export type {
  CustodyReceipt,
  GeoJSONFeatureCollection,
  Ti4goAttrs,
  Ti4goBBox,
  Ti4goHostHooks,
  Ti4goMode,
  Ti4goTheme,
  Ti4goViewerApi,
} from './contract';

type Ti4goAppComponent = React.ComponentType<{
  attrs: Ti4goAttrs;
  controller: IngestController;
  secure: boolean;
  hooks: Ti4goHostHooks;
}>;

/** Import dinámico cacheado del app (lazy: sin instancias no se carga el motor). */
let appPromise: Promise<Ti4goAppComponent> | null = null;

/** Normaliza los atributos del contrato (defaults: url-sync on · dark · expert). */
function readAttrs(el: HTMLElement): Ti4goAttrs {
  const urlSync = el.getAttribute('url-sync') !== 'false'; // default true; "false" apaga (D-2)
  const themeRaw = el.getAttribute('theme');
  const theme: Ti4goTheme = themeRaw === 'day' || themeRaw === 'eink' ? themeRaw : 'dark';
  const mode: Ti4goMode = el.getAttribute('mode') === 'field' ? 'field' : 'expert';
  return { urlSync, theme, mode };
}

/**
 * Renderizador del app dentro del shadow root (inyectable para tests: bun
 * test sustituye `Ti4goViewerElement.renderer` por uno ligero sin motor).
 * `alive()` devuelve false si el elemento se desconectó mientras el import
 * dinámico estaba en vuelo — el render tardío NO debe tocar un root muerto.
 */
export type Ti4goRenderer = (
  root: Root,
  attrs: Ti4goAttrs,
  controller: IngestController,
  alive: () => boolean,
  hooks: Ti4goHostHooks
) => void;

/** Renderizador por defecto: el createRoot ya lo posee el elemento; aquí solo
 *  se renderiza el app (lazy-import) con attrs, controller por instancia y
 *  hooks de señal. */
export const defaultTi4goRenderer: Ti4goRenderer = (root, attrs, controller, alive, hooks) => {
  void (appPromise ??= import('./ti4go-app').then((m) => m.Ti4goViewerApp)).then(
    (App) => {
      if (!alive()) return;
      root.render(createElement(App, { attrs, controller, secure: true, hooks }));
    },
    (err: unknown) => {
      console.error('[ti4go-viewer] carga del app fallida:', err);
    }
  );
};

export class Ti4goViewerElement extends HTMLElement {
  /** Atributos del contrato. */
  static get observedAttributes(): string[] {
    return ['url-sync', 'theme', 'mode'];
  }

  /** CSS opcional del shadow root (el CONSUMIDOR lo puede asignar antes de
   *  instanciar para REEMPLAZAR el baseline; ver Ti4goHostHooks/docs).
   *
   *  RCA Task 61 — «estilos-WC-nunca-inyectados»: este getter era `null` y
   *  NADIE lo asignaba ⇒ el bundle renderizaba el shadow root SIN CSS ⇒ el
   *  canvas caía en flujo normal y engine.resize() realimentaba buffers
   *  impintables (1118×2^25) ⇒ TERRENO EN BLANCO en todo contexto bundle.
   *  El Shadow DOM aísla las hojas del documento por definición.
   *
   *  v1.0.1 (Task 61): baseline AUTOSUFICIENTE — tokens + cadena del lienzo
   *  + :host + override embed del h-[100dvh] (supervivencia geométrica).
   *  v1.0.2 (chrome-CSS): + WC_CHROME_CSS generado mecánicamente del CSS
   *  compilado (preflight + utilities del subtree + field-mode + thin-scroll
   *  + portales) — el chrome experto (HUD/paneles/tipografía) ahora viaja
   *  DENTRO del elemento. El consumidor que asigne `styles` SIGUE pudiendo
   *  reemplazar TODO (contrato intacto). */
  static get styles(): string {
    return WC_BASELINE_CSS + WC_CHROME_CSS;
  }

  /** Punto de inyección para tests (renderer ligero sin motor). */
  static renderer: Ti4goRenderer = defaultTi4goRenderer;

  private controller: IngestController | null = null;
  private root: Root | null = null;
  private host: HTMLDivElement | null = null;
  private attrs: Ti4goAttrs = { urlSync: true, theme: 'dark', mode: 'expert' };
  private dead = false;
  /** isSecureContext al conectar (ancla FR-7 — GPS requiere contexto seguro). */
  public secure = true;

  /** Ref vivo del API interno (lo rellena el app al montar). */
  private apiRef: { current: Ti4goViewerApi | null } = { current: null };

  /** Hooks host←elemento: identidad ESTABLE por instancia (el app nunca se
   *  re-monta por una señal; las señales salen como CustomEvents composed +
   *  bubbles SOBRE EL HOST — same-document, jamás postMessage, jamás '*'). */
  private hooks: Ti4goHostHooks = {
    registerApi: (ref) => {
      this.apiRef = ref ?? { current: null };
    },
    onCameraChange: (c) => this.emitSignal('ti4go:camera-change', c),
    onLayerSelect: (l) => this.emitSignal('ti4go:layer-select', l),
    onCustody: (r) => this.emitSignal('ti4go:custody', { packSha: r.packSha, triangles: r.triangles }),
    onDivergence: (d) => this.emitSignal('ti4go:divergence', d),
  };

  private emitSignal<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  connectedCallback(): void {
    if (this.root) return; // ya montado
    this.dead = false;
    this.secure = typeof window !== 'undefined' && window.isSecureContext === true;
    this.attrs = readAttrs(this);
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    const styles = (this.constructor as typeof Ti4goViewerElement).styles;
    if (styles && !shadow.querySelector('style[data-ti4go-styles]')) {
      const s = document.createElement('style');
      s.setAttribute('data-ti4go-styles', '');
      s.textContent = styles;
      shadow.appendChild(s);
    }
    if (!this.host) {
      const host = document.createElement('div');
      host.setAttribute('data-ti4go-root', '');
      host.style.cssText = 'display:block;width:100%;height:100%;min-height:inherit;';
      shadow.appendChild(host);
      this.host = host;
    }
    /* Clase de tema DENTRO del shadow tree (RCA Task 61): los tokens se
     * escopen en [data-ti4go-root] / [data-ti4go-root].day y los `dark:`
     * del anfitrión jamás cruzan la frontera del shadow — la clase vive aquí. */
    this.syncThemeClass();
    /* D-1: controller (y worker de ingesta) POR INSTANCIA. */
    this.controller = createIngestController();
    this.root = createRoot(this.host);
    (this.constructor as typeof Ti4goViewerElement).renderer(this.root, this.attrs, this.controller, () => !this.dead, this.hooks);
  }

  /** Sincroniza la clase de tema (dark|day) sobre el div raíz del shadow. */
  private syncThemeClass(): void {
    if (!this.host) return;
    this.host.classList.toggle('day', this.attrs.theme === 'day');
    this.host.classList.toggle('dark', this.attrs.theme !== 'day');
  }

  disconnectedCallback(): void {
    /* Desmontaje limpio: root.unmount + dispose del controller (terminate del
     * worker, promesas en vuelo rechazadas) — monta/desmonta N veces sin fugas. */
    this.dead = true;
    this.root?.unmount();
    this.root = null;
    this.controller?.dispose();
    this.controller = null;
    this.apiRef.current = null;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.root) return;
    this.attrs = readAttrs(this);
    this.syncThemeClass();
    (this.constructor as typeof Ti4goViewerElement).renderer(
      this.root,
      this.attrs,
      this.controller as IngestController,
      () => !this.dead,
      this.hooks
    );
  }

  /** Controller de esta instancia (null tras desconectar). */
  get ingestController(): IngestController | null {
    return this.controller;
  }

  /* ---------------- B-D1 · U4: API pública (contrato) ---------------- */

  /**
   * Carga un Mission Pack por uno de los 3 canales del contrato:
   *  - File: archivo local (nombre ⇒ formato por extensión).
   *  - ArrayBuffer (o vista): binario in-memory — magia PKZIP/TIFF.
   *  - GeoJSONFeatureCollection: objeto RFC 7946.
   *  - string: semilla MXP1 (protocolo MXP1 — aplica la región catalogada).
   * Resuelve con el CustodyReceipt (packSha, triangles, custody, diverge) y
   * emite `ti4go:custody` (+ `ti4go:divergence` en packs, H-4 como señal).
   */
  loadMissionPack(source: File | ArrayBuffer | GeoJSONFeatureCollection | string): Promise<CustodyReceipt> {
    const api = this.apiRef.current;
    if (!api) return Promise.reject(new Error('ti4go-viewer: app no montado aún'));
    return api.loadMissionPack(source);
  }

  /** Vuelo animado al BBox WGS84 (grados [minLon, minLat, maxLon, maxLat]).
   *  false si el motor aún no tiene modelo (el embedder puede reintentar). */
  flyToBBox(bbox: Ti4goBBox): boolean {
    return this.apiRef.current?.flyToBBox(bbox) ?? false;
  }

  /** Parche de opciones de vista (Partial<ViewOpts>). */
  setViewOpts(opts: Partial<ViewOpts>): void {
    this.apiRef.current?.setViewOpts(opts);
  }

  /** Escena del último cuadro (ExportScene con preservación A-9 en campo);
   *  null si el motor aún no tiene modelo. */
  getExportScene(): ExportScene | null {
    return this.apiRef.current?.getExportScene() ?? null;
  }
}

/** Define el custom element (idempotente; no-op fuera de navegador/SSR). */
export function defineTi4goViewer(tag = 'ti4go-viewer'): void {
  if (typeof window === 'undefined' || typeof customElements === 'undefined') return;
  if (customElements.get(tag)) return;
  customElements.define(tag, Ti4goViewerElement);
}
