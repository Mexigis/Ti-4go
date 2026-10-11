/**
 * TI4GO-VIEWER — tipos públicos del Web Component (B-D1).
 *
 * ESTE ARCHIVO ES EL SUPERFICIE PÚBLICO PARA EMBEDDERS: acompaña al artefacto
 * `ti4go-viewer.js` (mismo directorio, release del repo privado).
 *
 * Fuente contractual: src/wc/contract.ts (+ docs/fr-specs/B-D1-webcomponent.md).
 * Declaración ESTRUCTURAL autocontenida (0 imports) — cualquier divergencia
 * entre este archivo y el contrato interno se considera BUG y se corrige en
 * ambos lados (el guard del API de tests/forense_wc.test.ts protege la
 * existencia de los 4 métodos; los payloads viajan por CustomEvent detail).
 *
 * Uso:
 *   import type { Ti4goViewerElement } from 'ti4go-viewer.d.ts';
 *   const el = document.createElement('ti4go-viewer');
 *   el.setAttribute('theme', 'eink');
 *   host.appendChild(el);
 *   await el.loadMissionPack(fileOrBufferOrMxp1);
 *   el.addEventListener('ti4go:custody', (e) => console.log(e.detail));
 */

/** Tema del embebido (atributo theme="dark|day|eink"). */
export type Ti4goTheme = 'dark' | 'day' | 'eink';
/** Modo del embebido (atributo mode="field|expert"; field = preset Modo Campo). */
export type Ti4goMode = 'field' | 'expert';

/** BBox WGS84 en grados [minLon, minLat, maxLon, maxLat]. */
export type Ti4goBBox = [number, number, number, number];

/** GeoJSON FeatureCollection (RFC 7946) — canal objeto de loadMissionPack. */
export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: unknown[];
}

/** Receipt de custodia que resuelve loadMissionPack (Promise<CustodyReceipt>). */
export interface CustodyReceipt {
  /** SHA-256 del Mission Pack cuando la fuente lo produce; null si no aplica. */
  packSha: string | null;
  /** Pares evaluados en el cruce triangular A↔B↔KML; null si no aplica. */
  triangles: number | null;
  /** Línea de custodia legible del meta (bitácora). */
  custody: string;
  /** true ⇒ el cruce agregado declara DIVERGE (detalle en ti4go:divergence). */
  diverge: boolean;
  fileName: string;
  format: string;
  /** FR-7 · GGM25: datum vertical cuando la fuente trae geoides (p. ej.
   *  «GGM25 (ortométrica)»); ausente = elipsoidal (declaración honesta). */
  verticalDatum?: string | null;
}

/** Payload de ti4go:layer-select. */
export interface Ti4goLayerSelectDetail {
  layerId: string;
  uuid: string;
  layerType: string;
}

/** Payload de ti4go:camera-change. */
export interface Ti4goCameraDetail {
  az: number;
  el: number;
  zoom: number;
}

/** Miembro NO MATCH del cruce triangular (miembro de ti4go:divergence). */
export interface Ti4goDivergenceMember {
  uuid: string;
  verdict: string;
  note: string;
  par: string;
}

/** Payload de ti4go:divergence (H-4 como señal). */
export interface Ti4goDivergenceDetail {
  verdict: 'MATCH' | 'DIVERGE' | 'SIN_PAR' | 'CODIFICACION_DISTINTA';
  members: Ti4goDivergenceMember[];
}

/** Payload de ti4go:custody. */
export interface Ti4goCustodyDetail {
  packSha: string | null;
  triangles: number | null;
}

/** Mapa de eventos declarados (CustomEvent<T> composed+bubbles; jamás postMessage). */
export interface Ti4goEventMap {
  'ti4go:layer-select': CustomEvent<Ti4goLayerSelectDetail>;
  'ti4go:camera-change': CustomEvent<Ti4goCameraDetail>;
  'ti4go:custody': CustomEvent<Ti4goCustodyDetail>;
  'ti4go:divergence': CustomEvent<Ti4goDivergenceDetail>;
}

/**
 * Elemento <ti4go-viewer> — lienzo isométrico E-Ink embebible (Shadow DOM).
 *
 * Atributos observados:
 *   url-sync  : "false" apaga TODA sincronización con el URL (#v=1) en ambas
 *               direcciones (default: activada).
 *   theme     : "dark" | "day" | "eink"  (default dark; eink = B/N puro campo).
 *   mode      : "field" | "expert"        (default expert; field = Modo Campo).
 */
export declare class Ti4goViewerElement extends HTMLElement {
  /* Carga de misión — 3 canales + semilla:
     · File (input/drag&drop del anfitrión)
     · ArrayBuffer (ZIP de misión o TIFF — sniff por firma PK/TIFF)
     · GeoJSON FeatureCollection (RFC 7946)
     · string "MXP1-…" (semilla de región comprimida)
     Rechaza con Error si el formato no es soportado o el paquete es hostil. */
  loadMissionPack(
    source: File | ArrayBuffer | GeoJSONFeatureCollection | string
  ): Promise<CustodyReceipt>;

  /** Vuela la cámara al BBox (grados WGS84). false si no hay escena lista. */
  flyToBBox(bbox: Ti4goBBox): boolean;

  /** Parchea opciones de vista (capas booleanas, forzado de intervalo, …).
   *  Las conmutaciones emiten ti4go:layer-select igual que la UI. */
  setViewOpts(opts: Record<string, unknown>): void;

  /** Escena del último cuadro para export vectorial del anfitrión; null si
   *  aún no hay escena. Estructura ExportScene (model/contours/opts/cam/…). */
  getExportScene(): {
    model: { region: { id: string } };
    [k: string]: unknown;
  } | null;

  addEventListener<K extends keyof Ti4goEventMap>(
    type: K,
    listener: (ev: Ti4goEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener<K extends keyof Ti4goEventMap>(
    type: K,
    listener: (ev: Ti4goEventMap[K]) => void,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'ti4go-viewer': Ti4goViewerElement;
  }
}
