/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GPS-ORTO — Ruta escritorio: ingesta del ZIP nacional de geoide (GGM25
 * real de INEGI: GGM25.hdr + GGM25.bil + GGM25.prj). Re-landing del mínimo
 * contractual (rollback #3, §9 2026-09-27); la ruta mission-pack (sub-grid
 * DENTRO del pack) espera V-3 y NO está aquí (honesto).
 *
 * Detección (por patrón de miembros, ANTES del Mission Pack):
 *   - exactamente 1 *.bil + 1 *.hdr + ≤1 *.prj (ignorando directorios)
 *   - SIN manifest.json ⇒ no es un Mission Pack (FR-3 lo reclamaría)
 *   - patrón no encajado ⇒ null (el llamador cae a parseMissionPack)
 *   - patrón encajado + BIL hostil ⇒ Error legible (rechazo limpio)
 *
 * El ZIP se lee con el lector PKZIP 0-dep de FR-3 (CRC32 por entrada,
 * techo duro, ZIP64/cifradas/bomba ⇒ hostiles ya catalogados allí).
 *
 * El modelo NO viaja en la geometría (grid ≠ vectores): el payload BIL va
 * en ParseResult.geoid como transferible; el hilo principal reconstruye el
 * modelo (parseGeoidBil es O(1) sobre los bytes) y activa el registro
 * (setActiveGeoid) — ficha, chip GPS FR-7 y fila de datum del cajetín.
 *
 * FR-W1: la suite usa BIL sintéticos; el ZIP real de upload/ solo se usa
 * como evidencia E2E (estructural, sin benchmark V-3/V-5 — columna del
 * propietario).
 */

import {
  MAX_FILE_BYTES,
  type Anchor,
  type IngestMeta,
  type ParseProgress,
  type ParseResult,
} from './parsers';
import { readZip } from './zip';
import { parseGeoidBil } from '../terrain/geoid';

function baseName(name: string): string {
  const i = name.lastIndexOf('/');
  return i >= 0 ? name.slice(i + 1) : name;
}

function extOf(name: string): string {
  const b = baseName(name).toLowerCase();
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1) : '';
}

/** ¿Los miembros encajan el patrón de geoide nacional? */
function looksLikeGeoidZip(names: string[]): boolean {
  let bil = 0;
  let hdr = 0;
  let prj = 0;
  let other = 0;
  for (const n of names) {
    if (n.endsWith('/')) continue; // entrada de directorio
    const e = extOf(n);
    if (e === 'bil') bil++;
    else if (e === 'hdr') hdr++;
    else if (e === 'prj') prj++;
    else other++;
  }
  return bil === 1 && hdr === 1 && prj <= 1 && other === 0;
}

/** Punto de entrada del dispatcher (parseFile, caso 'pack'). Devuelve
 *  null cuando el ZIP NO es un geoide (cae al Mission Pack intacto). */
export function parseGeoidPack(
  buf: ArrayBuffer,
  anchor: Anchor,
  progress: ParseProgress = () => {}
): ParseResult | null {
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 16));
  void head;
  const zip = readZip(new Uint8Array(buf));
  if (!zip.ok) return null; // ZIP fracturado: lo cataloga pack.ts con su catálogo

  const names = zip.entries.map((e) => e.name);
  if (!looksLikeGeoidZip(names)) return null;

  progress('Geoide nacional · verificando CRC32 por entrada', 30);
  const bilEntry = zip.entries.find((e) => extOf(e.name) === 'bil')!;
  const hdrEntry = zip.entries.find((e) => extOf(e.name) === 'hdr')!;
  const prjEntry = zip.entries.find((e) => extOf(e.name) === 'prj');

  const name = baseName(bilEntry.name).replace(/\.[^.]+$/, '') || 'GGM25';
  const hdrText = new TextDecoder('utf-8', { fatal: false }).decode(hdrEntry.data);
  progress('Geoide nacional · construyendo modelo', 72);

  const model = parseGeoidBil(hdrText, bilEntry.data, name);
  if (!model) {
    throw new Error(
      'ZIP de geoide hostil o inválido: cabecera BIL fracturada, tipo de píxel no soportado (solo FLOAT32/INT16 LE), dimensiones inconsistentes con el binario o presupuesto excedido'
    );
  }

  const m = model.meta;
  const nCenter = model.sample(anchor.centerLon, anchor.centerLat);
  const spanLon = m.lonMax - m.lonMin;
  const spanLat = m.latMax - m.latMin;
  const minArc = Math.min(m.xdim, m.ydim) * 60;

  const meta: IngestMeta = {
    format: 'geoid',
    label: `Geoide ${name}`,
    magicOk: true,
    crs: 'GCS GRS 1980 (≈ WGS84 · nota ADR D10)',
    rows: [
      ['Formato', `BIL+HDR ESRI · parser 0-dep`],
      [
        'Rejilla',
        `${m.ncols.toLocaleString('es-MX')} × ${m.nrows.toLocaleString('es-MX')} celdas · ${minArc.toFixed(minArc < 10 ? 1 : 0)}′ de arco`,
      ],
      [
        'Cobertura',
        `lon ${m.lonMin.toFixed(2)}° → ${m.lonMax.toFixed(2)}° · lat ${m.latMin.toFixed(2)}° → ${m.latMax.toFixed(2)}° (${spanLon.toFixed(0)}° × ${spanLat.toFixed(0)}°)`,
      ],
      [
        'Píxel',
        `${m.pixelType === 'float32' ? 'Float32' : 'Int16'} LE · NODATA ${Number.isNaN(m.nodata) ? 'NaN' : m.nodata}`,
      ],
      ['Datum rejilla', 'GCS GRS 1980 (≈ WGS84 · nota ADR D10)'],
      [
        'N en centro de región',
        nCenter !== null ? `${nCenter.toFixed(2)} m (muestra bilinear)` : 'fuera de cobertura',
      ],
      ['Conversión', 'H = h − N · GPS-ORTO (FR-7)'],
      [
        'Binario',
        `${(bilEntry.data.length / (1024 * 1024)).toFixed(1)} MB · CRC32 verificado (FR-3)`,
      ],
    ],
    entities: undefined,
  };

  progress('Geoide nacional · listo', 96);

  // Copia propia para transferir al hilo principal (la entrada puede ser
  // una vista sobre el buffer del ZIP completo).
  const bilCopy = bilEntry.data.slice();

  const result: ParseResult & { geoid: NonNullable<ParseResult['geoid']> } = {
    meta,
    geom: null,
    geoid: {
      name,
      hdr: hdrText,
      prj: prjEntry ? new TextDecoder('utf-8', { fatal: false }).decode(prjEntry.data) : null,
      bil: bilCopy.buffer as ArrayBuffer,
      nCenter,
    },
  };
  return result;
}
