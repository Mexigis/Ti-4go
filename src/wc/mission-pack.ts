/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B-D1 · U4/U5 — implementación PURA de `loadMissionPack` (los 3 canales del
 * contrato) extraída del viewer para que `bun test` la ejecute REAL — con los
 * parsers FR-1/FR-3 de verdad — sin motor de terreno ni navegador.
 *
 * Canales (contrato VERBATIM):
 *  loadMissionPack(source: File | ArrayBuffer | GeoJSONFeatureCollection | string /*MXP1*​/):
 *    Promise<CustodyReceipt>
 *   - File: el nombre rutea el formato (extensión, misma vía del canal UI).
 *   - ArrayBuffer/vista: magia PKZIP (Mission Pack) o TIFF (MDT) — otra
 *     familia se rechaza con motivo, sin adivinar.
 *   - GeoJSONFeatureCollection: objeto RFC 7946 → JSON → parser FR-1 real.
 *   - string: semilla MXP1 (v2/legacy) → región catalogada + veredicto H-4
 *     honesto (cuadra vs catálogo).
 */

import { unpackRegionSeed } from '@/lib/terrain/seedpack';
import { getRegion, type RegionDef } from '@/lib/terrain/regions';
import type { Anchor } from '@/lib/ingest/parsers';
import type { IngestController } from '@/components/terrain/ingest';
import type { CustodyReceipt, GeoJSONFeatureCollection, Ti4goDivergenceDetail } from './contract';

/** Magia binaria → nombre sintético (los parsers rutean por extensión). */
export function sniffBinName(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'mision.zip';
  if (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00))
  ) {
    return 'mision.tif';
  }
  throw new Error('binario no reconocido por magia (solo PKZIP/TIFF)');
}

export interface MissionPackLoaderDeps {
  controller: IngestController;
  /** Anclaje escénico de la región activa (p. ej. anchorRef.current). */
  getAnchor(): Anchor;
  /** Aplica la región de la semilla MXP1 (p. ej. setRegionId del viewer). */
  setRegionId(id: string): void;
  onCustody(receipt: CustodyReceipt): void;
  onDivergence(d: Ti4goDivergenceDetail): void;
}

export type MissionPackSource = File | ArrayBuffer | GeoJSONFeatureCollection | string;

/** Crea el loader de `loadMissionPack` para un controller POR INSTANCIA. */
export function createMissionPackLoader(deps: MissionPackLoaderDeps) {
  return async function loadMissionPack(source: MissionPackSource): Promise<CustodyReceipt> {
    const anchor = deps.getAnchor();
    let name: string;
    let buf: ArrayBuffer;
    if (typeof source === 'string') {
      /* Canal 3 — string = semilla MXP1 (protocolo MXP1 v2/legacy v1). */
      const info = unpackRegionSeed(source);
      if (!info) throw new Error('semilla MXP1 inválida (formato o checksum)');
      let regionDef: RegionDef;
      try {
        regionDef = getRegion(info.id);
      } catch {
        throw new Error(`semilla MXP1 de región no catalogada: ${info.id}`);
      }
      const cuadra =
        Math.abs(info.centerLat - regionDef.centerLat) < 1e-4 &&
        Math.abs(info.centerLon - regionDef.centerLon) < 1e-4 &&
        Math.abs(info.extent - regionDef.extent) < 1;
      deps.setRegionId(info.id);
      const receipt: CustodyReceipt = {
        packSha: null,
        triangles: null,
        custody: `MXP1 v${info.version} · ${info.id} · seed ${info.seed} · ${cuadra ? 'cuadra con el catálogo' : 'CODIFICACION_DISTINTA vs catálogo'}`,
        diverge: !cuadra,
        fileName: `${info.id}.mxp1`,
        format: 'mxp1',
      };
      deps.onCustody(receipt);
      return receipt;
    }
    if (typeof File !== 'undefined' && source instanceof File) {
      /* Canal 1a — File: nombre real rutea el formato por extensión. */
      name = source.name;
      buf = await source.arrayBuffer();
    } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      /* Canal 1b — binario in-memory: magia PKZIP (Mission Pack) o TIFF
         (MDT real). Otra familia ⇒ rechazo con motivo (sin adivinar). */
      buf =
        source instanceof ArrayBuffer
          ? source
          : (source.buffer as ArrayBuffer).slice(source.byteOffset, source.byteOffset + source.byteLength);
      name = sniffBinName(buf);
    } else {
      /* Canal 2 — objeto GeoJSON FeatureCollection (RFC 7946). */
      name = 'mision.geojson';
      buf = new TextEncoder().encode(JSON.stringify(source)).slice().buffer as ArrayBuffer;
    }
    const settled = await deps.controller.ingestAsync(name, buf, anchor);
    if (settled.status !== 'done' || !settled.meta) throw new Error(settled.error ?? 'parseo fallido');
    const meta = settled.meta;
    const shaMatch = /sha256:([0-9a-f]{64})/.exec(meta.custody ?? '');
    const ent = meta.entities ?? {};
    const totalCruces =
      (ent.crucesMATCH ?? 0) + (ent.crucesCodificacion ?? 0) + (ent.crucesDIVERGE ?? 0) + (ent.crucesSinPar ?? 0);
    const receipt: CustodyReceipt = {
      packSha: shaMatch ? shaMatch[1] : null,
      triangles: totalCruces > 0 ? totalCruces : null,
      custody: meta.custody ?? '',
      diverge: meta.diverge === true,
      fileName: settled.name,
      format: meta.format,
      /* FR-7 · GGM25: el geoides ingestado (sub-grid GEOID-* del pack o ZIP
         nacional) declara el datum vertical en el receipt (aditivo). */
      ...(deps.controller.getGeoidFor(settled.id)
        ? { verticalDatum: `${deps.controller.getGeoidFor(settled.id)!.model.name} (ortométrica)` }
        : {}),
    };
    deps.onCustody(receipt);
    if (meta.format === 'pack') {
      /* H-4 como señal — el activo único: veredicto agregado + miembros. */
      const verdict =
        (ent.crucesDIVERGE ?? 0) > 0
          ? 'DIVERGE'
          : (ent.crucesCodificacion ?? 0) > 0
            ? 'CODIFICACION_DISTINTA'
            : (ent.crucesSinPar ?? 0) > 0 && (ent.crucesMATCH ?? 0) === 0
              ? 'SIN_PAR'
              : 'MATCH';
      deps.onDivergence({ verdict, members: meta.cruceDetalle ?? [] });
    }
    return receipt;
  };
}
