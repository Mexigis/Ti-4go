/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Web Worker de generación de terreno (F1 del roadmap 0 GPU).
 *
 * Mueve la generación procedural (MDT + marching squares + simplificación)
 * fuera del hilo principal: la UI nunca se bloquea al cambiar de región.
 *
 * Protocolo:
 *   main → worker : { id, type: 'generate', region: RegionDef }
 *   worker → main : { id, type: 'progress', stage, pct }
 *                   { id, type: 'result', ok: true,  model, contours } (+ transferables)
 *                   { id, type: 'result', ok: false, error }
 *
 * Los buffers (Float32Array del MDT, cauces, anillos y vértices de curvas)
 * se transfieren con copia cero vía Transferables. El `id` permite cancelar
 * resultados obsoletos: si el usuario cambia de región en vuelo, el visor
 * ignora cualquier respuesta con id distinto al de la petición vigente.
 */

import type { Contours } from './contours';
import { buildContours } from './contours';
import type { TerrainModel } from './generator';
import { buildTerrain } from './generator';
import type { RegionDef } from './regions';

interface WorkerCtx {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerCtx;

export type TerrainWorkerRequest = {
  id: number;
  type: 'generate';
  region: RegionDef;
};

export type TerrainWorkerResponse =
  | { id: number; type: 'progress'; stage: string; pct: number }
  | { id: number; type: 'result'; ok: true; model: TerrainModel; contours: Contours }
  | { id: number; type: 'result'; ok: false; error: string };

function collectTransferables(model: TerrainModel, contours: Contours): ArrayBuffer[] {
  const bufs: ArrayBuffer[] = [];
  const add = (a: Float32Array | undefined | null): void => {
    if (a && a.buffer) bufs.push(a.buffer as ArrayBuffer);
  };
  add(model.grid.h);
  for (const s of model.streams) add(s);
  for (const b of model.basins) add(b.ring);
  for (const l of contours.levels) {
    for (const p of l.polys) add(p.pts);
  }
  return bufs;
}

ctx.onmessage = (ev: MessageEvent) => {
  const req = ev.data as TerrainWorkerRequest;
  if (!req || req.type !== 'generate') return;
  try {
    ctx.postMessage({ id: req.id, type: 'progress', stage: 'Esculpiendo el relieve', pct: 25 });
    const model = buildTerrain(req.region);
    ctx.postMessage({
      id: req.id,
      type: 'progress',
      stage: 'Extrayendo curvas de nivel (1 m / 25 m)',
      pct: 60,
    });
    const contours = buildContours(model.grid);
    ctx.postMessage({ id: req.id, type: 'progress', stage: 'Empaquetando geometría', pct: 90 });
    const transfer = collectTransferables(model, contours);
    ctx.postMessage({ id: req.id, type: 'result', ok: true, model, contours }, transfer);
  } catch (err) {
    ctx.postMessage({ id: req.id, type: 'result', ok: false, error: String(err) });
  }
};
