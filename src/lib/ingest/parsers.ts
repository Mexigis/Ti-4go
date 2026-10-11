/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parsers de ingesta de archivos GIS/CAD — CPU puro, determinista, 0 GPU.
 *
 * Formatos soportados (límite duro 50 MB, validado antes de parsear):
 *   TIFF / GeoTIFF → cabeceras IFD + GeoKeys (EPSG, escala, esquinas)
 *   GeoPDF (PDF)   → cabecera %PDF + marcadores GeoPDF/TerraGo (heurística)
 *   OBJ            → vértices/caras/líneas → geometría vectorial
 *   DXF            → ENTITIES (LINE/LWPOLYLINE/POLYLINE/CIRCLE/ARC/POINT/3DFACE)
 *   CSV            → puntos con lat/lon o X/Y métricas + cota opcional
 *   GeoJSON        → RFC 7946 (grados) / UTM 14N con crs declarado,
 *                    auto-detección por magnitud (FR-1, ver geojson.ts)
 *   KML            → OGC 07-147r2 (WGS84 por spec), XXE-safe, identidad
 *                    por Placemark para cruce par-a-par (FR-2, ver kml.ts)
 *   ZIP            → Mission Pack: manifest.json → dispatch por rol +
 *                    cruce triangular A↔B↔KML + SHA-256 (FR-3, ver pack.ts)
 *   Blender .blend → firma binaria (versión, punteros, endianness)
 *   DWG            → firma de versión (AC10xx → año de AutoCAD)
 *
 * Filosofía del SDK: nada de decodificación de píxeles ni librerías nativas;
 * solo metadatos verificables y geometría vectorial renderizable
 * (CSV/OBJ/DXF). Los binarios cerrados (DWG/BLEND) entregan su auditoría de
 * cabecera, sin prometer más.
 *
 * Anclaje escénico (Anchor): la geometría de entrada (unidades arbitrarias o
 * grados) se normaliza DENTRO del encuadre de la región activa — caja al 84 %
 * del extent, elevación mapeada al rango de la región. Determinista: mismo
 * archivo + misma región ⇒ misma proyección.
 */

import { parseGeoJson, utm14nToWgs84 } from './geojson';
import { parseKml } from './kml';
import { parseMissionPack } from './pack';
import { parseGgm25Zip, geoidFichaRows, type GeoidModel } from './geoid';
import { readZip, type ZipEntry } from './zip';
import type { FrictionField } from './friction';
// Unidad RECORTADOR (transplante inverso, ):
// entregable topográfico en ZIP — patrón hermano del geoide.
import { extractTopoPack, classifyTopo, tfwxRows } from './topopack';
// EX-vectorial (directiva «Agenda §2 ACEPTADA», ):
// canal shapefile — la reproyección pesada vive EX-side, jamás aquí.
import { classifyPrj, readDbf, readShp } from './shapefile';

/* ------------------------------------------------------------------ */
/* Tipos                                                              */
/* ------------------------------------------------------------------ */

export type IngestFormat =
  | 'tiff'
  | 'geotiff'
  | 'geopdf'
  | 'obj'
  | 'dxf'
  | 'csv'
  | 'geojson'
  | 'kml'
  | 'pack'
  | 'blend'
  | 'dwg'
  | 'demzip'
  | 'carta'
  | 'geoidpack'
  | 'vectorpack';

/** Límite duro por archivo (solicitud del propietario). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Atributo accept del input + validación por extensión. */
export const INGEST_ACCEPT =
  '.tif,.tiff,.geotiff,.pdf,.geopdf,.obj,.dxf,.csv,.geojson,.json,.kml,.zip,.blend,.dwg';

/** Presupuestos deterministas de parseo (nunca OOM ni bucles infinitos). */
export const MAX_VERTS = 300_000;
export const MAX_SEGS = 400_000;
const MAX_CSV_ROWS = 60_000;
const MAX_IFDS = 64;
const MAX_DXF_LAYERS = 200;

export interface IngestMeta {
  format: IngestFormat;
  /** Etiqueta corta legible: "GeoTIFF", "DXF 2018"… */
  label: string;
  /** La firma/cabecera coincide con el formato esperado. */
  magicOk: boolean;
  /** Pares etiqueta→valor para la ficha de auditoría. */
  rows: Array<[string, string]>;
  /** Conteo de entidades por tipo (OBJ/DXF/CSV). */
  entities?: Record<string, number>;
  /** CRS declarado o inferido. */
  crs?: string;
  /** Nota si el parseo se recortó por presupuesto. */
  truncated?: string;
  /** Tipo semántico de la capa (gramática de línea D11, FR-4). Fuente:
   *  rol del manifest del pack o ExtendedData del KML. Tipo desconocido
   *  ⇒ codificación genérica + nota (forward-compat D11). */
  layerType?: string;
  /** Estado de calidad de datos del cruce triangular (FR-3/H-4): la capa
   *  participa en un DIVERGE ⇒ marcador visible de advertencia en LIENZO. */
  diverge?: boolean;
  /** v1.1 defensiva (FR-4, checkpoint ): clase de
   *  ruta propuesta por el schema v1.1 del ADR. Se CONSUME si presente,
   *  default «primaria» si ausente — la emisión del consorcio respeta
   *  REQ-10. Fuentes: manifest del pack, ExtendedData del KML (doc o
   *  primer Placemark) o properties del primer feature GeoJSON. */
  routeClass?: string;
  /** v1.1 defensiva: confianza 0-100. Ausente/inválida ⇒ 100 (dibujado
   *  confirmado); < 50 ⇒ «probable, no confirmado» (punteado, sin nodos). */
  confidence?: number;
  /** B-D1 · U4: detalle de los pares NO MATCH del cruce triangular (H-4)
   *  para la señal ti4go:divergence {verdict, members}. Solo lo llena el
   *  Mission Pack (fuente del cruce A↔B↔KML). Aditivo (0 cambio para los
   *  consumidores existentes). */
  cruceDetalle?: Array<{ uuid: string; verdict: string; note: string; par: string }>;
  /** Cadena de custodia (FR-3): SHA-256 del pack completo + digest H-1.
   *  La bitácora la registra; H-3: el fallo de registro NO es silencioso. */
  custody?: string;
}

export interface IngestGeom {
  /** Vértices xyz en metros locales de la escena (X=este, Y=norte, Z=cota). */
  verts: Float32Array; // 3·n
  /** Pares de índices de segmento (aristas). */
  segs: Uint32Array; // 2·m
  /** Índices de puntos sueltos (CSV/POINT). */
  pts: Uint32Array;
}

export interface ParseResult {
  meta: IngestMeta;
  geom: IngestGeom | null;
  /** FR-5 · D12: campo de fricción decodificado (pack rol FRICTION*).
   *  El worker lo transfiere al controlador — no pasa por geom. */
  field?: FrictionField;
  /** FR-7 · GGM25: modelo de geoides del pack (roles GEOID-BIL/HDR[/PRJ],
   *  sub-grid regional opcional — V-3 pendiente) o del ZIP nacional.
   *  Asentado en la paridad worker/sync (CAMPOS_SYNC). */
  geoid?: GeoidModel;
  /** Unidad RECORTADOR (transplante inverso): entregable topográfico en ZIP
   *  (ruta escritorio). El worker decodifica del tif extraído para 'demzip'
   *  (Motor DEM Real); 'carta' es documental (RGB escaneada, sin
   *  elevación — nada inventado). */
  topo?: { name: string; tif: ArrayBuffer; bytes: number };
}

/** Anclaje escénico de la región activa al momento de ingestar. */
export interface Anchor {
  extentM: number;
  zMinM: number;
  zMaxM: number;
  centerLat: number;
  centerLon: number;
  /** Nombre de la región (trazabilidad en la ficha). */
  regionName: string;
}

export type ParseProgress = (stage: string, pct: number) => void;

/* ------------------------------------------------------------------ */
/* Detección de formato (extensión + firma)                           */
/* ------------------------------------------------------------------ */

const EXT_TO_FORMAT: Record<string, IngestFormat> = {
  tif: 'tiff',
  tiff: 'tiff',
  geotiff: 'tiff',
  pdf: 'geopdf',
  geopdf: 'geopdf',
  obj: 'obj',
  dxf: 'dxf',
  csv: 'csv',
  geojson: 'geojson',
  json: 'geojson',
  kml: 'kml',
  zip: 'pack',
  blend: 'blend',
  dwg: 'dwg',
};

