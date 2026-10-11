/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decodificador GeoTIFF DEM — Motor DEM Real (roadmap 0 GPU, Task 18).
 *
 * Lee los STRIPS de la banda 0 (elevación) de un GeoTIFF local (drag & drop,
 * ya en memoria — sin range requests) y devuelve el raster nativo junto con
 * su transform afín y CRS, listo para reamuestrear sobre el extent de una
 * región. Cero dependencias:
 *
 *   - Compresiones: 1 (sin comprimir), 5 (LZW), 8/32946 (Deflate vía
 *     DecompressionStream nativo del navegador), 32773 (PackBits).
 *   - Tipos de muestra: Uint8/Int8/Uint16/Int16/Uint32/Int32/Float32/Float64
 *     (SampleFormat 1/2/3), little- o big-endian.
 *   - Predictor 1 y 2 (horizontal); Predictor 3 (flotante) y TIFF tiled
 *     (COG) y JPEG se rechazan con mensaje accionable en ficha (EX-005:
 *     guía gdal_translate -co TILED=NO -co COMPRESS=DEFLATE; escape
 *     documentado en F5: geotiff.js como carga perezosa para casos exóticos).
 *
 * Georreferenciación: convención GDAL/esquina — ModelTiepoint apunta a la
 * esquina NO del píxel (0,0) con ModelPixelScale por eje; el centro del
 * píxel (c,r) es tieX+(c+0.5)·sx, tieY−(r+0.5)·sy. La fila 0 es el NORTE.
 *
 * Filosofía 0 GPU: decodificación determinista en CPU (worker), raster
 * nativo sin expandir a Float32 (Int16 de 50 MB sigue siendo 50 MB) y
 * progreso reportable por strips.
 */

/* ------------------------------------------------------------------ */
/* Tipos públicos                                                      */
/* ------------------------------------------------------------------ */

export type DemRaster =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export interface DemCrs {
  /** geographic = grados (alineación lineal local) · utm = EPSG 326xx/327xx
   *  · metric = proyectado en unidades lineales (se asume metro) · unknown */
  kind: 'geographic' | 'utm' | 'metric' | 'unknown';
  epsg?: number;
  utmZone?: number;
  utmSouth?: boolean;
  /** etiqueta legible para fichas/HUD */
  label: string;
}

export interface DecodedDem {
  /** ancho/alto en píxeles */
  w: number;
  h: number;
  /** banda de elevación, fila 0 = norte, índice r*w+c (m s.n.m. o NaN=NODATA) */
  data: DemRaster;
  /** |unidades CRS por píxel| (scaleY > 0; la fila crece hacia el sur) */
  scaleX: number;
  scaleY: number;
  /** esquina NO (centro-exterior del píxel (0,0)) en unidades CRS */
  tieX: number;
  tieY: number;
  crs: DemCrs;
  /** min/max válidos (excluye NODATA) */
  min: number;
  max: number;
  nodata: number | null;
  /** 'Int16' · 'Float32'… */
  sampleLabel: string;
  /** 'sin comprimir' · 'LZW' · 'Deflate' · 'PackBits' */
  compression: string;
  strips: number;
  bytesDecoded: number;
  decodeMs: number;
}

export type DemProgress = (stage: string, pct: number) => void;

/* ------------------------------------------------------------------ */
/* Lectura IFD                                                         */
/* ------------------------------------------------------------------ */

const TIFF_COMPRESSION_NAME: Record<number, string> = {
  1: 'sin comprimir',
  5: 'LZW',
  6: 'JPEG (viejo JPEG-in-TIFF)',
  7: 'JPEG',
  8: 'Deflate',
  32946: 'Deflate',
  32773: 'PackBits',
};

const MAX_PIXELS = 40_000_000; // 50 MB de archivo acota a ~25 M píxeles Int16

interface TiffEntries {
  width: number;
  height: number;
  bits: number[];
  compression: number;
  stripOffsets: number[];
  stripByteCounts: number[];
  rowsPerStrip: number;
  planar: number;
  predictor: number;
  sampleFormat: number[];
  samples: number;
  scale: number[] | null;
  tie: number[] | null;
  geoKeys: number[] | null;
  nodata: number | null;
  transform: number[] | null;
}

