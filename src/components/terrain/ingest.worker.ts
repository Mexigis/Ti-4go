/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Web Worker de ingesta de archivos GIS/CAD (extensión del roadmap 0 GPU).
 *
 * Mueve el parseo determinista (TIFF/GeoTIFF/GeoPDF/OBJ/DXF/CSV/BLEND/DWG)
 * fuera del hilo principal: la UI nunca se bloquea al adjuntar archivos de
 * hasta 50 MB. Protocolo espejo del worker de terreno:
 *
 *   main   → worker : { id, fileId, name, size, buf (transferable), anchor }
 *   worker → main   : { fileId, type: 'progress', stage, pct }
 *                     { fileId, type: 'done', ok: true, meta, geom? } (+transfer)
 *                     { fileId, type: 'done', ok: false, error }
 *
 * `id` es el id de mensaje (por si el main lo necesita correlacionar) y
 * `fileId` el id del archivo en el controlador: se hace eco en TODAS las
 * respuestas para que el controlador resuelva el destino sin estado extra.
 */

import { MAX_FILE_BYTES, parseFile, type Anchor, type IngestFormat, type IngestGeom, type IngestMeta } from '@/lib/ingest/parsers';
import type { DecodedDem } from '@/lib/ingest/geotiff-dem';
import { decodeGeoTiffDem } from '@/lib/ingest/geotiff-dem';
import { buildFrictionField, frictionRows, FRICTION_NAME_RE, type FrictionField } from '@/lib/ingest/friction';
import type { GeoidModel } from '@/lib/ingest/geoid';

