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

import type { Contours } from '@/lib/terrain/contours';
import { buildContours } from '@/lib/terrain/contours';
import type { DecodedDem } from '@/lib/ingest/geotiff-dem';
import { buildRealTerrain, type RealDemMeta } from '@/lib/terrain/dem';
import type { TerrainModel } from '@/lib/terrain/generator';
import { buildTerrain } from '@/lib/terrain/generator';
import type { RegionDef } from '@/lib/terrain/regions';

interface WorkerCtx {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerCtx;

export type TerrainWorkerRequest =
  | { id: number; type: 'generate'; region: RegionDef }
  | { id: number; type: 'generate-real'; dem: DecodedDem; region: RegionDef; fileName: string };

export type TerrainWorkerResponse =
  | { id: number; type: 'progress'; stage: string; pct: number }
  | { id: number; type: 'result'; ok: true; model: TerrainModel; contours: Contours; real?: RealDemMeta }
  | { id: number; type: 'result'; ok: false; error: string };

function collectTransferables(model: TerrainModel, contours: Contours): ArrayBuffer[] {
  // Dedup imprescindible: Douglas-Peucker devuelve el MISMO buffer cuando no
  // recorta (p. ej. variante fina ≡ ligera en polilíneas simples), y
  // postMessage rechaza buffers duplicados en la lista de transferibles.
  const seen = new Set<ArrayBuffer>();
  const bufs: ArrayBuffer[] = [];
  const add = (a: Float32Array | undefined | null): void => {
    if (a && a.buffer) {
      const b = a.buffer as ArrayBuffer;
      if (!seen.has(b)) {
        seen.add(b);
        bufs.push(b);
      }
    }
  };
  add(model.grid.h);
  for (const s of model.streams) add(s);
  for (const b of model.basins) add(b.ring);
  for (const l of contours.levels) {
    for (const p of l.polys) add(p.pts);
    if (l.polysLight) for (const p of l.polysLight) add(p.pts);
  }
  return bufs;
}

ctx.onmessage = (ev: MessageEvent) => {
  const req = ev.data as TerrainWorkerRequest;
  if (!req || (req.type !== 'generate' && req.type !== 'generate-real')) return;
  try {
    if (req.type === 'generate-real') {
      /* Motor DEM Real (Task 18): reamuestreo del raster nativo + cauces +
         curvas de nivel reales, todo en este hilo (0 GPU). A-01: el stage
         es visible en el overlay — nombra el hilo que procesa. */
      ctx.postMessage({ id: req.id, type: 'progress', stage: 'Procesando en Worker · reamuestreo MDT real', pct: 30 });
      const res = buildRealTerrain(req.dem, req.region, req.fileName);
      if (!res.ok) {
        ctx.postMessage({ id: req.id, type: 'result', ok: false, error: res.error });
        return;
      }
      ctx.postMessage({ id: req.id, type: 'progress', stage: 'Procesando en Worker · curvas reales (1 m / 25 m)', pct: 70 });
      const transfer = collectTransferables(res.model, res.contours);
      ctx.postMessage(
        { id: req.id, type: 'result', ok: true, model: res.model, contours: res.contours, real: res.meta },
        transfer
      );
      return;
    }
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
