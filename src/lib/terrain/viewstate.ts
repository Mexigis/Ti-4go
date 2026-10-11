/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Estado de vista por URL (§6.2 del roadmap 0 GPU) — Air-Gap friendly.
 *
 * La vista completa (región + cámara + capas) vive en el fragmento del URL,
 * sin servidor y sin estado: comparte el enlace o lo guarda en marcadores y
 * el visor reproduce la escena exacta. Formato compacto y tolerante:
 *
 *   #v=1|r=soledad|az=-45.0|el=35.3|z=1.00|p=-12x34|L=111011111|er=2000x2545|fs=0|e=0|s=0
 *
 *  - v  versión del formato (solo se acepta 1)
 *  - r  id de la región (validado contra el catálogo por el consumidor)
 *  - az/el grados (1 decimal) · z zoom (2 decimales) · p pan px (enteros)
 *  - L  capas booleanas en orden fijo (9 bits, ver LAYER_KEYS)
 *  - er rango de elevación [min x max] · fs intervalo forzado (0 = auto)
 *  - e  modo E-Ink · s Modo Ahorro
 *
 * El parseo es defensivo: cualquier clave inválida se descarta y si faltan
 * las esenciales (az/el/z) devuelve null ⇒ vista por defecto. El motor
 * re-clampa los valores a sus rangos legales (setCamera).
 */

import type { ViewOpts } from './engine';

/** Orden fijo de los 9 bits de capas dentro de `L`. */
const LAYER_KEYS = [
  'minor',
  'major',
  'mesh',
  'nodes',
  'streams',
  'divides',
  'labels',
  'cotas',
  'inegi',
] as const;

const ZOOM_MIN = 0.12;
const ZOOM_MAX = 90;
const FS_VALID = new Set([0, 1, 2, 5]);

export interface ViewCamera {
  /** radianes (convención del motor) */
  az: number;
  el: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface ParsedView {
  regionId?: string;
  cam?: ViewCamera;
  layers?: Partial<ViewOpts>;
}

/** Codifica región + cámara + capas al fragmento de URL (sin '#'). */
export function encodeViewHash(
  regionId: string,
  cam: ViewCamera,
  opts: ViewOpts
): string {
  const az = (((cam.az * 180) / Math.PI) % 360).toFixed(1);
  const el = ((cam.el * 180) / Math.PI).toFixed(1);
  const z = cam.zoom.toFixed(2);
  const px = Math.round(cam.panX);
  const py = Math.round(cam.panY);
  let bits = '';
  for (const k of LAYER_KEYS) bits += opts[k] ? '1' : '0';
  const er = `${Math.round(opts.elevRange[0])}x${Math.round(opts.elevRange[1])}`;
  const fs = FS_VALID.has(opts.forcedStep) ? opts.forcedStep : 0;
  return (
    `v=1|r=${regionId}|az=${az}|el=${el}|z=${z}|p=${px}x${py}` +
    `|L=${bits}|er=${er}|fs=${fs}|e=${opts.eink ? 1 : 0}|s=${opts.powerSave ? 1 : 0}`
  );
}

/** Decodifica el fragmento; null si la versión o los datos esenciales no valen. */
export function parseViewHash(hash: string): ParsedView | null {
  if (typeof hash !== 'string' || !hash.startsWith('#v=1|')) return null;
  const out: ParsedView = {};
  let ok = false;

  for (const kv of hash.slice(1).split('|')) {
    const eq = kv.indexOf('=');
    if (eq < 1) continue;
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);

    switch (k) {
      case 'r': {
        // id conservador: [a-z0-9-] hasta 40 chars; la existencia la valida el catálogo
        if (/^[a-z0-9-]{1,40}$/.test(v)) {
          out.regionId = v;
          ok = true;
        }
        break;
      }
      case 'az':
      case 'el': {
        const n = Number(v);
        if (Number.isFinite(n) && Math.abs(n) <= 720) {
          out.cam ??= { az: -Math.PI / 4, el: (35.264 * Math.PI) / 180, zoom: 1, panX: 0, panY: 0 };
          if (k === 'az') out.cam.az = (n * Math.PI) / 180;
          else out.cam.el = (n * Math.PI) / 180;
          ok = true;
        }
        break;
      }
      case 'z': {
        const n = Number(v);
        if (Number.isFinite(n) && n >= ZOOM_MIN * 0.9 && n <= ZOOM_MAX * 1.1) {
          out.cam ??= { az: -Math.PI / 4, el: (35.264 * Math.PI) / 180, zoom: 1, panX: 0, panY: 0 };
          out.cam.zoom = n;
          ok = true;
        }
        break;
      }
      case 'p': {
        const m = v.match(/^(-?\d+)x(-?\d+)$/);
        if (m) {
          out.cam ??= { az: -Math.PI / 4, el: (35.264 * Math.PI) / 180, zoom: 1, panX: 0, panY: 0 };
          out.cam.panX = Number(m[1]);
          out.cam.panY = Number(m[2]);
        }
        break;
      }
      case 'L': {
        if (/^[01]{9}$/.test(v)) {
          const layers: Partial<ViewOpts> = {};
          LAYER_KEYS.forEach((key, i) => {
            (layers as Record<string, boolean>)[key] = v[i] === '1';
          });
          out.layers = { ...(out.layers ?? {}), ...layers };
        }
        break;
      }
      case 'er': {
        const m = v.match(/^(-?\d{1,5})x(-?\d{1,5})$/);
        if (m) {
          const a = Number(m[1]);
          const b = Number(m[2]);
          if (a < b) out.layers = { ...(out.layers ?? {}), elevRange: [a, b] };
        }
        break;
      }
      case 'fs': {
        const n = Number(v);
        if (FS_VALID.has(n)) out.layers = { ...(out.layers ?? {}), forcedStep: n };
        break;
      }
      case 'e': {
        if (v === '0' || v === '1') out.layers = { ...(out.layers ?? {}), eink: v === '1' };
        break;
      }
      case 's': {
        if (v === '0' || v === '1') out.layers = { ...(out.layers ?? {}), powerSave: v === '1' };
        break;
      }
    }
  }

  if (out.cam && !Number.isFinite(out.cam.az * out.cam.el * out.cam.zoom)) return null;
  return ok ? out : null;
}