function readTiffIfd(buf: ArrayBuffer): { le: boolean; e: TiffEntries } {
  if (buf.byteLength < 8) throw new Error('TIFF truncado o inválido (mínimo 8 bytes)');
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const le = u8[0] === 0x49;
  const magic = dv.getUint16(2, le);
  if (magic !== 42) {
    throw new Error(magic === 43 ? 'BigTIFF no soportado (solo TIFF clásico)' : 'Firma TIFF inválida');
  }

  const readArray = (type: number, count: number, off: number): number[] | null => {
    try {
      const a: number[] = [];
      switch (type) {
        case 1: // BYTE
        case 6: // SBYTE (se lee sin signo; no se usa para tags clave)
          for (let i = 0; i < count; i++) a.push(dv.getUint8(off + i));
          break;
        case 3: // SHORT
          for (let i = 0; i < count; i++) a.push(dv.getUint16(off + i * 2, le));
          break;
        case 4: // LONG
          for (let i = 0; i < count; i++) a.push(dv.getUint32(off + i * 4, le));
          break;
        case 8: // SSHORT
          for (let i = 0; i < count; i++) a.push(dv.getInt16(off + i * 2, le));
          break;
        case 9: // SLONG
          for (let i = 0; i < count; i++) a.push(dv.getInt32(off + i * 4, le));
          break;
        case 11: // FLOAT
          for (let i = 0; i < count; i++) a.push(dv.getFloat32(off + i * 4, le));
          break;
        case 12: // DOUBLE
          for (let i = 0; i < count; i++) a.push(dv.getFloat64(off + i * 8, le));
          break;
        default:
          return null;
      }
      return a;
    } catch {
      return null;
    }
  };

  const e: TiffEntries = {
    width: 0,
    height: 0,
    bits: [],
    compression: 1,
    stripOffsets: [],
    stripByteCounts: [],
    rowsPerStrip: 0,
    planar: 1,
    predictor: 1,
    sampleFormat: [],
    samples: 1,
    scale: null,
    tie: null,
    geoKeys: null,
    nodata: null,
    transform: null,
  };

  let ifdOff = dv.getUint32(4, le);
  if (ifdOff <= 0 || ifdOff >= buf.byteLength) throw new Error('IFD fuera de rango');
  const nEntries = dv.getUint16(ifdOff, le);
  for (let i = 0; i < nEntries; i++) {
    const base = ifdOff + 2 + i * 12;
    if (base + 12 > buf.byteLength) break;
    const tag = dv.getUint16(base, le);
    const type = dv.getUint16(base + 2, le);
    const count = dv.getUint32(base + 4, le);
    if (count > 65536) continue;
    const byteLen = count * (type === 1 || type === 2 || type === 6 ? 1 : type === 3 || type === 8 ? 2 : type === 4 || type === 9 || type === 11 ? 4 : type === 12 ? 8 : 1);
    const off = byteLen <= 4 ? base + 8 : dv.getUint32(base + 8, le);
    const vals = byteLen > 0 ? readArray(type, count, off) : null;
    switch (tag) {
      case 256: if (vals?.length) e.width = vals[0]; break;
      case 257: if (vals?.length) e.height = vals[0]; break;
      case 258: if (vals) e.bits = vals; break;
      case 259: if (vals?.length) e.compression = vals[0]; break;
      case 273: if (vals) e.stripOffsets = vals; break;
      case 277: if (vals?.length) e.samples = vals[0]; break;
      case 278: if (vals?.length) e.rowsPerStrip = vals[0]; break;
      case 279: if (vals) e.stripByteCounts = vals; break;
      case 284: if (vals?.length) e.planar = vals[0]; break;
      case 317: if (vals?.length) e.predictor = vals[0]; break;
      case 339: if (vals) e.sampleFormat = vals; break;
      case 33550: if (vals && vals.length >= 2) e.scale = vals; break;
      case 33922: if (vals && vals.length >= 6) e.tie = vals; break;
      case 34264: if (vals && vals.length >= 16) e.transform = vals; break;
      case 34735: if (vals) e.geoKeys = vals; break;
      case 42113: {
        // GDAL_NODATA (ASCII): acepta '-9999' / '-3.4e+38' / 'nan'
        try {
          const raw = new TextDecoder().decode(new Uint8Array(buf, off, Math.min(count, 64)));
          const t = raw.trim().toLowerCase();
          if (t === 'nan') e.nodata = NaN;
          else {
            const v = parseFloat(t);
            if (Number.isFinite(v)) e.nodata = v;
          }
        } catch { /* sin NODATA */ }
        break;
      }
    }
  }
  return { le, e };
}

