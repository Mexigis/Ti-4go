/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ruta escritorio del ENTREGABLE TOPOGRÁFICO — ZIP sin manifest con un
 * GeoTIFF ± sidecars (unidad RECORTADOR · patrón hermano del geoide
 * nacional GGM25, GPS-ORTO).
 *
 * El dispatcher del caso 'pack' prueba este patrón ANTES del Mission Pack
 * (igual que geoidpack.ts con el .bil+.hdr). Un ZIP que no encaje cae al
 * Mission Pack intacto; la CLASIFICACIÓN la decide el CONTENIDO del .tif,
 * jamás el nombre del archivo:
 *
 *   - mono (1 muestra · 8/16/32/64 bits · SampleFormat int/float)
 *       ⇒ 'demzip'  ·  Motor DEM Real: el worker decodifica los strips de
 *         elevación y el raster entra al re-muestreo del terreno. Es la
 *         forma del sub-grid que produce el RECORTADOR (gdal_translate
 *         -co TILED=NO -co COMPRESS=DEFLATE, guía EX-005 de geotiff-dem):
 *         preparación con red, campo con pocos MB.
 *   - multibanda visual (≥2 muestras, p. ej. 8 bits × 3 RGB)
 *       ⇒ 'carta'   ·  Carta topográfica ESCANEADA (p. ej. hoja INEGI
 *         F14C43-D): raster DOCUMENTAL — sin banda de elevación, NO es
 *         MDT; el motor de curvas 0 GPU no la drapea (nada inventado) y
 *         la ficha lo declara. La georreferencia efectiva vive en el
 *         sidecar .tfwx (afín con rotación) y en el xform polinomial
 *         Esri del .aux.xml (GCPs) — se REPORTAN como metadatos; jamás
 *         se aplica una georreferencia que el TIFF no lleva.
 *
 * Zero dependencias: FR-3 (CRC32 por entrada, techo duro, zip-slip y
 * ZIP64 ⇒ rechazo ya los aplica readZip). Hostil (tif sin magic TIFF)
 * ⇒ Error legible, nunca null silencioso.
 */

import { readZip } from './zip';
import { utm14nToWgs84 } from './geojson';

export type TopoKind = 'demzip' | 'carta';

export interface TopoExtract {
  /** nombre base sin extensión, p. ej. «F14C43 d» */
  name: string;
  /** bytes exactos del GeoTIFF (copia propia, transferible) */
  tif: Uint8Array;
  /** sidecars acompañantes (nombres) */
  sidecars: string[];
  /** total de entradas del ZIP */
  entries: number;
  /** tamaño del contenedor ZIP */
  zipBytes: number;
  /** IFD mínimo (probe) para clasificar — null si no se pudo leer */
  bits: number | null;
  samples: number | null;
  sampleFormat: number | null;
  compression: number | null;
  /** .tfwx parseado: [A, D, B, E, C, F] — x' = A·x + B·y + C ; y' = D·x + E·y + F */
  tfwx: number[] | null;
}

const isTifName = (n: string) => /\.(tif|tiff)$/i.test(n);
const SIDE_RE = /\.(tfwx|prj)$/i;

/** Patrón del entregable: exactamente 1 .tif, sidecars de lista blanca
 *  (.tfwx / *.aux.xml / .prj), cero payloads extra. Un manifest.json
 *  presente ⇒ NO es topopack (es un Mission Pack y cae intacto). */
export function looksLikeTopoZip(names: string[]): boolean {
  let tif = 0;
  let other = 0;
  for (const n of names) {
    if (isTifName(n)) tif++;
    else if (n.toLowerCase().endsWith('.aux.xml') || SIDE_RE.test(n)) continue;
    else other++;
  }
  return tif === 1 && other === 0;
}

/** Probe mínimo del IFD0 — solo tags de clasificación (258/277/339/259).
 *  Best-effort: la ficha completa la produce parseTiff en el dispatcher. */
function ifdProbe(
  t: Uint8Array
): { bits: number | null; samples: number | null; sampleFormat: number | null; compression: number | null } {
  const out = { bits: null, samples: null, sampleFormat: null, compression: null } as {
    bits: number | null;
    samples: number | null;
    sampleFormat: number | null;
    compression: number | null;
  };
  try {
    const le = t[0] === 0x49; // 'II'
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    const SZ: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 };
    for (let i = 0; i < n; i++) {
      const b = ifd + 2 + i * 12;
      const tag = dv.getUint16(b, le);
      const type = dv.getUint16(b + 2, le);
      const cnt = dv.getUint32(b + 4, le);
      const sz = (SZ[type] ?? 1) * cnt;
      const off = sz <= 4 ? b + 8 : dv.getUint32(b + 8, le);
      const first = (): number | null => {
        if (type === 3) return dv.getUint16(off, le);
        if (type === 4) return dv.getUint32(off, le);
        return null;
      };
      if (tag === 258) out.bits = first();
      else if (tag === 277) out.samples = first();
      else if (tag === 339) out.sampleFormat = first();
      else if (tag === 259) out.compression = first();
    }
  } catch {
    // probe best-effort: si el IFD está fracturado, la clasificación cae a
    // 'carta' y la ficha completa (parseTiff) declarará el detalle honesto.
  }
  return out;
}

