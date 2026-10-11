/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B-D1 · U4 — TIPOS PÚBLICOS del contrato del Web Component `ti4go-viewer`.
 *
 * Fuente contractual: docs/fr-specs/B-D1-webcomponent.md (VERBATIM).
 * Este módulo NO tiene dependencias runtime (solo tipos) — importable desde
 * el elemento, el app, el viewer y los tests sin riesgo de ciclos.
 */

import type { ExportScene, ViewOpts } from '@/lib/terrain/engine';

/** Tema del embebido (contrato: theme="dark|day|eink"). */
export type Ti4goTheme = 'dark' | 'day' | 'eink';
/** Modo del embebido (contrato: mode="field|expert"; field = preset Modo Campo). */
export type Ti4goMode = 'field' | 'expert';

/** Atributos observados, ya normalizados. */
export interface Ti4goAttrs {
  urlSync: boolean;
  theme: Ti4goTheme;
  mode: Ti4goMode;
}

/** BBox WGS84 en grados [minLon, minLat, maxLon, maxLat] (identidad FR-2). */
export type Ti4goBBox = [number, number, number, number];

/** GeoJSON FeatureCollection (RFC 7946) — canal objeto de loadMissionPack. */
export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: unknown[];
}

/**
 * Receipt de custodia de `loadMissionPack` (contrato: Promise<CustodyReceipt>).
 * `packSha` = SHA-256 del Mission Pack (H-1) cuando la fuente lo produce;
 * `triangles` = número de pares evaluados en el cruce triangular A↔B↔KML;
 * `custody` = línea de custodia del meta (bitácora H-3); `diverge` = veredicto
 * H-4 agregado (true ⇒ DIVERGE — el evento ti4go:divergence lo detalla).
 */
export interface CustodyReceipt {
  packSha: string | null;
  triangles: number | null;
  custody: string;
  diverge: boolean;
  fileName: string;
  format: string;
  /** FR-7 · GGM25: datum vertical declarado cuando la fuente trae geoides
   *  (sub-grid GEOID-BIL/HDR del pack o ZIP nacional) — p. ej.
   *  «GGM25 (ortométrica)». Ausente/undefined = elipsoidal (ADR D10). */
  verticalDatum?: string | null;
}

/** Payload del evento ti4go:layer-select (contrato {layerId, uuid, layerType}). */
export interface Ti4goLayerSelectDetail {
  layerId: string;
  uuid: string;
  layerType: string;
}

/** Payload del evento ti4go:camera-change (contrato {az, el, zoom}). */
export interface Ti4goCameraDetail {
  az: number;
  el: number;
  zoom: number;
}

/** Par NO MATCH del cruce triangular (miembro de ti4go:divergence). */
export interface Ti4goDivergenceMember {
  uuid: string;
  verdict: string;
  note: string;
  par: string;
}

/** Payload del evento ti4go:divergence (H-4 como señal — el activo único). */
export interface Ti4goDivergenceDetail {
  verdict: 'MATCH' | 'DIVERGE' | 'SIN_PAR' | 'CODIFICACION_DISTINTA';
  members: Ti4goDivergenceMember[];
}

/** Payload del evento ti4go:custody (contrato {packSha, triangles}). */
export interface Ti4goCustodyDetail {
  packSha: string | null;
  triangles: number | null;
}

/**
 * API pública del embebido (contrato):
 *  loadMissionPack(source: File | ArrayBuffer | GeoJSONFeatureCollection | string /*MXP1*​/): Promise<CustodyReceipt>
 *  flyToBBox(bbox: Ti4goBBox): boolean
 *  setViewOpts(opts: Partial<ViewOpts>): void
 *  getExportScene(): ExportScene | null
 */
export interface Ti4goViewerApi {
  loadMissionPack(source: File | ArrayBuffer | GeoJSONFeatureCollection | string): Promise<CustodyReceipt>;
  flyToBBox(bbox: Ti4goBBox): boolean;
  setViewOpts(opts: Partial<ViewOpts>): void;
  getExportScene(): ExportScene | null;
}

/**
 * Hooks host←elemento (same-document: CustomEvents sobre el host del
 * elemento; NUNCA postMessage, jamás '*'). El renderer inyectable (tests)
 * los recibe para simular señales del app sin motor.
 */
export interface Ti4goHostHooks {
  /** Ref vivo del API (el app lo rellena al montar; null al desmontar). */
  registerApi(ref: { current: Ti4goViewerApi | null } | null): void;
  onCameraChange(c: Ti4goCameraDetail): void;
  onLayerSelect(l: Ti4goLayerSelectDetail): void;
  onCustody(r: CustodyReceipt): void;
  onDivergence(d: Ti4goDivergenceDetail): void;
}
