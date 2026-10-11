/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B-D1 · U3 — ENTRY ESM DEDICADO del Web Component `ti4go-viewer`.
 *
 * Contrato: «entry ESM dedicado que monta la app con createRoot dentro del
 * shadow root (NO vite, NO lib-mode)». Este módulo se empaqueta como
 * artefacto ESM autocontenido (`bun run build:wc` → `public/wc/ti4go-viewer.js`)
 * y es el punto de consumo del embedder:
 *
 * ```html
 * <script type="module" src="/wc/ti4go-viewer.js"></script>
 * <ti4go-viewer url-sync="false" theme="day" mode="field"></ti4go-viewer>
 * ```
 *
 * DISTRIBUCIÓN (contrato): SOLO repo privado — GitHub Packages / dependencia
 * git / artefacto en release. npm público y CDN EXCLUIDOS (secuencia Apache
 * 2.0: post-validación de campo).
 *
 * Comunicación: same-document (métodos públicos + CustomEvent). NO postMessage;
 * jamás '*'.
 */

import { Ti4goViewerElement, defineTi4goViewer } from './ti4go-viewer';

defineTi4goViewer();

export { Ti4goViewerElement, defineTi4goViewer };
export type {
  Ti4goAttrs,
  Ti4goTheme,
  Ti4goMode,
  Ti4goBBox,
  CustodyReceipt,
  GeoJSONFeatureCollection,
  Ti4goViewerApi,
  Ti4goHostHooks,
  Ti4goCameraDetail,
  Ti4goLayerSelectDetail,
  Ti4goDivergenceDetail,
  Ti4goDivergenceMember,
  Ti4goCustodyDetail,
} from './contract';