function headAscii(head: Uint8Array, len: number): string {
  let s = '';
  const n = Math.min(len, head.length);
  for (let i = 0; i < n; i++) s += String.fromCharCode(head[i]);
  return s;
}

/** Formato por extensión; si la extensión no está mapeada, intenta por
 *  firma binaria. El `magicOk` lo decide cada parser. */
export function detectFormat(name: string, head: Uint8Array): IngestFormat | 'unknown' {
  const ext = (name.includes('.') ? name.split('.').pop() ?? '' : '').toLowerCase();
  const byExt = EXT_TO_FORMAT[ext];
  if (byExt) return byExt;
  const ascii = headAscii(head, 8);
  if (ascii.startsWith('BLENDER')) return 'blend';
  if (/^AC10\d\d/.test(ascii) || /^AC1\.\d/.test(ascii)) return 'dwg';
  if (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) return 'tiff';
  if (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a) return 'tiff';
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'geopdf';
  // ZIP (Mission Pack): firma PK\x03\x04 — la confirmación estructural la
  // hace el lector (pack.ts) ante cualquier hostilidad.
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) return 'pack';
  // XML sin extensión conocida: primer byte no-blanco '<' ⇒ KML (único XML
  // soportado); la raíz la valida el parser (kml ⇒ hostile si no es <kml>).
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c === 0x3c) return 'kml';
    break;
  }
  // GeoJSON sin extensión conocida: primer byte no-blanco '{' o '['.
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c === 0x7b || c === 0x5b) return 'geojson';
    break;
  }
  return 'unknown';
}

/** ¿La extensión está dentro de la lista soportada? (validación temprana) */
export function hasKnownExtension(name: string): boolean {
  const ext = (name.includes('.') ? name.split('.').pop() ?? '' : '').toLowerCase();
  return ext in EXT_TO_FORMAT;
}

/* ------------------------------------------------------------------ */
/* Utilidades compartidas                                             */
/* ------------------------------------------------------------------ */

function fmtNum(n: number, d = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d });
}

/** Normaliza la geometría fuente (unidades arbitrarias) al encuadre de la
 *  región: caja al 84 % del extent centrada en (0,0); Z mapeada al rango de
 *  elevación de la región (o a la cota media si es plana).
 *  Exportada para reuso del anclaje escénico en geojson.ts (FR-1). */
export function normalizeToScene(
  xs: number[],
  ys: number[],
  zs: number[],
  anchor: Anchor
): Float32Array {
  const n = xs.length;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
    if (zs[i] < minZ) minZ = zs[i];
    if (zs[i] > maxZ) maxZ = zs[i];
  }
  const dx = Math.max(maxX - minX, 1e-9);
  const dy = Math.max(maxY - minY, 1e-9);
  const s = (0.84 * anchor.extentM) / Math.max(dx, dy);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const dz = maxZ - minZ;
  const zMid = (anchor.zMinM + anchor.zMaxM) / 2;
  const verts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    verts[i * 3] = (xs[i] - cx) * s;
    verts[i * 3 + 1] = (ys[i] - cy) * s;
    // DRAPE-1: vértice SIN cota ⇒ NaN preservado (el overlay lo drapea sobre
    // el MDT activo). zMid horneado ocultaría la señal — jamás se inventa.
    if (!Number.isFinite(zs[i])) {
      verts[i * 3 + 2] = NaN;
    } else {
      verts[i * 3 + 2] =
        dz > 1e-9 ? anchor.zMinM + ((zs[i] - minZ) / dz) * (anchor.zMaxM - anchor.zMinM) : zMid;
    }
  }
  return verts;
}

/* ------------------------------------------------------------------ */
/* TIFF / GeoTIFF — IFD + GeoKeys                                     */
/* ------------------------------------------------------------------ */

const TIFF_COMPRESSION: Record<number, string> = {
  1: 'sin comprimir',
  5: 'LZW',
  6: 'JPEG (legacy)',
  7: 'JPEG',
  8: 'Deflate',
  9: 'Deflate+',
  32773: 'PackBits',
};

function parseTiff(buf: ArrayBuffer, head: Uint8Array): ParseResult {
  const le = head[0] === 0x49; // 'II' little-endian; 'MM' big-endian
  const dv = new DataView(buf);
  const magicOk =
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a);

  const rows: Array<[string, string]> = [];
  let width = 0, height = 0, bits = 0, samples = 0, compression = 0;
  let scale: number[] | null = null;
  let tie: number[] | null = null;
  let geoKeys: number[] | null = null;
  let ifdCount = 0;

  const readVals = (type: number, count: number, off: number): number[] | null => {
    try {
      const a: number[] = [];
      if (type === 3) {
        for (let i = 0; i < count && i < 4096; i++) a.push(dv.getUint16(off + i * 2, le));
        return a;
      }
      if (type === 4) {
        for (let i = 0; i < count && i < 4096; i++) a.push(dv.getUint32(off + i * 4, le));
        return a;
      }
      if (type === 11) {
        for (let i = 0; i < count && i < 4096; i++) a.push(dv.getFloat32(off + i * 4, le));
        return a;
      }
      if (type === 12) {
        for (let i = 0; i < count && i < 4096; i++) a.push(dv.getFloat64(off + i * 8, le));
        return a;
      }
    } catch {
      return null;
    }
    return null;
  };

  const readAscii = (count: number, off: number): string => {
    try {
      const u = new Uint8Array(buf, off, Math.min(count, 512));
      let s = '';
      for (let i = 0; i < u.length; i++)
        if (u[i] >= 32 && u[i] < 127) s += String.fromCharCode(u[i]);
      return s;
    } catch {
      return '';
    }
  };

  // Cadena de IFDs
  let ifdOff = dv.getUint32(4, le);
  while (ifdOff > 0 && ifdCount < MAX_IFDS) {
    ifdCount++;
    let nEntries = 0;
    try {
      nEntries = dv.getUint16(ifdOff, le);
    } catch {
      break;
    }
    for (let e = 0; e < nEntries; e++) {
      const base = ifdOff + 2 + e * 12;
      if (base + 12 > buf.byteLength) break;
      const tag = dv.getUint16(base, le);
      const type = dv.getUint16(base + 2, le);
      const count = dv.getUint32(base + 4, le);
      if (count > 4096) continue;
      const byteLen =
        type === 3 ? count * 2 : type === 4 ? count * 4 : type === 12 ? count * 8 : count;
      const off = byteLen <= 4 ? base + 8 : dv.getUint32(base + 8, le);
      switch (tag) {
        case 256: {
          const v = readVals(type, 1, off);
          if (v) width = v[0];
          break;
        }
        case 257: {
          const v = readVals(type, 1, off);
          if (v) height = v[0];
          break;
        }
        case 258: {
          const v = readVals(type, count, off);
          if (v && v.length > 0) bits = v[0];
          break;
        }
        case 259: {
          const v = readVals(type, 1, off);
          if (v) compression = v[0];
          break;
        }
        case 277: {
          const v = readVals(type, 1, off);
          if (v) samples = v[0];
          break;
        }
        case 33550: {
          const v = readVals(type, count, off);
          if (v && v.length >= 2) scale = v;
          break;
        }
        case 33922: {
          const v = readVals(type, count, off);
          if (v && v.length >= 6) tie = v;
          break;
        }
        case 34735: {
          const v = readVals(type, count, off);
          if (v) geoKeys = v;
          break;
        }
        case 34737: {
          const ascii = readAscii(count, off).trim();
          if (ascii) rows.push(['Cita geo', ascii.slice(0, 48)]);
          break;
        }
      }
    }
    try {
      ifdOff = dv.getUint32(ifdOff + 2 + nEntries * 12, le);
    } catch {
      break;
    }
  }

  const isGeo = geoKeys !== null && geoKeys.length >= 4;
  const label = isGeo ? 'GeoTIFF' : 'TIFF';
  rows.unshift(['Formato', `${label} · ${le ? 'II' : 'MM'}`]);
  rows.push([
    'Ancho × Alto',
    width && height ? `${width.toLocaleString('es-MX')} × ${height.toLocaleString('es-MX')} px` : '—',
  ]);
  rows.push(['Bits × muestras', `${bits || '—'} × ${samples || '—'}`]);
  rows.push(['Compresión', TIFF_COMPRESSION[compression] ?? (compression ? `código ${compression}` : '—')]);
  rows.push(['IFDs (páginas)', String(ifdCount)]);

  let crs: string | undefined;
  if (isGeo && geoKeys) {
    // GeoKeyDirectory: bloques de 4 shorts (KeyID, TIFFTagLoc, Count, Value)
    let modelType = 0, epsgGeo = 0, epsgProj = 0;
    for (let i = 4; i + 3 < geoKeys.length; i += 4) {
      const key = geoKeys[i];
      const val = geoKeys[i + 3];
      if (key === 1024) modelType = val;
      else if (key === 2048) epsgGeo = val;
      else if (key === 3072) epsgProj = val;
    }
    crs = epsgProj
      ? `EPSG:${epsgProj}`
      : epsgGeo
        ? `EPSG:${epsgGeo}`
        : modelType === 2
          ? 'geográfico (WGS84 asumido)'
          : undefined;
    rows.push([
      'GeoKeys',
      modelType === 2 ? 'modelo geográfico' : modelType === 1 ? 'modelo proyectado' : `tipo ${modelType || '—'}`,
    ]);
    if (scale && scale.length >= 2)
      rows.push(['Escala (m/px)', `${fmtNum(scale[0], 4)} × ${fmtNum(scale[1], 4)}`]);
    if (tie && tie.length >= 6) {
      const x0 = tie[3] - tie[0] * (scale?.[0] ?? 0);
      const y0 = tie[4] - tie[1] * (scale?.[1] ?? 0) - height * (scale?.[1] ?? 0);
      const deg = Math.abs(x0) <= 180 && Math.abs(y0) <= 180;
      rows.push([
        'Esquina inf-izq',
        deg ? `${fmtNum(x0, 5)}°, ${fmtNum(y0, 5)}°` : `${fmtNum(x0, 1)} m, ${fmtNum(y0, 1)} m`,
      ]);
    }
  } else {
    rows.push(['Geo-referencia', 'sin GeoKeys (raster crudo)']);
  }

  return {
    meta: { format: 'tiff', label, magicOk, rows, crs },
    geom: null,
  };
}