/* ------------------------------------------------------------------ */
/* Decodificadores de compresión                                       */
/* ------------------------------------------------------------------ */

/** Infla un strip zlib (o raw como fallback) con DecompressionStream nativo. */
async function inflateStrip(bytes: Uint8Array): Promise<Uint8Array> {
  const tryInflate = async (fmt: 'deflate' | 'deflate-raw'): Promise<Uint8Array> => {
    const ds = new DecompressionStream(fmt);
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await tryInflate('deflate');
  } catch {
    return await tryInflate('deflate-raw');
  }
}

/** LZW variante TIFF (early change: +1 bit al llegar a 511/1023/2047).
 *  Exportada para diagnóstico de round-trip (scripts de QA). */
export function lzwDecodeTiff(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let op = 0;
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);

  let acc = 0;
  let bits = 0;
  let pos = 0;
  let codeBits = 9;
  let next = 258;
  let prev = -1;

  const readCode = (): number => {
    while (bits < codeBits) {
      if (pos >= src.length) return 257;
      acc = (acc << 8) | src[pos++];
      bits += 8;
    }
    const code = (acc >> (bits - codeBits)) & ((1 << codeBits) - 1);
    bits -= codeBits;
    return code;
  };

  /**
   * Emite la cadena del código; devuelve su primer byte.
   * Guard anti-ciclo (G-1/F10, 2026-09-26): un stream corrupto puede crear
   * una entrada auto-referente (prefix[c] === c) y colgar el decodificador;
   * toda cadena LZW válida desciende estrictamente y cabe en la tabla.
   */
  const emit = (code: number): number => {
    let n = 0;
    let c = code;
    while (c >= 258) {
      stack[n++] = suffix[c];
      c = prefix[c];
      if (c < 0) return -1; // tabla corrupta
      if (n >= 4096) return -1; // ciclo ⇒ stream corrupto
    }
    stack[n++] = c & 0xff;
    for (let i = n - 1; i >= 0 && op < out.length; i--) out[op++] = stack[i];
    return stack[n - 1];
  };

  while (op < out.length) {
    const code = readCode();
    if (code === 257) break;
    if (code === 256) {
      prefix.fill(-1);
      next = 258;
      codeBits = 9;
      prev = -1;
      continue;
    }
    if (prev < 0) {
      // Primer código tras Clear: SIEMPRE es un literal/entrada definida
      // (code < next). code === next aquí es imposible en un stream válido
      // y crearía prev indefinido ⇒ la siguiente entrada sería auto-referente
      // (prefix[next] === next) y emit() ciclaría infinitamente (F10/G-1).
      if (code >= next) break;
      emit(code);
      prev = code;
      continue;
    }
    let first: number;
    if (code < next) {
      first = emit(code);
    } else if (code === next) {
      // KwKwK: cadena = cadena(prev) + primer byte de cadena(prev)
      const fb = emit(prev);
      if (fb < 0) break;
      if (op < out.length) out[op++] = fb; // el byte repetido que el emit omitió
      first = fb;
    } else {
      break; // código fuera de tabla: stream corrupto
    }
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next += 1;
      if (next === 511 || next === 1023 || next === 2047) codeBits += 1;
    }
    prev = code;
  }
  return out.subarray(0, op);
}