/** Parseo del sidecar .tfwx (6 números, orden ESRI: A D B E C F). */
export function parseTfwx(text: string): number[] | null {
  const nums = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  if (nums.length !== 6 || nums.some((v) => !Number.isFinite(v))) return null;
  return nums;
}

/** Filas de ficha del sidecar .tfwx — georreferencia EXTERNA al TIFF
 *  (se reporta; no se aplica). La esquina NO (C, F) es el borde exterior
 *  del píxel (0,0); si cae en el dominio UTM 14N se traduce a WGS84 con
 *  el converso Snyder FR-1 (mismo estándar del GeoJSON dual). */
export function tfwxRows(tf: number[]): Array<[string, string]> {
  const [A, D, B, E, C, F] = tf;
  const rows: Array<[string, string]> = [];
  const rotX = Math.atan2(B, A);
  const rotY = Math.atan2(-D, -E);
  const rotDeg = (Math.abs(rotX) + Math.abs(rotY)) / 2 / (Math.PI / 180);
  rows.push([
    'Geo-ref (tfwx)',
    `afín EXTERNA: ${Math.abs(A).toFixed(4)} m/px E · ${Math.abs(E).toFixed(4)} m/px N · rot ≈ ${rotDeg.toFixed(2)}°`,
  ]);
  const wgs = utm14nToWgs84(C, F);
  if (wgs) {
    rows.push([
      'Esquina NO (tfwx)',
      `UTM 14N ${C.toFixed(1)} E, ${F.toFixed(1)} N ⇒ ${wgs[0].toFixed(5)}°, ${wgs[1].toFixed(5)}° (WGS84 · Snyder FR-1)`,
    ]);
  } else {
    rows.push(['Esquina NO (tfwx)', `UTM 14N ${C.toFixed(1)} E, ${F.toFixed(1)} N (fuera del dominio del converso)`]);
  }
  return rows;
}

/** Clasificación por CONTENIDO: mono ⇒ DEM (sub-grid del RECORTADOR);
 *  multibanda ⇒ carta escaneada documental. Sin IFD legible ⇒ 'carta'
 *  (lo conservador: nunca fingir una banda de elevación que no se vio). */
export function classifyTopo(ex: Pick<TopoExtract, 'bits' | 'samples' | 'sampleFormat'>): TopoKind {
  if (ex.samples === 1 && ex.bits !== null && (ex.bits === 8 || ex.bits === 16 || ex.bits === 32 || ex.bits === 64)) {
    return 'demzip';
  }
  return 'carta';
}

/** Punto de entrada del dispatcher (parseFile, caso 'pack'). Devuelve
 *  null cuando el ZIP NO es un entregable topográfico (cae al Mission
 *  Pack intacto). Hostil (tif sin magic II·MM) ⇒ Error legible. */
export function extractTopoPack(buf: ArrayBuffer): TopoExtract | null {
  const zip = readZip(new Uint8Array(buf));
  if (!zip.ok) return null; // fracturado: pack.ts lo cataloga con su catálogo

  const names = zip.entries.map((e) => e.name);
  if (!looksLikeTopoZip(names)) return null;

  const tifEntry = zip.entries.find((e) => isTifName(e.name))!;
  const t = tifEntry.data;
  const isTiffMagic =
    (t[0] === 0x49 && t[1] === 0x49 && t[2] === 0x2a && t[3] === 0) ||
    (t[0] === 0x4d && t[1] === 0x4d && t[2] === 0 && t[3] === 0x2a);
  if (!isTiffMagic) {
    throw new Error(
      'ZIP de entregable topográfico hostil o inválido: la entrada .tif no es TIFF (magic II·MM ausente)'
    );
  }

  // copia propia (el buffer del zip es compartido por todas las entradas)
  const tif = t.slice();

  const name = tifEntry.name.replace(/.*\//, '').replace(/\.(tif|tiff)$/i, '').trim() || 'topo';

  // sidecar tfwx (afín externa) si viene
  const tfwxEntry = zip.entries.find((e) => /\.tfwx$/i.test(e.name));
  let tfwx: number[] | null = null;
  if (tfwxEntry) {
    tfwx = parseTfwx(new TextDecoder('utf-8', { fatal: false }).decode(tfwxEntry.data));
  }

  return {
    name,
    tif,
    sidecars: names.filter((n) => !isTifName(n)),
    entries: zip.entries.length,
    zipBytes: buf.byteLength,
    ...ifdProbe(tif),
    tfwx,
  };
}