/* ------------------------------------------------------------------ */
/* PDF / GeoPDF — cabecera + marcadores heurísticos                   */
/* ------------------------------------------------------------------ */

function parsePdf(buf: ArrayBuffer): ParseResult {
  const u = new Uint8Array(buf, 0, Math.min(buf.byteLength, 512 * 1024));
  let ascii = '';
  for (let i = 0; i < u.length; i++) ascii += String.fromCharCode(u[i]);
  const head = ascii.slice(0, 16);
  const magicOk = head.startsWith('%PDF-');
  const version = magicOk ? `PDF ${head.slice(5, 8)}` : 'desconocida';

  const markers: string[] = [];
  if (/GeoPDF/i.test(ascii)) markers.push('GeoPDF');
  if (/TerraGo/i.test(ascii)) markers.push('TerraGo');
  if (/GCS_WGS_?84|GEOGRAPHIC/i.test(ascii)) markers.push('GCS WGS84');
  if (/ogc:/i.test(ascii)) markers.push('OGC');
  const pages = (ascii.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const creator = (ascii.match(/\/Creator\s*\(([^)]{0,60})/) ?? [])[1];

  const rows: Array<[string, string]> = [
    ['Formato', markers.length > 0 ? 'GeoPDF (PDF con capa geográfica)' : 'PDF'],
    ['Versión', version],
    ['Marcadores geo', markers.length ? markers.join(' · ') : 'no detectados'],
    ['Páginas (est.)', pages > 0 ? String(pages) : '—'],
    ['Creador', creator ? creator.trim() : '—'],
  ];
  return {
    meta: {
      format: 'geopdf',
      label: markers.length ? 'GeoPDF' : 'PDF',
      magicOk,
      rows,
      crs: markers.some((m) => m.startsWith('GCS')) ? 'geográfico (WGS84, heurístico)' : undefined,
    },
    geom: null,
  };
}

/* ------------------------------------------------------------------ */
/* OBJ — malla vectorial                                              */
/* ------------------------------------------------------------------ */

function parseObj(text: string, progress: ParseProgress, anchor: Anchor): ParseResult {
  const lines = text.split('\n');
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const segList: number[] = [];
  const edgeSet = new Set<number>();
  let nV = 0, nVn = 0, nVt = 0, nF = 0, nL = 0, nG = 0, nMtl = 0;
  let truncated = '';
  const MULT = 0x1000000; // 2^24 — dedupe de aristas sin strings

  const pushEdge = (a: number, b: number): void => {
    if (a === b || a < 0 || b < 0) return;
    const key = a < b ? a * MULT + b : b * MULT + a;
    if (edgeSet.has(key)) return;
    if (segList.length / 2 >= MAX_SEGS) {
      truncated = truncated || `Datos truncados por límite de rendimiento: aristas recortadas a ${MAX_SEGS.toLocaleString('es-MX')}`;
      return;
    }
    edgeSet.add(key);
    segList.push(a, b);
  };

  for (let li = 0; li < lines.length; li++) {
    if (li % 20000 === 0) {
      progress('Parseando OBJ', Math.min(95, Math.round((li / lines.length) * 95)));
      if (nV >= MAX_VERTS) {
        truncated = truncated || `Datos truncados por límite de rendimiento: vértices recortados a ${MAX_VERTS.toLocaleString('es-MX')}`;
        break;
      }
    }
    const line = lines[li];
    const c0 = line.charCodeAt(0);
    if (c0 === 118) {
      // 'v'
      if (line.startsWith('v ')) {
        const p = line.slice(2).trim().split(/\s+/);
        xs.push(parseFloat(p[0]) || 0);
        ys.push(parseFloat(p[1]) || 0);
        zs.push(parseFloat(p[2]) || 0);
        nV++;
      } else if (line.startsWith('vn')) nVn++;
      else if (line.startsWith('vt')) nVt++;
      continue;
    }
    if (c0 === 102 && line.startsWith('f ')) {
      // 'f' — wireframe del perímetro del polígono (sin diagonales de fan:
      // la malla oculta de triángulos añadiría ruido visual al contorno)
      const toks = line.slice(2).trim().split(/\s+/);
      const idx: number[] = [];
      for (const t of toks) {
        const raw = parseInt(t, 10);
        if (!Number.isFinite(raw)) continue;
        idx.push(raw < 0 ? nV + raw : raw - 1);
      }
      for (let k = 0; k + 1 < idx.length && k < 4096; k++) pushEdge(idx[k], idx[k + 1]);
      if (idx.length > 2 && idx.length <= 4096) pushEdge(idx[idx.length - 1], idx[0]);
      nF++;
      continue;
    }
    if (c0 === 108 && line.startsWith('l ')) {
      // 'l' — polilínea
      const toks = line.slice(2).trim().split(/\s+/);
      let prev = -1;
      for (const t of toks) {
        const raw = parseInt(t, 10);
        if (!Number.isFinite(raw)) continue;
        const i = raw < 0 ? nV + raw : raw - 1;
        if (prev >= 0) pushEdge(prev, i);
        prev = i;
      }
      nL++;
      continue;
    }
    if (c0 === 103 && (line.startsWith('g ') || line.startsWith('go '))) nG++;
    else if (c0 === 117 && line.startsWith('usemtl')) nMtl++;
  }
  progress('Normalizando al encuadre', 97);

  const verts = normalizeToScene(xs, ys, zs, anchor);
  const segs = new Uint32Array(segList);

  const rows: Array<[string, string]> = [
    ['Formato', 'Wavefront OBJ'],
    ['Vértices', nV.toLocaleString('es-MX')],
    ['Caras', nF.toLocaleString('es-MX')],
    ['Aristas (dedupe)', (segs.length / 2).toLocaleString('es-MX')],
    ['Normales / UV', `${nVn.toLocaleString('es-MX')} / ${nVt.toLocaleString('es-MX')}`],
    ['Grupos / materiales', `${nG.toLocaleString('es-MX')} / ${nMtl.toLocaleString('es-MX')}`],
    ['Anclado a', anchor.regionName],
  ];
  return {
    meta: {
      format: 'obj',
      label: 'OBJ',
      magicOk: nV > 0 || nF > 0 || nL > 0,
      rows,
      entities: { vértices: nV, caras: nF, aristas: segs.length / 2, líneas: nL },
      truncated: truncated || undefined,
      crs: 'local (normalizado)',
    },
    geom: segs.length > 0 ? { verts, segs, pts: new Uint32Array(0) } : null,
  };
}

/* ------------------------------------------------------------------ */
/* DXF — ENTITIES                                                     */
/* ------------------------------------------------------------------ */

const DXF_VERSIONS: Record<string, string> = {
  AC1006: 'R10', AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14',
  AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010',
  AC1027: '2013', AC1032: '2018',
};

const DXF_UNITS: Record<number, string> = {
  1: 'pulgadas', 2: 'pies', 4: 'mm', 5: 'cm', 6: 'm', 8: 'µm',
  9: 'decímetros', 10: 'decámetros', 11: 'hectómetros', 13: 'pies-US',
};

function parseDxf(text: string, progress: ParseProgress, anchor: Anchor): ParseResult {
  const lines = text.split('\n');
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const segList: number[] = [];
  const ptsIdx: number[] = [];
  const edgeSet = new Set<number>();
  const layers = new Set<string>();
  const counts: Record<string, number> = {};
  let version = '', units = 0;
  let extMin: number[] | null = null, extMax: number[] | null = null;
  let truncated = '';
  const MULT = 0x1000000;

  const pushEdge = (a: number, b: number): void => {
    if (a === b || a < 0 || b < 0) return;
    const key = a < b ? a * MULT + b : b * MULT + a;
    if (edgeSet.has(key) || segList.length / 2 >= MAX_SEGS) {
      if (segList.length / 2 >= MAX_SEGS)
        truncated = truncated || `Datos truncados por límite de rendimiento: aristas recortadas a ${MAX_SEGS.toLocaleString('es-MX')}`;
      return;
    }
    edgeSet.add(key);
    segList.push(a, b);
  };
  const addVert = (x: number, y: number, z: number): number => {
    if (xs.length >= MAX_VERTS) {
      truncated = truncated || `Datos truncados por límite de rendimiento: vértices recortados a ${MAX_VERTS.toLocaleString('es-MX')}`;
      return -1;
    }
    xs.push(x); ys.push(y); zs.push(z);
    return xs.length - 1;
  };

  // --- emisión de entidades -------------------------------------
  let poly: { xs: number[]; ys: number[]; closed: boolean; z: number } | null = null;
  let face: number[][] | null = null;
  let lineP: [number, number, number, number, number, number] | null = null;
  let circleP: [number, number, number] | null = null;
  let arcP: [number, number, number, number] | null = null; // cx, cy, r, a0
  let pointP: [number, number] | null = null;

  const emitPoly = (p: { xs: number[]; ys: number[]; closed: boolean; z: number }): void => {
    const idx: number[] = [];
    for (let i = 0; i < p.xs.length && i < p.ys.length; i++) {
      const v = addVert(p.xs[i], p.ys[i], p.z);
      if (v < 0) break;
      idx.push(v);
    }
    for (let i = 0; i + 1 < idx.length; i++) pushEdge(idx[i], idx[i + 1]);
    if (p.closed && idx.length > 2) pushEdge(idx[idx.length - 1], idx[0]);
  };
  const emitArcTess = (cx: number, cy: number, r: number, a0: number, a1: number): void => {
    if (!(r > 0)) return;
    if (a1 <= a0) a1 += 360;
    const n = 32;
    const idx: number[] = [];
    for (let k = 0; k <= n; k++) {
      const a = (a0 + ((a1 - a0) * k) / n) * (Math.PI / 180);
      const v = addVert(cx + r * Math.cos(a), cy + r * Math.sin(a), 0);
      if (v < 0) break;
      idx.push(v);
    }
    for (let k = 0; k + 1 < idx.length; k++) pushEdge(idx[k], idx[k + 1]);
  };
  const emitFace = (c: number[][]): void => {
    const idx: number[] = [];
    for (const p of c) {
      const v = addVert(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
      if (v < 0) break;
      idx.push(v);
    }
    for (let k = 0; k < idx.length; k++) pushEdge(idx[k], idx[(k + 1) % idx.length]);
  };
  /** Cierra la entidad en curso (al llegar el siguiente código 0 o EOF). */
  const flushEntity = (cur: string): void => {
    switch (cur) {
      case 'LWPOLYLINE':
      case 'POLYLINE':
        if (poly && poly.xs.length >= 2) emitPoly(poly);
        poly = null;
        break;
      case 'LINE':
        if (lineP) {
          const a = addVert(lineP[0], lineP[1], lineP[2]);
          const b = addVert(lineP[3], lineP[4], lineP[5]);
          if (a >= 0 && b >= 0) pushEdge(a, b);
          lineP = null;
        }
        break;
      case 'CIRCLE':
        if (circleP) {
          emitArcTess(circleP[0], circleP[1], circleP[2], 0, 360);
          circleP = null;
        }
        break;
      case 'ARC':
        if (arcP) {
          emitArcTess(arcP[0], arcP[1], arcP[2], arcP[3], arcEnd > arcP[3] ? arcEnd : arcP[3] + 360);
          arcP = null;
          arcEnd = 0;
        }
        break;
      case 'POINT':
        if (pointP) {
          const v = addVert(pointP[0], pointP[1], 0);
          if (v >= 0) ptsIdx.push(v);
          pointP = null;
        }
        break;
      case '3DFACE':
      case 'SOLID':
        if (face) {
          emitFace(face);
          face = null;
        }
        break;
    }
  };

  // --- barrido de pares código/valor -----------------------------
  let i = 0;
  let entity = '';
  let hdrVar = '';
  let arcEnd = 0;
  while (i < lines.length) {
    if (i % 40000 === 0) progress('Parseando DXF', Math.min(95, Math.round((i / lines.length) * 95)));
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) {
      i++;
      continue;
    }
    const val = (lines[i + 1] ?? '').trim();
    i += 2;

    if (code === 9) {
      hdrVar = val;
      continue;
    }
    if (hdrVar) {
      if (hdrVar === '$ACADVER' && code === 1) version = val;
      else if (hdrVar === '$INSUNITS' && code === 70) units = parseInt(val, 10) || 0;
      else if (hdrVar === '$EXTMIN' && code === 10) extMin = [parseFloat(val) || 0];
      else if (hdrVar === '$EXTMIN' && code === 20 && extMin) extMin[1] = parseFloat(val) || 0;
      else if (hdrVar === '$EXTMAX' && code === 10) extMax = [parseFloat(val) || 0];
      else if (hdrVar === '$EXTMAX' && code === 20 && extMax) extMax[1] = parseFloat(val) || 0;
      if (code !== 10 && code !== 20 && code !== 30 && code !== 1 && code !== 70) hdrVar = '';
      continue;
    }

    if (code === 0) {
      flushEntity(entity);
      entity = val.toUpperCase();
      if (entity === 'EOF' || entity === 'ENDSEC' || entity === 'SECTION') entity = '';
      else counts[entity] = (counts[entity] ?? 0) + 1;
      continue;
    }
    if (!entity) continue;

    switch (entity) {
      case 'LINE':
        if (code === 10) {
          if (!lineP) lineP = [0, 0, 0, 0, 0, 0];
          lineP[0] = parseFloat(val) || 0;
        }
        else if (code === 20 && lineP) lineP[1] = parseFloat(val) || 0;
        else if (code === 30 && lineP) lineP[2] = parseFloat(val) || 0;
        else if (code === 11 && lineP) lineP[3] = parseFloat(val) || 0;
        else if (code === 21 && lineP) lineP[4] = parseFloat(val) || 0;
        else if (code === 31 && lineP) lineP[5] = parseFloat(val) || 0;
        else if (code === 8) layers.add(val);
        break;
      case 'LWPOLYLINE':
      case 'POLYLINE':
        if (code === 90 && !poly) poly = { xs: [], ys: [], closed: false, z: 0 };
        else if (code === 70 && poly) poly.closed = (parseInt(val, 10) & 1) === 1;
        else if (code === 38 && poly) poly.z = parseFloat(val) || 0;
        else if (code === 30 && entity === 'POLYLINE' && poly) poly.z = parseFloat(val) || 0;
        else if (code === 10 && poly) poly.xs.push(parseFloat(val) || 0);
        else if (code === 20 && poly) poly.ys.push(parseFloat(val) || 0);
        else if (code === 8) layers.add(val);
        break;
      case 'VERTEX':
        if (code === 10 || code === 20 || code === 30) {
          if (!poly) poly = { xs: [], ys: [], closed: false, z: 0 };
          if (code === 10) poly.xs.push(parseFloat(val) || 0);
          else if (code === 20) poly.ys.push(parseFloat(val) || 0);
          else poly.z = parseFloat(val) || 0;
        } else if (code === 8) layers.add(val);
        break;
      case 'SEQEND':
        flushEntity('LWPOLYLINE');
        entity = '';
        break;
      case 'CIRCLE':
        if (code === 10) {
          if (!circleP) circleP = [0, 0, 0];
          circleP[0] = parseFloat(val) || 0;
        }
        else if (code === 20 && circleP) circleP[1] = parseFloat(val) || 0;
        else if (code === 40 && circleP) circleP[2] = parseFloat(val) || 0;
        else if (code === 8) layers.add(val);
        break;
      case 'ARC':
        if (code === 10) {
          if (!arcP) arcP = [0, 0, 0, 0];
          arcP[0] = parseFloat(val) || 0;
        }
        else if (code === 20 && arcP) arcP[1] = parseFloat(val) || 0;
        else if (code === 40 && arcP) arcP[2] = parseFloat(val) || 0;
        else if (code === 50 && arcP) arcP[3] = parseFloat(val) || 0;
        else if (code === 51) arcEnd = parseFloat(val) || 0;
        else if (code === 8) layers.add(val);
        break;
      case 'POINT':
        if (code === 10) {
          if (!pointP) pointP = [0, 0];
          pointP[0] = parseFloat(val) || 0;
        }
        else if (code === 20 && pointP) pointP[1] = parseFloat(val) || 0;
        else if (code === 8) layers.add(val);
        break;
      case '3DFACE':
      case 'SOLID':
        if (code >= 10 && code <= 13) {
          face = face ?? [
            [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
          ];
          face[code - 10][0] = parseFloat(val) || 0;
        } else if (code >= 20 && code <= 23) {
          face = face ?? [
            [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
          ];
          face[code - 20][1] = parseFloat(val) || 0;
        } else if (code >= 30 && code <= 33) {
          face = face ?? [
            [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
          ];
          face[code - 30][2] = parseFloat(val) || 0;
        } else if (code === 8) layers.add(val);
        break;
      default:
        if (code === 8) layers.add(val);
        break;
    }
  }
  if (entity === 'ARC' && arcP) {
    // el ARC termina por EOF/ENDSEC: usa el ángulo final capturado
    emitArcTess(arcP[0], arcP[1], arcP[2], arcP[3], arcEnd || arcP[3] + 360);
    arcP = null;
  }
  flushEntity(entity);
  progress('Normalizando al encuadre', 97);

  const verts = normalizeToScene(xs, ys, zs, anchor);
  const segs = new Uint32Array(segList);
  const pts = new Uint32Array(ptsIdx);

  const rows: Array<[string, string]> = [
    ['Formato', `DXF${version ? ` · AutoCAD ${DXF_VERSIONS[version] ?? version}` : ''}`],
    ['Unidades', units ? DXF_UNITS[units] ?? `código ${units}` : 'sin declarar'],
    [
      'Extensión',
      extMin && extMax
        ? `${fmtNum(extMax[0] - extMin[0], 1)} × ${fmtNum(extMax[1] - extMin[1], 1)}`
        : '—',
    ],
    ['Capas', Math.min(layers.size, MAX_DXF_LAYERS).toLocaleString('es-MX')],
    ['Vértices', xs.length.toLocaleString('es-MX')],
    ['Aristas', (segs.length / 2).toLocaleString('es-MX')],
    ['Anclado a', anchor.regionName],
  ];
  return {
    meta: {
      format: 'dxf',
      label: `DXF${version ? ` ${DXF_VERSIONS[version] ?? version}` : ''}`.trim(),
      magicOk: xs.length > 0 || Object.keys(counts).length > 0,
      rows,
      entities: counts,
      truncated: truncated || undefined,
      crs: 'local (normalizado)',
    },
    geom: segs.length > 0 || ptsIdx.length > 0 ? { verts, segs, pts } : null,
  };
}

/* ------------------------------------------------------------------ */
/* CSV — puntos geográficos o métricos                                */
/* ------------------------------------------------------------------ */

function detectDelimiter(headerLine: string): string {
  if (headerLine.startsWith('sep=')) return headerLine.slice(4).trim()[0] ?? ',';
  const cands = [',', ';', '\t', '|'];
  let best = ',', bestN = -1;
  for (const c of cands) {
    const n = headerLine.split(c).length - 1;
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseCsv(text: string, progress: ParseProgress, anchor: Anchor): ParseResult {
  const rawLines = text.split(/\r?\n/);
  let start = 0;
  let delim = detectDelimiter(rawLines[0] ?? ',');
  if ((rawLines[0] ?? '').startsWith('sep=')) start = 1;

  const firstCells = splitCsvLine(rawLines[start] ?? '', delim);
  const hasHeader = firstCells.some((c) => c.trim() !== '' && !NUM.test(c.trim()));

  const roles = { lat: -1, lon: -1, x: -1, y: -1, z: -1 };
  let nCols = firstCells.length;
  if (hasHeader) {
    const heads = firstCells.map((c) => c.trim().toLowerCase());
    const match = (pats: RegExp[]): number => heads.findIndex((h) => pats.some((p) => p.test(h)));
    roles.lat = match([/^lat$/, /^latitud(e)?$/, /^latitude$/]);
    roles.lon = match([/^lon$/, /^lng$/, /^long$/, /^longitud(e)?$/, /^longitude$/]);
    roles.x = match([/^x$/, /^este$/, /^easting$/, /^coord_x$/, /^utm_x$/]);
    roles.y = match([/^y$/, /^norte$/, /^northing$/, /^coord_y$/, /^utm_y$/]);
    roles.z = match([/^z$/, /^cota$/, /^elev.*$/, /^altura$/, /^alt$/]);
  }

  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  let skipped = 0;
  let truncated = '';
  const mPerLon = 111320 * Math.cos((anchor.centerLat * Math.PI) / 180);

  for (let li = start + (hasHeader ? 1 : 0); li < rawLines.length; li++) {
    if (li % 8000 === 0) progress('Parseando CSV', Math.min(95, Math.round((li / rawLines.length) * 95)));
    const line = rawLines[li];
    if (!line || line.trim() === '') continue;
    if (xs.length >= MAX_CSV_ROWS) {
      truncated = `Datos truncados por límite de rendimiento: filas recortadas a ${MAX_CSV_ROWS.toLocaleString('es-MX')}`;
      break;
    }
    const cells = splitCsvLine(line, delim);
    if (nCols < cells.length) nCols = cells.length;
    const num = (i: number): number => {
      if (i < 0 || i >= cells.length) return NaN;
      const v = parseFloat(cells[i].trim().replace(',', '.'));
      return Number.isFinite(v) ? v : NaN;
    };
    let x = NaN, y = NaN, z = NaN;
    if (roles.lat >= 0 && roles.lon >= 0) {
      y = num(roles.lat);
      x = num(roles.lon);
      if (roles.z >= 0) z = num(roles.z);
    } else if (!hasHeader && cells.length >= 2) {
      x = num(0);
      y = num(1);
      if (cells.length >= 3) z = num(2);
    } else if (roles.x >= 0 && roles.y >= 0) {
      x = num(roles.x);
      y = num(roles.y);
      if (roles.z >= 0) z = num(roles.z);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      skipped++;
      continue;
    }
    // Grados → metros locales alrededor del centro de la región (equirect.)
    const geographic = Math.abs(x) <= 180 && Math.abs(y) <= 90;
    const mx = geographic ? (x - anchor.centerLon) * mPerLon : x;
    const my = geographic ? (y - anchor.centerLat) * 110540 : y;
    const mz = Number.isFinite(z) ? Math.min(Math.max(z, anchor.zMinM), anchor.zMaxM) : NaN;
    // DRAPE-1: sin cota ⇒ señal NaN preservada — el overlay la drapea sobre
    // el MDT activo (z del terreno + lift 2–3 px). zMid horneado jamás.
    xs.push(mx);
    ys.push(my);
    zs.push(mz);
  }
  progress('Normalizando al encuadre', 97);

  // Los puntos CSV están ya en metros locales alrededor del centro: NO se
  // re-normalizan (perderían su ubicación real). Solo si la mayoría queda
  // fuera del extent se normaliza la caja completa para que sean visibles.
  let verts: Float32Array;
  let outOfExtent = 0;
  const maxR = 0.49 * anchor.extentM;
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i]) > maxR || Math.abs(ys[i]) > maxR) outOfExtent++;
  }
  const rescaled = xs.length > 0 && outOfExtent > xs.length * 0.5;
  if (rescaled) {
    verts = normalizeToScene(xs, ys, zs, anchor);
    truncated = truncated || 'puntos fuera del recorte: normalizados al encuadre';
  } else {
    verts = new Float32Array(xs.length * 3);
    for (let i = 0; i < xs.length; i++) {
      verts[i * 3] = xs[i];
      verts[i * 3 + 1] = ys[i];
      verts[i * 3 + 2] = zs[i];
    }
  }

  const pts = new Uint32Array(xs.length);
  for (let i = 0; i < xs.length; i++) pts[i] = i;

  const geographicIn = roles.lat >= 0 || (!hasHeader && roles.x < 0);
  const rows: Array<[string, string]> = [
    ['Formato', 'CSV (tabla de puntos)'],
    ['Delimitador', delim === '\t' ? 'tabulador' : `"${delim}"`],
    ['Columnas', String(nCols)],
    ['Cabeceras', hasHeader ? 'sí' : 'no'],
    ['Puntos válidos', xs.length.toLocaleString('es-MX')],
    ['Filas omitidas', skipped.toLocaleString('es-MX')],
    ['CRS de entrada', geographicIn ? 'geográfico (grados)' : 'métrico local'],
    ['Anclado a', anchor.regionName],
  ];
  return {
    meta: {
      format: 'csv',
      label: 'CSV',
      magicOk: xs.length > 0,
      rows,
      entities: { puntos: xs.length },
      truncated: truncated || undefined,
      crs: geographicIn ? 'geográfico (WGS84 asumido)' : 'métrico local',
    },
    geom: xs.length > 0 ? { verts, segs: new Uint32Array(0), pts } : null,
  };
}

/* ------------------------------------------------------------------ */
/* Blender .blend / DWG — firma binaria                               */
/* ------------------------------------------------------------------ */

function parseBlend(_buf: ArrayBuffer, head: Uint8Array): ParseResult {
  const ascii = headAscii(head, 12);
  const magicOk = ascii.startsWith('BLENDER');
  const ptr = ascii[7] === '-' ? '64-bit' : ascii[7] === '_' ? '32-bit' : '—';
  const endian = ascii[8] === 'v' ? 'little-endian' : ascii[8] === 'V' ? 'big-endian' : '—';
  const verRaw = ascii.slice(9, 12);
  const version = /^\d{3}$/.test(verRaw) ? `${verRaw[0]}.${verRaw.slice(1)}` : '—';
  return {
    meta: {
      format: 'blend',
      label: `Blender${version !== '—' ? ` v${version}` : ''}`,
      magicOk,
      rows: [
        ['Formato', 'Blender (.blend)'],
        ['Versión', version],
        ['Punteros', ptr],
        ['Endianness', endian],
        ['Nota', 'binario con DNA/SDNA: solo auditoría de cabecera'],
      ],
    },
    geom: null,
  };
}

const DWG_VERSIONS: Record<string, string> = {
  AC1006: 'R10', AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14',
  AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010',
  AC1027: '2013', AC1032: '2018',
};

function parseDwg(_buf: ArrayBuffer, head: Uint8Array): ParseResult {
  const ver = headAscii(head, 6);
  const magicOk = /^AC10\d\d$/.test(ver) || /^AC1\.5/.test(ver);
  return {
    meta: {
      format: 'dwg',
      label: `DWG${DWG_VERSIONS[ver] ? ` (AutoCAD ${DWG_VERSIONS[ver]})` : ''}`,
      magicOk,
      rows: [
        ['Formato', 'AutoCAD DWG'],
        ['Versión', DWG_VERSIONS[ver] ?? (ver || '—')],
        ['Nota', 'formato binario cerrado: solo firma de cabecera'],
      ],
    },
    geom: null,
  };
}

/* ------------------------------------------------------------------ */
/* Despachador                                                        */
/* ------------------------------------------------------------------ */

/* Unidad RECORTADOR — entregable topográfico en ZIP (ruta escritorio) */
/* ------------------------------------------------------------------ */

/* PUERTO D-1 — geoidpack suelto (ruta escritorio, patrón hermano del   */
/* topopack): ZIP sin manifest con par HDR+BIL (± .prj) — el modelo     */
/* nacional/regional del geoid (GGM25) viaja así. Decodificación PURA   */
/* en el parse (0-dep) ⇒ sync ≡ worker por construcción (paridad).      */
function buildGeoidResult(buf: ArrayBuffer, progress: ParseProgress): ParseResult | null {
  const zip = readZip(new Uint8Array(buf));
  if (!zip.ok) return null;
  /* Patrón estricto: exactamente 1×.hdr + 1×.bil; .prj tolerado; cualquier
     otra entrada (manifest.json, .tif, …) ⇒ NO es geoidpack — cae al
     Mission Pack/topopack intacto (null = no es geoidpack). */
  let hdr = 0;
  let bil = 0;
  let other = 0;
  for (const e of zip.entries) {
    const l = e.name.toLowerCase();
    if (l.endsWith('.hdr')) hdr++;
    else if (l.endsWith('.bil')) bil++;
    else if (!l.endsWith('.prj')) other++;
  }
  if (hdr !== 1 || bil !== 1 || other > 0) return null;
  const r = parseGgm25Zip(new Uint8Array(buf));
  if (!r.ok) return null; /* par malformado ⇒ el rechazo decide la ruta del pack */
  const model = r.model;
  progress('Geoide · BIL decodificado', 60);
  const kb = (buf.byteLength / 1024).toFixed(1);
  return {
    geom: null,
    geoid: model,
    meta: {
      format: 'geoidpack',
      label: `Geoide en ZIP · ${model.name}`,
      magicOk: true, /* firma ZIP (CRC por entrada, FR-3) + par HDR+BIL verificados */
      rows: [
        [
          'Contenedor',
          `ZIP sin manifest · par HDR+BIL · ${kb} KB · CRC32 por entrada (FR-3)`,
        ],
        ...geoidFichaRows(model),
        [
          'Ruta',
          'Datum vertical: el chip GPS convierte a ortométrica H = h − N solo con este geoid activo y fix en cobertura (FR-7)',
        ],
      ],
    },
  };
}

/** Resuelve el patrón «ZIP sin manifest con 1×.tif ± sidecars» y construye
 *  la ficha del entregable clasificada por CONTENIDO del tif:
 *  mono ⇒ 'demzip' (Motor DEM Real en el worker) · multibanda ⇒ 'carta'
 *  (escaneada documental — sin banda de elevación, se declara). */
function buildTopoResult(buf: ArrayBuffer, progress: ParseProgress): ParseResult | null {
  const ex = extractTopoPack(buf);
  if (!ex) return null;

  const kind = classifyTopo(ex);
  progress(kind === 'demzip' ? 'Sub-grid topográfico · tif extraído del ZIP' : 'Carta topográfica · tif extraído del ZIP', 40);

  const tifAb = ex.tif.buffer.slice(
    ex.tif.byteOffset,
    ex.tif.byteOffset + ex.tif.byteLength
  ) as ArrayBuffer;
  const tHead = new Uint8Array(tifAb, 0, Math.min(16, tifAb.byteLength));
  const tf = parseTiff(tifAb, tHead);

  tf.meta.format = kind;
  tf.meta.label = kind === 'demzip' ? `MDT en ZIP · ${ex.name}` : `Capa topográfica · ${ex.name}`;
  tf.meta.rows.unshift(
    [
      'Contenedor',
      `ZIP sin manifest · ${ex.entries} ${ex.entries === 1 ? 'entrada' : 'entradas'} · ${(ex.zipBytes / 1048576).toFixed(1)} MB · CRC32 por entrada (FR-3)`,
    ],
    [
      'Entregable',
      `1× .tif (${(ex.tif.length / 1048576).toFixed(1)} MB)${ex.sidecars.length ? ` + ${ex.sidecars.length} sidecar(es) (${ex.sidecars.join(', ')})` : ''} · ruta escritorio (patrón geoide · RECORTADOR)`,
    ]
  );

  if (kind === 'demzip') {
    tf.meta.rows.push([
      'Ruta',
      'Motor DEM Real: el worker decodifica los strips de elevación y el raster entra al re-muestreo del terreno',
    ]);
  } else {
    if (ex.tfwx) tf.meta.rows.push(...tfwxRows(ex.tfwx));
    tf.meta.rows.push([
      'Carta escaneada',
      `${ex.bits ?? '—'} bits × ${ex.samples ?? '—'} bandas — raster DOCUMENTAL: sin banda de elevación, NO es MDT; el motor de curvas 0 GPU no la drapea (nada inventado)`,
    ]);
  }

  return {
    meta: tf.meta,
    geom: null,
    topo: { name: ex.name, tif: tifAb, bytes: ex.tif.length },
  };
}

/** EX-vectorial — canal shapefile (unidad a, directiva checkpoint «Agenda
 *  §2 ACEPTADA» ). Resuelve el patrón «ZIP sin
 *  manifest con .shp+.dbf+.prj (± .shx/.cpg/.qix/.sbn/.sbx/.xml)»:
 *  - patrón ausente ⇒ null (cae al Mission Pack intacto);
 *  - patrón presente con .prj no soportado (p. ej. LCC-2SP ITRF92 de la
 *    fuente INEGI) ⇒ Error honesto con la guía EX-vectorial;
 *  - patrón presente y binario roto ⇒ Error honesto (no disfrazado de
 *    Mission Pack hostil).
 *  UTM 14N ⇒ WGS84 con el converso Snyder FR-1 del repo (misma vía
 *  canónica del canal GeoJSON); z = NaN por vértice ⇒ DRAPE-1 drapea
 *  sobre el MDT activo — la verificación cruzada de las curvas reales. */
function buildVectorpackResult(
  buf: ArrayBuffer,
  anchor: Anchor,
  progress: ParseProgress
): ParseResult | null {
  const zip = readZip(new Uint8Array(buf));
  if (!zip.ok) return null;

  let shpE: { name: string; data: Uint8Array } | null = null;
  let dbfE: { name: string; data: Uint8Array } | null = null;
  let prjE: { name: string; data: Uint8Array } | null = null;
  let cpgE: { name: string; data: Uint8Array } | null = null;
  let other = 0;
  const slotOf = (e: ZipEntry): 'shp' | 'dbf' | 'prj' | 'cpg' | 'sidecar' | 'other' => {
    const base = (e.name.split('/').pop() ?? e.name).toLowerCase();
    if (base.endsWith('.shp')) return 'shp';
    if (base.endsWith('.dbf')) return 'dbf';
    if (base.endsWith('.prj')) return 'prj';
    if (base.endsWith('.cpg')) return 'cpg';
    if (
      base.endsWith('.shx') ||
      base.endsWith('.qix') ||
      base.endsWith('.sbn') ||
      base.endsWith('.sbx') ||
      base.endsWith('.xml')
    )
      return 'sidecar';
    return 'other';
  };
  const seen = { shp: 0, dbf: 0, prj: 0, cpg: 0 };
  for (const e of zip.entries) {
    const slot = slotOf(e);
    if (slot === 'other') {
      other++;
      continue;
    }
    if (slot === 'sidecar') continue; // índice/estilo: tolerado
    if (seen[slot] > 0) return null; // duplicado ⇒ patrón roto, no es vectorpack limpio
    seen[slot] = 1;
    if (slot === 'shp') shpE = e;
    else if (slot === 'dbf') dbfE = e;
    else if (slot === 'prj') prjE = e;
    else cpgE = e;
  }
  if (!shpE || !dbfE || !prjE || other > 0) return null; // patrón ausente ⇒ cae al Mission Pack

  const base = (shpE.name.split('/').pop() ?? shpE.name).replace(/\.shp$/i, '');
  const kb = (buf.byteLength / 1024).toFixed(1);
  const sidecars = zip.entries.length - 3 - (cpgE ? 1 : 0);

  progress('Shapefile · clasificando .prj', 20);
  const prjText = new TextDecoder('utf-8', { fatal: false }).decode(prjE.data);
  const cls = classifyPrj(prjText);
  if (cls.crs === 'unsupported') {
    throw new Error(
      `CRS del shapefile no soportado en el navegador (${cls.label}) — convertir EX-side: bash scripts/make_roads_vectorpack.sh (EX-vectorial LCC⇒UTM14N, estilo EX-005); jamás reproyección en el navegador`
    );
  }

  progress('Shapefile · SHP/DBF decodificados', 40);
  const dbfUtf8 = cpgE
    ? /utf-?8/i.test(new TextDecoder('utf-8', { fatal: false }).decode(cpgE.data))
    : false;
  const shp = readShp(shpE.data, { verts: MAX_VERTS, segs: MAX_SEGS });
  const dbf = readDbf(dbfE.data, dbfUtf8);
  if (!shp) throw new Error('Shapefile malformado: cabecera o registros SHP ilegibles (rechazo limpio)');
  if (!dbf) throw new Error('Shapefile malformado: DBF ilegible (descriptores o longitudes incoherentes)');
  if (shp.xs.length === 0)
    throw new Error('Shapefile sin vértices renderizables — rechazo limpio (nada inventado)');

  /* --- verificación cruzada LONGITUD (en metros fuente, ANTES de      --- */
  /* --- convertir; el recorte EX acorta ⇒ Δ esperado ≤ 0, honesto)    --- */
  let geomLenM = 0;
  for (let k = 0; k + 1 < shp.segs.length; k += 2) {
    const a = shp.segs[k];
    const b = shp.segs[k + 1];
    geomLenM += Math.hypot(shp.xs[b] - shp.xs[a], shp.ys[b] - shp.ys[a]);
  }
  const longField = dbf.fields.find((f) => /^longitud$/i.test(f.name));
  let attrLenM: number | null = null;
  if (longField) {
    let sum = 0;
    let ok = 0;
    for (const r of dbf.records) {
      const v = r[longField.name];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        ok++;
      }
    }
    if (ok > 0) attrLenM = sum;
  }

  /* --- recuentos por atributo (ADMINISTRA / TIPOVIA) ----------------- */
  const countsRow = (field: string): [string, string] | null => {
    const f = dbf.fields.find((c) => c.name.toLowerCase() === field.toLowerCase());
    if (!f) return null;
    const counts = new Map<string, number>();
    for (const r of dbf.records) {
      const v = r[f.name];
      if (typeof v === 'string' && v.trim() !== '')
        counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    return [
      f.name,
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}×${v}`)
        .join(' · '),
    ];
  };

  /* --- UTM 14N ⇒ WGS84 (converso Snyder FR-1, zona estricta) --------- */
  progress('Convirtiendo UTM 14N → WGS84', 60);
  if (cls.crs === 'utm14n') {
    for (let i = 0; i < shp.xs.length; i++) {
      const c = utm14nToWgs84(shp.xs[i], shp.ys[i]);
      if (!c)
        throw new Error(
          'Vértice fuera de la zona 14N — el .prj declara UTM 14N pero hay coordenadas fuera (rechazo honesto)'
        );
      shp.xs[i] = c[0];
      shp.ys[i] = c[1];
    }
  } else {
    // geográfico declarado: validación de rango estricta
    for (let i = 0; i < shp.xs.length; i++) {
      if (Math.abs(shp.xs[i]) > 180 || Math.abs(shp.ys[i]) > 90)
        throw new Error('Coordenadas geográficas fuera de rango — rechazo honesto');
    }
  }
  let lonMin = Infinity,
    lonMax = -Infinity,
    latMin = Infinity,
    latMax = -Infinity;
  for (let i = 0; i < shp.xs.length; i++) {
    if (shp.xs[i] < lonMin) lonMin = shp.xs[i];
    if (shp.xs[i] > lonMax) lonMax = shp.xs[i];
    if (shp.ys[i] < latMin) latMin = shp.ys[i];
    if (shp.ys[i] > latMax) latMax = shp.ys[i];
  }

  /* --- anclaje escénico (idéntico al canal GeoJSON): metros locales   --- */
  /* --- equirectangulares; z = NaN ⇒ DRAPE-1 drapea sobre el MDT.      --- */
  progress('Anclando al encuadre', 80);
  const D2R = Math.PI / 180;
  const M_PER_DEG_LAT = 110540; // idéntica al canal GeoJSON (parsers/geojson)
  const n = shp.xs.length;
  const mPerLon = 111320 * Math.cos(anchor.centerLat * D2R);
  const maxR = 0.49 * anchor.extentM;
  let outOfExtent = 0;
  for (let i = 0; i < n; i++) {
    const x = (shp.xs[i] - anchor.centerLon) * mPerLon;
    const y = (shp.ys[i] - anchor.centerLat) * M_PER_DEG_LAT;
    if (Math.abs(x) > maxR || Math.abs(y) > maxR) outOfExtent++;
    shp.xs[i] = x;
    shp.ys[i] = y;
  }
  const rescaled = outOfExtent > n * 0.5;
  let verts: Float32Array;
  if (rescaled) {
    // Caja completa al encuadre (mismo fallback del canal GeoJSON)
    verts = normalizeToScene(shp.xs, shp.ys, new Array(n).fill(NaN), anchor);
  } else {
    verts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      verts[i * 3] = shp.xs[i];
      verts[i * 3 + 1] = shp.ys[i];
      verts[i * 3 + 2] = NaN; // sin cota declarada — el drape manda
    }
  }

  /* --- ficha de auditoría -------------------------------------------- */
  const geomKm = geomLenM / 1000;
  const rows: Array<[string, string]> = [
    [
      'Contenedor',
      `ZIP sin manifest · ${zip.entries.length} ${zip.entries.length === 1 ? 'entrada' : 'entradas'} · ${kb} KB · CRC32 por entrada (FR-3)`,
    ],
    [
      'Entregable',
      `1× .shp + .dbf + .prj${cpgE ? ' + .cpg' : ''}${sidecars > 0 ? ` + ${sidecars} sidecar(es)` : ''} · ruta escritorio (patrón topopack)`,
    ],
    ['Origen', `Shapefile ESRI · ${base}`],
    ['CRS (prj)', cls.label],
  ];
  if (cls.crs === 'utm14n')
    rows.push(['Conversión', 'UTM 14N → WGS84 vértice a vértice (Snyder FR-1, converso del repo) — EX-vectorial hace la parte pesada, jamás el navegador']);
  rows.push(
    ['Vértices', n.toLocaleString('es-MX')],
    ['Aristas', (shp.segs.length / 2).toLocaleString('es-MX')],
    ['Puntos', shp.pts.length.toLocaleString('es-MX')],
    ['Registros DBF', `${dbf.records.length.toLocaleString('es-MX')}${dbf.deleted > 0 ? ` (+${dbf.deleted.toLocaleString('es-MX')} borrados, omitidos)` : ''}`],
    ['Atributos', dbf.fields.map((f) => f.name).join(', ').slice(0, 140)],
    [
      'BBox WGS84',
      `lon ${lonMin.toFixed(4)}…${lonMax.toFixed(4)} · lat ${latMin.toFixed(4)}…${latMax.toFixed(4)}`,
    ]
  );
  if (attrLenM !== null) {
    const deltaPct = ((geomLenM - attrLenM) / attrLenM) * 100;
    rows.push([
      'Verificación LONGITUD',
      `Σ aristas geom ${geomKm.toFixed(3)} km vs Σ atributo ${(attrLenM / 1000).toFixed(3)} km · Δ ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)} % (${dbf.records.length.toLocaleString('es-MX')} segmentos${deltaPct < 0 ? ' · recorte EX acorta: el atributo mide el segmento fuente completo' : ''})`,
    ]);
  }
  const adminRow = countsRow('ADMINISTRA');
  if (adminRow) rows.push(adminRow);
  const tipoRow = countsRow('TIPOVIA') ?? countsRow('TIPO_VIAL'); // estatal e11 / RNC 2025
  if (tipoRow) rows.push(tipoRow);
  rows.push(
    ['Anclado a', rescaled ? `${anchor.regionName} (encuadrado)` : anchor.regionName],
    [
      'Drape',
      'sin cota declarada ⇒ z NaN — DRAPE-1 drapea cada vértice sobre el MDT activo (lift 2–3 px): la carretera juzga a las curvas',
    ]
  );
  for (const note of shp.notes) rows.push(['Nota', note]);
  if (dbf.truncated) rows.push(['Nota', dbf.truncated]);

  const meta: IngestMeta = {
    format: 'vectorpack',
    label: `Shapefile en ZIP · ${base}`,
    magicOk: true, /* firma ZIP (CRC por entrada, FR-3) + patrón .shp+.dbf+.prj verificado */
    rows,
    entities: {
      geometrias: Object.values(shp.typeCounts).reduce((s, v) => s + v, 0),
      vertices: n,
      aristas: shp.segs.length / 2,
      puntos: shp.pts.length,
      registros: dbf.records.length,
    },
    crs: cls.label,
  };

  const geom: IngestGeom = {
    verts,
    segs: new Uint32Array(shp.segs),
    pts: new Uint32Array(shp.pts),
  };

  progress('Shapefile listo', 100);
  return { meta, geom };
}

/** Punto de entrada único: detecta y parsea. Lanza Error con mensaje
 *  legible si el formato no se puede procesar. */
export function parseFile(
  name: string,
  buf: ArrayBuffer,
  anchor: Anchor,
  progress: ParseProgress = () => {}
): ParseResult {
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 16));
  const fmt = detectFormat(name, head);
  if (fmt === 'unknown') {
    throw new Error('Formato no reconocido (extensión y firma desconocidas)');
  }
  progress('Detectando formato', 8);
  switch (fmt) {
    case 'geotiff':
    case 'tiff':
      return parseTiff(buf, head);
    case 'geopdf':
      return parsePdf(buf);
    case 'obj': {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      return parseObj(text, progress, anchor);
    }
    case 'dxf': {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      return parseDxf(text, progress, anchor);
    }
    case 'csv': {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      return parseCsv(text, progress, anchor);
    }
    case 'geojson': {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      const r = parseGeoJson(text, anchor, progress);
      if (!r)
        throw new Error(
          'GeoJSON hostil o inválido: rechazo limpio (estructura fracturada, CRS no soportado o coordenadas fuera de rango)'
        );
      return r;
    }
    case 'kml': {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      const r = parseKml(text, anchor, progress);
      if (!r)
        throw new Error(
          'KML hostil o inválido: rechazo limpio (XML fracturado, DTD/entidades prohibidas, geometría no soportada o coordenadas fuera de rango)'
        );
      return r;
    }
    case 'pack': {
      // PUERTO D-1: ZIP sin manifest con par HDR+BIL (± .prj) — el geoid
      // (GGM25) suelto viaja así (patrón hermano del topopack; la custodia
      // del linaje local lo llamaba geoidpack). Un ZIP que no encaje cae
      // al topopack/Mission Pack intacto (null = no es geoidpack).
      const geo = buildGeoidResult(buf, progress);
      if (geo) return geo;
      // Unidad RECORTADOR (transplante inverso): ZIP sin manifest con 1
      // GeoTIFF ± sidecars (.tfwx/.aux.xml/.prj) — el sub-grid de La Soledad
      // viaja así (patrón geoide: preparación con red, campo con pocos MB).
      // La clasificación la decide el CONTENIDO del tif (mono ⇒ DEM real;
      // multibanda ⇒ carta escaneada documental). Un ZIP que no encaje cae
      // al Mission Pack intacto (null = no es topopack).
      const topo = buildTopoResult(buf, progress);
      if (topo) return topo;
      // EX-vectorial (directiva «Agenda §2 ACEPTADA», trace
      // ): ZIP sin manifest con .shp+.dbf+.prj — la capa
      // vectorial de carreteras viaja así (patrón topopack; la parte pesada
      // LCC⇒UTM14N la hace el EX-script, jamás el navegador). Un ZIP que
      // no encaje cae al Mission Pack intacto (null = no es vectorpack);
      // un .prj no soportado (p. ej. LCC) SÍ lanza guía honesta.
      const vec = buildVectorpackResult(buf, anchor, progress);
      if (vec) return vec;
      const r = parseMissionPack(buf, anchor, progress);
      if (!r)
        throw new Error(
          'Mission Pack hostil o inválido: rechazo limpio (ZIP fracturado, ZIP64/cifrado, bomba de descompresión, zip-slip o CRC inconsistente)'
        );
      return r;
    }
    case 'demzip':
    case 'carta': {
      // Ramas de exhaustividad — el patrón se resuelve dentro del caso
      // 'pack' (un dispatcher futuro puede promocionarlo).
      const topo = buildTopoResult(buf, progress);
      if (!topo)
        throw new Error('ZIP de entregable topográfico no reconocido (patrón 1×.tif + sidecars ausente)');
      return topo;
    }
    case 'geoidpack': {
      // Rama de exhaustividad — el patrón se resuelve dentro del caso
      // 'pack' (un dispatcher futuro puede promocionarlo).
      const geo = buildGeoidResult(buf, progress);
      if (!geo)
        throw new Error('ZIP de geoid no reconocido (patrón par HDR+BIL ausente)');
      return geo;
    }
    case 'vectorpack': {
      // Rama de exhaustividad — el patrón se resuelve dentro del caso
      // 'pack' (un dispatcher futuro puede promocionarlo).
      const vec = buildVectorpackResult(buf, anchor, progress);
      if (!vec)
        throw new Error('ZIP de shapefile no reconocido (patrón .shp+.dbf+.prj ausente)');
      return vec;
    }
    case 'blend':
      return parseBlend(buf, head);
    case 'dwg':
      return parseDwg(buf, head);
  }
}