interface WorkerCtx {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

const ctx = self as unknown as WorkerCtx;

export interface IngestWorkerRequest {
  id: number;
  fileId: number;
  name: string;
  size: number;
  buf: ArrayBuffer;
  anchor: Anchor;
}

export type IngestWorkerResponse =
  | { fileId: number; type: 'progress'; stage: string; pct: number }
  | {
      fileId: number;
      type: 'done';
      ok: true;
      meta: IngestMeta;
      geom: IngestGeom | null;
      /** Motor DEM Real (Task 18): raster decodificado si es TIFF/GeoTIFF */
      dem?: DecodedDem;
      demError?: string;
      /** FR-5 · D12: campo de fricción (nombre `fricc*` o rol FRICTION*) */
      field?: FrictionField;
      /** Unidad RECORTADOR (transplante inverso): nombre del .tif extraído
       *  del ZIP topográfico — nombre preferente del DEM en el store. */
      demName?: string;
      /** FR-7 · GGM25: modelo de geoides (roles GEOID-BIL/HDR del pack o
       *  ZIP nacional — result.geoid del parseo, propagado aquí). */
      geoid?: GeoidModel;
    }
  | { fileId: number; type: 'done'; ok: false; error: string };

ctx.onmessage = (ev: MessageEvent) => {
  const req = ev.data as IngestWorkerRequest;
  if (!req || typeof req.fileId !== 'number' || !(req.buf instanceof ArrayBuffer)) return;
  const fid = req.fileId;
  void (async () => {
    try {
      if (req.size > MAX_FILE_BYTES) {
        ctx.postMessage({ fileId: fid, type: 'done', ok: false, error: 'Supera el límite de 50 MB' });
        return;
      }
      const result = parseFile(req.name, req.buf, req.anchor, (stage, pct) => {
        ctx.postMessage({ fileId: fid, type: 'progress', stage, pct });
      });

      /* Motor DEM Real (Task 18): tras la cabecera (nivel 2), decodifica los
         strips de elevación (nivel 6/6 para TIFF/GeoTIFF). Best-effort: un
         fallo de decodificación NO invalida la ingesta (demError). */
      let dem: DecodedDem | undefined;
      let demError: string | undefined;
      let field: FrictionField | undefined;
      let geoid: GeoidModel | undefined;
      const fmt: IngestFormat = result.meta.format;
      // Fuente de decodificación DEM (transplante inverso): tif suelto ⇒ el
      // buffer completo; entregable en ZIP (RECORTADOR) ⇒ el tif EXTRAÍDO
      // por topopack ('demzip').
      const demSource: ArrayBuffer | null =
        fmt === 'demzip' && result.topo
          ? result.topo.tif
          : fmt === 'tiff' || fmt === 'geotiff'
            ? req.buf
            : null;
      if (fmt === 'tiff' || fmt === 'geotiff' || (fmt === 'demzip' && result.topo)) {
        if (fmt !== 'demzip' && FRICTION_NAME_RE.test(req.name)) {
          /* FR-5 · D12: el nombre declara campo de fricción ⇒ se ingesta
             como CAPA DE CAMPO (costo), NO como MDT (D12 §2.1). El fallo
             de decodificación SÍ invalida la ficha del campo (fila honesta),
             pero no la ingesta de metadatos. */
          try {
            field = buildFrictionField(
              await decodeGeoTiffDem(req.buf, (stage, pct) => {
                ctx.postMessage({ fileId: fid, type: 'progress', stage: `Fricción · ${stage}`, pct: Math.min(96, 30 + Math.round(pct * 0.6)) });
              })
            );
            result.meta.rows.push(...frictionRows(field));
          } catch (err) {
            result.meta.rows.push([
              'Campo de fricción (D12)',
              `no decodificado — ${String(err instanceof Error ? err.message : err).slice(0, 140)}`,
            ]);
          }
        } else {
          try {
            dem = await decodeGeoTiffDem(demSource ?? req.buf, (stage, pct) => {
              ctx.postMessage({ fileId: fid, type: 'progress', stage: `DEM · ${stage}`, pct: Math.min(96, 30 + Math.round(pct * 0.6)) });
            });
            result.meta.rows.push(
              ['Elevación', `decodificada · ${dem.compression} · ${dem.sampleLabel}`],
              ['Raster', `${dem.w.toLocaleString('es-MX')} × ${dem.h.toLocaleString('es-MX')} px · ${dem.strips} strips`],
              ['Cotas', `${Math.round(dem.min).toLocaleString('es-MX')} – ${Math.round(dem.max).toLocaleString('es-MX')} m`],
              ['Decodificación', `${dem.decodeMs.toFixed(0)} ms · ${(dem.bytesDecoded / 1024).toFixed(0)} KB`]
            );
          } catch (err) {
            demError = String(err instanceof Error ? err.message : err);
            result.meta.rows.push(['Elevación', `no decodificada — ${demError.slice(0, 120)}`]);
          }
        }
      }

      /* FR-5 · D12 (hallazgo del E2E dorado air-gap): en PACKS el campo de
         fricción (rol FRICTION*) viene DENTRO de result.field — el parseo
         del pack ya lo decodifica (pack.ts, dispatch por rol). Sin esta
         línea el worker lo silenciaba y el lienzo perdía la capa D12 aunque
         el manifest la trajera (el fallback sin worker sí la propagaba). */
      field = field ?? result.field;

      /* FR-7 · GGM25 (mismo patrón que field): en PACKS el geoides viene
         DENTRO de result.geoid (roles GEOID-BIL/HDR decodificados por el
         parseo del pack). Sin esta línea el worker lo silenciaba y el
         controlador perdía el datum vertical aunque el manifest lo
         trajera — la clase «el fallback enmascara al primario», hoy
         cerrada en suite por la paridad paramétrica (CAMPOS_SYNC). */
      geoid = geoid ?? result.geoid;

      /* Unidad RECORTADOR (transplante inverso) + PUERTO D-1 (WebCrypto-
         geoid): custodia del contenedor pesado vía crypto.subtle (ADR F-3)
         — el entregable topográfico Y el geoide (misma disciplina que el
         linaje local: el datum vertical queda custodiado bit a bit).
         PARIDAD (guardiana, P2): SOLO cuando el camino sync NO ya custodió
         el contenedor — los packs con manifest traen «pack sha256:…» del
         parseo (cubre el contenedor íntegro INCLUIDO el geoid) y el worker
         jamás lo enmascara (clase «el fallback enmascara al primario»). */
      if ((result.topo || geoid) && !result.meta.custody) {
        try {
          const digest = await crypto.subtle.digest('SHA-256', req.buf);
          const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
          const etiqueta = geoid
            ? result.topo
              ? `entregable topográfico + geoide ${geoid.name}`
              : `geoide ${geoid.name}`
            : 'entregable topográfico';
          result.meta.custody = `${etiqueta} sha256:${hex.slice(0, 16)}… · WebCrypto (ADR F-3, >10 MB)`;
        } catch {
          // H-3: la custodia fallida NO es silenciosa — queda declarada.
          result.meta.custody = 'custodia NO calculada (WebCrypto indisponible)';
        }
      }

      const transfer: Transferable[] = [];
      if (result.geom) {
        transfer.push(result.geom.verts.buffer as ArrayBuffer);
        transfer.push(result.geom.segs.buffer as ArrayBuffer);
        transfer.push(result.geom.pts.buffer as ArrayBuffer);
      }
      if (dem) transfer.push(dem.data.buffer as ArrayBuffer);
      if (field) {
        transfer.push(field.data.buffer as ArrayBuffer);
        transfer.push(field.classes.buffer as ArrayBuffer);
      }
      if (geoid) transfer.push(geoid.data.buffer as ArrayBuffer);
      ctx.postMessage(
        { fileId: fid, type: 'done', ok: true, meta: result.meta, geom: result.geom, dem, demError, demName: result.topo?.name, field, geoid },
        transfer
      );
    } catch (err) {
      ctx.postMessage({
        fileId: fid,
        type: 'done',
        ok: false,
        error: String(err instanceof Error ? err.message : err),
      });
    }
  })();
};