/** PackBits (Apple RLE) — común en exportaciones GIS antiguas. */
function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let ip = 0;
  let op = 0;
  while (ip < src.length && op < out.length) {
    const b = src[ip++] << 24 >> 24; // int8
    if (b >= 0) {
      const n = b + 1;
      for (let i = 0; i < n && op < out.length && ip < src.length; i++) out[op++] = src[ip++];
    } else if (b !== -128) {
      const n = 1 - b;
      const v = ip < src.length ? src[ip++] : 0;
      for (let i = 0; i < n && op < out.length; i++) out[op++] = v;
    } // -128: no-op
  }
  return out.subarray(0, op);
}

/* ------------------------------------------------------------------ */
/* Raster: bytes → typed array + predictor + NODATA                    */
/* ------------------------------------------------------------------ */

function sampleLabelOf(bits: number, format: number): string {
  const sign = format === 2 ? 'Int' : format === 3 ? 'Float' : 'Uint';
  return `${sign}${bits}`;
}

function bytesToRaster(
  bytes: Uint8Array,
  bits: number,
  format: number,
  le: boolean
): DemRaster {
  const n = bytes.length / (bits / 8);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const swap16 = (): Uint16Array => {
    const a = new Uint16Array(n);
    for (let i = 0; i < n; i++) a[i] = dv.getUint16(i * 2, le);
    return a;
  };
  const swap32 = (): Uint32Array => {
    const a = new Uint32Array(n);
    for (let i = 0; i < n; i++) a[i] = dv.getUint32(i * 4, le);
    return a;
  };
  if (bits === 8) return format === 2 ? new Int8Array(bytes.buffer, bytes.byteOffset, n).slice() : new Uint8Array(bytes.buffer, bytes.byteOffset, n).slice();
  if (bits === 16) {
    if (le) return format === 2 ? new Int16Array(bytes.buffer, bytes.byteOffset, n).slice() : new Uint16Array(bytes.buffer, bytes.byteOffset, n).slice();
    const u = swap16();
    return format === 2 ? new Int16Array(u.buffer) : u;
  }
  if (bits === 32) {
    if (format === 3) {
      if (le) return new Float32Array(bytes.buffer, bytes.byteOffset, n).slice();
      const u = swap32();
      return new Float32Array(u.buffer);
    }
    if (le) return format === 2 ? new Int32Array(bytes.buffer, bytes.byteOffset, n).slice() : new Uint32Array(bytes.buffer, bytes.byteOffset, n).slice();
    const u = swap32();
    return format === 2 ? new Int32Array(u.buffer) : u;
  }
  if (bits === 64 && format === 3) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = dv.getFloat64(i * 8, le);
    return a;
  }
  throw new Error(`Tipo de muestra no soportado: ${bits} bits / formato ${format}`);
}

/** Predictor 2 (horizontal differencing) por fila, banda única. */
function undoPredictor2(data: DemRaster, w: number, h: number): void {
  for (let r = 0; r < h; r++) {
    const base = r * w;
    for (let c = 1; c < w; c++) data[base + c] = (data[base + c] as number) + (data[base + c - 1] as number);
  }
}

/* ------------------------------------------------------------------ */
/* CRS desde GeoKeys                                                   */
/* ------------------------------------------------------------------ */

function crsFromGeoKeys(keys: number[] | null, hasGeoRef: boolean): DemCrs {
  if (!keys || keys.length < 4) {
    return { kind: hasGeoRef ? 'metric' : 'unknown', label: hasGeoRef ? 'proyectado (EPSG no declarado)' : 'sin georreferenciar' };
  }
  let modelType = 0;
  let epsgGeo = 0;
  let epsgProj = 0;
  for (let i = 4; i + 3 < keys.length; i += 4) {
    const key = keys[i];
    const val = keys[i + 3];
    if (key === 1024) modelType = val;
    else if (key === 2048) epsgGeo = val;
    else if (key === 3072) epsgProj = val;
  }
  if (epsgProj >= 32601 && epsgProj <= 32660) {
    return { kind: 'utm', epsg: epsgProj, utmZone: epsgProj - 32600, utmSouth: false, label: `EPSG:${epsgProj} · UTM ${epsgProj - 32600}N` };
  }
  if (epsgProj >= 32701 && epsgProj <= 32760) {
    return { kind: 'utm', epsg: epsgProj, utmZone: epsgProj - 32700, utmSouth: true, label: `EPSG:${epsgProj} · UTM ${epsgProj - 32700}S` };
  }
  if (modelType === 2 || (epsgGeo > 0 && epsgProj === 0)) {
    return { kind: 'geographic', epsg: epsgGeo || 4326, label: `EPSG:${epsgGeo || 4326} · geográfico` };
  }
  if (epsgProj > 0) return { kind: 'metric', epsg: epsgProj, label: `EPSG:${epsgProj} · proyectado (metro asumido)` };
  if (modelType === 1) return { kind: 'metric', label: 'proyectado (EPSG no declarado)' };
  return { kind: 'unknown', label: 'sin georreferenciar' };
}

/* ------------------------------------------------------------------ */
/* Decodificación principal                                            */
/* ------------------------------------------------------------------ */

/**
 * Decodifica la banda 0 (elevación) de un GeoTIFF local.
 * Lanza Error con mensaje accionable si el archivo no es decodificable.
 */
export async function decodeGeoTiffDem(
  buf: ArrayBuffer,
  onProgress?: DemProgress
): Promise<DecodedDem> {
  const t0 = performance.now();
  const { le, e } = readTiffIfd(buf);
  onProgress?.('Cabecera DEM leída', 12);

  if (!e.width || !e.height) throw new Error('Sin dimensiones de imagen');
  if (e.width * e.height > MAX_PIXELS) throw new Error('Raster demasiado grande para decodificar');
  if (e.planar !== 1)
    throw new Error(
      'PlanarConfiguration 2 (bandas por plano) no soportado; convierta a pixel-interleave: gdal_translate -co TILED=NO -co COMPRESS=DEFLATE (EX-005)'
    );
  if (e.samples !== 1) throw new Error(`Multibanda (${e.samples} muestras) no soportado para MDT`);

  const compName = TIFF_COMPRESSION_NAME[e.compression];
  if (!compName) throw new Error(`Compresión TIFF ${e.compression} no soportada (None/LZW/Deflate/PackBits)`);
  // EX-005 : mensaje accionable — el JPEG es la compresión típica de los COG;
  // el beneficiario recibe el comando de conversión exacto en la ficha.
  if (e.compression === 6 || e.compression === 7) {
    throw new Error('JPEG no soportado (típico de COG); convierta a strips Deflate: gdal_translate -co TILED=NO -co COMPRESS=DEFLATE');
  }
  if (e.predictor === 3) throw new Error('Predictor 3 (flotante) no soportado — exporta con predictor 1 o 2');
  if (e.predictor !== 1 && e.predictor !== 2) throw new Error(`Predictor ${e.predictor} desconocido`);

  const bits = e.bits[0] ?? 0;
  const format = e.sampleFormat[0] ?? 1;
  if (!e.bits.includes(bits) || bits === 0) throw new Error('BitsPerSample ausente');
  if (![8, 16, 32, 64].includes(bits)) throw new Error(`${bits} bits no soportado (8/16/32/64)`);
  if (bits === 64 && format !== 3) throw new Error('64 bits solo con SampleFormat float');
  if (format === 0) throw new Error('SampleFormat inválido');

  // Transform afín: tiepoint+scale, con fallback a ModelTransformation
  let scaleX = 0;
  let scaleY = 0;
  let tieX = 0;
  let tieY = 0;
  if (e.scale && e.scale.length >= 2 && e.tie && e.tie.length >= 6) {
    scaleX = Math.abs(e.scale[0]);
    scaleY = Math.abs(e.scale[1]);
    // tiepoint GDAL: raster (0,0) → esquina NO del píxel (0,0)
    tieX = e.tie[3];
    tieY = e.tie[4];
  } else if (e.transform) {
    // ModelTransformation (matriz 4×4, sin rotación soportada)
    const m = e.transform;
    if (Math.abs(m[1]) > 1e-12 || Math.abs(m[4]) > 1e-12) {
      throw new Error('ModelTransformation con rotación no soportado');
    }
    scaleX = Math.abs(m[0]);
    scaleY = Math.abs(m[5]);
    tieX = m[3] + m[0] * 0.5;
    tieY = m[7] - Math.abs(m[5]) * 0.5;
  }
  if (!(scaleX > 0) || !(scaleY > 0)) throw new Error('Sin georreferenciación (PixelScale/Tiepoint/Transform)');

  if (e.stripOffsets.length === 0 || e.stripByteCounts.length === 0) {
    throw new Error('TIFF tiled (COG) no soportado; convierta a strips: gdal_translate -co TILED=NO -co COMPRESS=DEFLATE');
  }

  const rps = e.rowsPerStrip > 0 ? e.rowsPerStrip : e.height;
  const stripRows: number[] = [];
  for (let r = 0; r < e.height; r += rps) stripRows.push(Math.min(rps, e.height - r));
  const nStrips = stripRows.length;
  if (nStrips !== e.stripOffsets.length || nStrips !== e.stripByteCounts.length) {
    throw new Error(`Índices de strips inconsistentes (${nStrips} esperados)`);
  }

  const w = e.width;
  const h = e.height;
  const pxBytes = bits / 8;

  // Decodifica strips → raster tipado completo
  let bytesDecoded = 0;
  let raster: DemRaster | null = null;
  const rowBufs: Uint8Array[] = [];

  for (let s = 0; s < nStrips; s++) {
    const off = e.stripOffsets[s];
    const cnt = e.stripByteCounts[s];
    if (off < 0 || cnt < 0 || off + cnt > buf.byteLength) throw new Error('Strip fuera de rango');
    let bytes: Uint8Array;
    if (e.compression === 1) {
      bytes = new Uint8Array(buf, off, cnt);
    } else if (e.compression === 5) {
      bytes = lzwDecodeTiff(new Uint8Array(buf, off, cnt), stripRows[s] * w * pxBytes);
    } else if (e.compression === 32773) {
      bytes = packBitsDecode(new Uint8Array(buf, off, cnt), stripRows[s] * w * pxBytes);
    } else {
      bytes = await inflateStrip(new Uint8Array(buf, off, cnt));
      if (bytes.length < stripRows[s] * w * pxBytes) {
        throw new Error('Strip Deflate incompleto (archivo corrupto)');
      }
    }
    rowBufs.push(bytes);
    bytesDecoded += cnt;
    if (s % 16 === 0 || s === nStrips - 1) {
      onProgress?.(`Decodificando elevación (strip ${s + 1}/${nStrips})`, 15 + Math.round((s / nStrips) * 40));
    }
  }

  // Construye el raster nativo fila por fila (los strips pueden no ser contiguos)
  if (e.compression === 1 && rps >= h && nStrips === 1) {
    // atajo: sin comprimir completo y alineado (Bundle A #7: el strip DEBE cubrir w×h)
    if (rowBufs[0].length !== stripRows[0] * w * pxBytes) {
      throw new Error('Strip sin comprimir incompleto (archivo corrupto)');
    }
    raster = bytesToRaster(rowBufs[0], bits, format === 0 ? 1 : format, le);
  } else {
    // raster intermedio en bytes crudos (endianness aplicada por strip)
    const tmp = bytesToRaster(rowBufs[0], bits, format === 0 ? 1 : format, le);
    const Ctor = tmp.constructor as new (n: number) => DemRaster;
    raster = new Ctor(w * h);
    for (let s = 0; s < nStrips; s++) {
      const part = bytesToRaster(rowBufs[s], bits, format === 0 ? 1 : format, le);
      (raster as Float64Array).set(part, stripRows.slice(0, s).reduce((a, b) => a + b, 0) * w);
    }
  }

  if (e.predictor === 2) {
    if (format === 3 && bits >= 32) throw new Error('Predictor 2 sobre float no soportado');
    undoPredictor2(raster, w, h);
  }

  // NODATA → NaN (solo si el raster es float; en enteros se marcan aparte)
  const nodata = e.nodata;
  let min = Infinity;
  let max = -Infinity;
  let nodataCount = 0;
  for (let i = 0; i < raster.length; i++) {
    const v = raster[i] as number;
    if (nodata !== null && (v === nodata || (Number.isNaN(nodata) && Number.isNaN(v)))) {
      nodataCount++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('Sin valores de elevación válidos (¿todo NODATA?)');

  const crs = crsFromGeoKeys(e.geoKeys, true);
  onProgress?.('Raster DEM listo', 58);

  return {
    w,
    h,
    data: raster,
    scaleX,
    scaleY,
    tieX,
    tieY,
    crs,
    min,
    max,
    nodata,
    sampleLabel: sampleLabelOf(bits, format === 0 ? 1 : format),
    compression: compName,
    strips: nStrips,
    bytesDecoded,
    decodeMs: performance.now() - t0,
  };
}

/* ------------------------------------------------------------------ */
/* Decodificación SYNC para campos de fricción en Mission Pack (FR-5) */
/* ------------------------------------------------------------------ */

/**
 * FR-5 · D12: decodificación SÍNCRONA de la banda 0 — para miembros
 * FRICTION* de un Mission Pack (parseMissionPack es síncrono por contrato).
 * Soporta compresión 1 (None) / 5 (LZW) / 32773 (PackBits), Predictor 1/2,
 * SampleFormat 1/2/3 y ambos endianness. Deflate/COG/JPEG ⇒ Error honesto
 * con el comando de conversión (el camino asíncrono del worker sí cubre
 * Deflate para archivos sueltos).
 */
export function decodeGeoTiffFieldSync(buf: ArrayBuffer): DecodedDem {
  const t0 = performance.now();
  const { le, e } = readTiffIfd(buf);
  if (!e.width || !e.height) throw new Error('Sin dimensiones de imagen');
  if (e.width * e.height > MAX_PIXELS) throw new Error('Raster demasiado grande para decodificar');
  if (e.planar !== 1) throw new Error('PlanarConfiguration 2 no soportado');
  if (e.samples !== 1) throw new Error(`Multibanda (${e.samples} muestras) no soportado`);
  const compName = TIFF_COMPRESSION_NAME[e.compression];
  if (e.compression !== 1 && e.compression !== 5 && e.compression !== 32773) {
    throw new Error(
      `Compresión TIFF ${e.compression} (${compName ?? 'desconocida'}) no decodificable en el pack (síncrono) — convierta el campo: gdal_translate -co TILED=NO -co COMPRESS=LZW`
    );
  }
  if (e.predictor !== 1 && e.predictor !== 2) throw new Error(`Predictor ${e.predictor} no soportado`);
  const bits = e.bits[0] ?? 0;
  const format = e.sampleFormat[0] ?? 1;
  if (!e.bits.includes(bits) || bits === 0) throw new Error('BitsPerSample ausente');
  if (![8, 16, 32, 64].includes(bits)) throw new Error(`${bits} bits no soportado (8/16/32/64)`);
  if (bits === 64 && format !== 3) throw new Error('64 bits solo con SampleFormat float');

  let scaleX = 0, scaleY = 0, tieX = 0, tieY = 0;
  if (e.scale && e.scale.length >= 2 && e.tie && e.tie.length >= 6) {
    scaleX = Math.abs(e.scale[0]);
    scaleY = Math.abs(e.scale[1]);
    tieX = e.tie[3];
    tieY = e.tie[4];
  } else if (e.transform) {
    const m = e.transform;
    if (Math.abs(m[1]) > 1e-12 || Math.abs(m[4]) > 1e-12) throw new Error('ModelTransformation con rotación no soportado');
    scaleX = Math.abs(m[0]);
    scaleY = Math.abs(m[5]);
    tieX = m[3] + m[0] * 0.5;
    tieY = m[7] - Math.abs(m[5]) * 0.5;
  }
  if (!(scaleX > 0) || !(scaleY > 0)) throw new Error('Sin georreferenciación (PixelScale/Tiepoint/Transform)');
  if (e.stripOffsets.length === 0 || e.stripByteCounts.length === 0) throw new Error('TIFF tiled (COG) no soportado');

  const w = e.width;
  const h = e.height;
  const rps = e.rowsPerStrip > 0 ? e.rowsPerStrip : h;
  const stripRows: number[] = [];
  for (let r = 0; r < h; r += rps) stripRows.push(Math.min(rps, h - r));
  if (stripRows.length !== e.stripOffsets.length || stripRows.length !== e.stripByteCounts.length) {
    throw new Error('Índices de strips inconsistentes');
  }
  const pxBytes = bits / 8;
  const rowBufs: Uint8Array[] = [];
  for (let s = 0; s < stripRows.length; s++) {
    const off = e.stripOffsets[s];
    const cnt = e.stripByteCounts[s];
    if (off < 0 || cnt < 0 || off + cnt > buf.byteLength) throw new Error('Strip fuera de rango');
    if (e.compression === 1) rowBufs.push(new Uint8Array(buf, off, cnt));
    else if (e.compression === 5) rowBufs.push(lzwDecodeTiff(new Uint8Array(buf, off, cnt), stripRows[s] * w * pxBytes));
    else rowBufs.push(packBitsDecode(new Uint8Array(buf, off, cnt), stripRows[s] * w * pxBytes));
  }
  const first = bytesToRaster(rowBufs[0], bits, format === 0 ? 1 : format, le);
  let raster: DemRaster;
  if (e.compression === 1 && rps >= h && stripRows.length === 1) {
    if (rowBufs[0].length !== stripRows[0] * w * pxBytes) throw new Error('Strip sin comprimir incompleto');
    raster = first;
  } else {
    const Ctor = first.constructor as new (n: number) => DemRaster;
    raster = new Ctor(w * h);
    for (let s = 0; s < stripRows.length; s++) {
      const part = bytesToRaster(rowBufs[s], bits, format === 0 ? 1 : format, le);
      (raster as Float64Array).set(part, stripRows.slice(0, s).reduce((a, b) => a + b, 0) * w);
    }
  }
  if (e.predictor === 2) {
    if (format === 3 && bits >= 32) throw new Error('Predictor 2 sobre float no soportado');
    undoPredictor2(raster, w, h);
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raster.length; i++) {
    const v = raster[i] as number;
    if (e.nodata !== null && (v === e.nodata || (Number.isNaN(e.nodata) && Number.isNaN(v)))) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('Sin valores válidos (¿todo NODATA?)');
  return {
    w,
    h,
    data: raster,
    scaleX,
    scaleY,
    tieX,
    tieY,
    crs: crsFromGeoKeys(e.geoKeys, true),
    min,
    max,
    nodata: e.nodata,
    sampleLabel: sampleLabelOf(bits, format === 0 ? 1 : format),
    compression: compName,
    strips: stripRows.length,
    bytesDecoded: buf.byteLength,
    decodeMs: performance.now() - t0,
  };
}

/* ------------------------------------------------------------------ */
/* Muestreo bilineal puntual (la esencia de sampleElevation, O(1))     */
/* ------------------------------------------------------------------ */

/**
 * Elevación en (lon, lat) WGS-84 por interpolación bilineal sobre el raster
 * decodificado — equivalente CPU-local de la propuesta geotiff.js, pero sin
 * I/O: cada consulta proviene de bytes ya leídos del GeoTIFF.
 * Devuelve NaN fuera de cobertura o en NODATA.
 */
export function sampleDemElevation(dem: DecodedDem, lon: number, lat: number): number {
  if (dem.crs.kind !== 'geographic') return NaN; // solo geográfico es directo
  // centro del píxel: tieX + (c + 0.5)·sx ; tieY − (r + 0.5)·sy
  const xf = (lon - dem.tieX) / dem.scaleX - 0.5;
  const yf = (dem.tieY - lat) / dem.scaleY - 0.5;
  const i = Math.floor(xf);
  const j = Math.floor(yf);
  if (i < 0 || j < 0 || i >= dem.w - 1 || j >= dem.h - 1) return NaN;
  const fx = xf - i;
  const fy = yf - j;
  const d = dem.data;
  const v00 = d[j * dem.w + i] as number;
  const v10 = d[j * dem.w + i + 1] as number;
  const v01 = d[(j + 1) * dem.w + i] as number;
  const v11 = d[(j + 1) * dem.w + i + 1] as number;
  if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) return NaN;
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}
