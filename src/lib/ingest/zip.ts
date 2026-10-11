/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-3 — Lector ZIP (PKZIP 2.0) 0-dependencias para Mission Packs
 * (agenda FR 1.0 · orden fijo del propietario · checkpoint de ingeniería).
 *
 * Contrato de la agenda:
 *   - Soportado: almacenado (method 0) y Deflate (method 8, RFC 1951 —
 *     descompresor propio, sin zlib). CRC32 por entrada (IEEE 0xEDB88320),
 *     verificado contra el valor del directorio central.
 *   - ZIP64 ⇒ RECHAZO (sentinelas 0xFFFFFFFF/0xFFFF o localizador EOCD64).
 *   - Entrada cifrada ⇒ HOSTIL (bit 0 o bit 6 del general purpose flag).
 *   - Presupuesto DECLARADO antes de inflar: el tamaño sin comprimir del
 *     directorio central se valida contra el tope ANTES de la extracción;
 *     el inflado es por bloques con techo duro — una bomba (declarado o
 *     real) aborta sin asignar más allá del presupuesto.
 *   - HOSTIL ⇒ null, sin excepciones: zip-slip (`../`, ruta absoluta,
 *     letra de unidad, backslash, NUL), bombas, nombres duplicados,
 *     rangos de datos solapados, CRC/tamaños inconsistentes, firma rota,
 *     EOCD ausente, disco multi-archivo, método no soportado.
 *
 * Determinista: mismos bytes ⇒ mismas entradas byte a byte. CPU puro,
 * 0 GPU, sin asignación por debajo de la cuenta declarada.
 */

/* ------------------------------------------------------------------ */
/* CRC32 (IEEE, reflejado)                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC32 IEEE de un rango de bytes (exportado para fixtures y suites). */
export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Presupuestos                                                       */
/* ------------------------------------------------------------------ */

/** Máximo de entradas por pack. */
export const MAX_ZIP_ENTRIES = 512;
/** Tope SIN comprimir por entrada (alineado con el límite de ingesta). */
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
/** Tope SIN comprimir acumulado del pack (defensa de bomba multi-entrada). */
export const MAX_TOTAL_UNCOMPRESSED = 120 * 1024 * 1024;
/** Longitud máxima de nombre de entrada. */
const MAX_NAME_LEN = 512;
/** Bytes de datos sin comprimir por entrada en el primer tramo del muestreo
 *  de CRC incremental — no aplica: el CRC se verifica sobre el buffer final
 *  ya acotado por los presupuestos (sin asignación extra). */

/* ------------------------------------------------------------------ */
/* Descompresor DEFLATE (RFC 1951) — estilo puff, iterativo           */
/* ------------------------------------------------------------------ */

class BitReader {
  pos: number; // byte
  bitBuf = 0;
  bitCnt = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly start: number,
    readonly end: number
  ) {
    this.pos = start;
  }
  /** Lee n bits (LSB primero). Devuelve -1 si no hay datos. */
  bits(need: number): number {
    let val = this.bitBuf;
    while (this.bitCnt < need) {
      if (this.pos >= this.end) return -1;
      val |= this.buf[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    this.bitBuf = val >>> need;
    this.bitCnt -= need;
    return val & ((1 << need) - 1);
  }
  /** Alinea a byte descartando bits residuales. */
  align(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
}

/** Tabla Huffman canónica (decodificación por longitudes, estilo puff). */
class Huffman {
  count = new Uint16Array(16);
  symbol: Uint16Array = new Uint16Array(0);
  /** Construye desde longitudes de código (0 = símbolo ausente). */
  build(lengths: Uint8Array | number[]): boolean {
    this.count.fill(0);
    for (const len of lengths) {
      if (len > 15) return false;
      this.count[len]++;
    }
    if (this.count[0] === lengths.length) return true; // sin códigos (vacío válido en dist)
    // Comprobación de sobre-suscripción (Kraft)
    let left = 1;
    for (let len = 1; len <= 15; len++) {
      left <<= 1;
      left -= this.count[len];
      if (left < 0) return false;
    }
    // Offsets por longitud
    const offs = new Uint16Array(16);
    offs[1] = 0;
    for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + this.count[len];
    this.symbol = new Uint16Array(lengths.length);
    for (let sym = 0; sym < lengths.length; sym++) {
      if (lengths[sym] !== 0) this.symbol[offs[lengths[sym]]++] = sym;
    }
    return true;
  }
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const litHuf = new Huffman();
const distHuf = new Huffman();
const clenHuf = new Huffman();

(function initFixed(): void {
  const lengths: number[] = [];
  for (let i = 0; i < 144; i++) lengths.push(8);
  for (let i = 144; i < 256; i++) lengths.push(9);
  for (let i = 256; i < 280; i++) lengths.push(7);
  for (let i = 280; i < 288; i++) lengths.push(8);
  litHuf.build(lengths);
  distHuf.build(new Array(30).fill(5));
})();

/** Decodifica un símbolo Huffman. Devuelve -1 sin datos, -2 inválido. */
function decodeSym(br: BitReader, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    const b = br.bits(1);
    if (b < 0) return -1;
    code |= b;
    const count = h.count[len];
    if (code - first < count) return h.symbol[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  return -2;
}

/**
 * Infla un stream DEFLATE crudo. `cap` es un techo DURO de salida
 * (presupuesto declarado): aborta con 'overflow' si el stream pretende
 * producir más — la bomba nunca asigna por encima del cap.
 * Devuelve null ante stream inválido/truncado, o {out, ok} donde `out`
 * es la salida real (≤ cap) y `ok` indica stream completo terminado.
 */
export function inflateRaw(
  buf: Uint8Array,
  start: number,
  end: number,
  cap: number
): { out: Uint8Array; complete: boolean; overflow: boolean } | null {
  if (end < start || end > buf.length) return null;
  const br = new BitReader(buf, start, end);
  let out = new Uint8Array(Math.min(cap, 64 * 1024));
  let len = 0;
  const ensure = (add: number): boolean => {
    if (len + add > cap) return false; // presupuesto duro
    if (len + add > out.length) {
      let n = out.length * 2;
      while (n < len + add) n *= 2;
      if (n > cap) n = cap;
      const nu = new Uint8Array(n);
      nu.set(out.subarray(0, len));
      out = nu;
    }
    return true;
  };

  const clens = new Uint8Array(19);
  const llengths = new Uint8Array(288 + 32);

  for (;;) {
    const final = br.bits(1);
    if (final < 0) return null;
    const type = br.bits(2);
    if (type < 0) return null;
    if (type === 0) {
      // Almacenado: alinear + LEN/NLEN
      br.align();
      if (br.pos + 4 > br.end) return null;
      const l = br.buf[br.pos] | (br.buf[br.pos + 1] << 8);
      const nl = br.buf[br.pos + 2] | (br.buf[br.pos + 3] << 8);
      if ((l ^ 0xffff) !== nl) return null; // LEN/NLEN inconsistente
      br.pos += 4;
      if (br.pos + l > br.end) return null; // truncado
      if (!ensure(l)) return { out: out.subarray(0, len), complete: false, overflow: true };
      out.set(br.buf.subarray(br.pos, br.pos + l), len);
      len += l;
      br.pos += l;
    } else if (type === 1 || type === 2) {
      let lh: Huffman, dh: Huffman;
      if (type === 1) {
        lh = litHuf;
        dh = distHuf;
      } else {
        const hlit = br.bits(5);
        const hdist = br.bits(5);
        const hclen = br.bits(4);
        if (hlit < 0 || hdist < 0 || hclen < 0) return null;
        const nlit = hlit + 257;
        const ndist = hdist + 1;
        const nclen = hclen + 4;
        if (nlit > 286 || ndist > 30) return null;
        clens.fill(0);
        for (let i = 0; i < nclen; i++) {
          const b = br.bits(3);
          if (b < 0) return null;
          clens[CLEN_ORDER[i]] = b;
        }
        if (!clenHuf.build(clens)) return null;
        // Longitudes de lit/dist con repeticiones 16/17/18
        let idx = 0;
        while (idx < nlit + ndist) {
          const sym = decodeSym(br, clenHuf);
          if (sym < 0) return null;
          if (sym < 16) {
            llengths[idx++] = sym;
          } else {
            let rep = 0;
            let val = 0;
            if (sym === 16) {
              if (idx === 0) return null;
              val = llengths[idx - 1];
              rep = 3 + br.bits(2);
              if (rep < 0) return null;
            } else if (sym === 17) {
              rep = 3 + br.bits(3);
              if (rep < 0) return null;
            } else {
              rep = 11 + br.bits(7);
              if (rep < 0) return null;
            }
            if (idx + rep > nlit + ndist) return null;
            while (rep-- > 0) llengths[idx++] = val;
          }
        }
        if (llengths[256] === 0) return null; // sin código de fin-de-bloque
        if (!lh_build(llengths, nlit, ndist)) return null;
        lh = tmpLit;
        dh = tmpDist;
      }
      // Bloque Huffman
      for (;;) {
        const sym = decodeSym(br, lh);
        if (sym < 0) return null;
        if (sym < 256) {
          if (!ensure(1)) return { out: out.subarray(0, len), complete: false, overflow: true };
          out[len++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= LEN_BASE.length) return null; // 286/287 inválidos
          const lb = br.bits(LEN_EXTRA[li]);
          if (lb < 0) return null;
          const length = LEN_BASE[li] + lb;
          const ds = decodeSym(br, dh);
          if (ds < 0 || ds >= DIST_BASE.length) return null;
          const db = br.bits(DIST_EXTRA[ds]);
          if (db < 0) return null;
          const dist = DIST_BASE[ds] + db;
          if (dist > len) return null; // referencia antes del inicio
          if (!ensure(length)) return { out: out.subarray(0, len), complete: false, overflow: true };
          let from = len - dist;
          for (let i = 0; i < length; i++) out[len++] = out[from++];
        }
      }
    } else {
      return null; // tipo de bloque 11 inválido
    }
    if (final === 1) break;
  }
  return { out: out.subarray(0, len), complete: true, overflow: false };

  // --- construcción temporal para bloques dinámicos ---
  function lh_build(lengths: Uint8Array, nlit: number, ndist: number): boolean {
    if (!tmpLit.build(lengths.subarray(0, nlit))) return false;
    if (!tmpDist.build(lengths.subarray(nlit, nlit + ndist))) return false;
    return true;
  }
}
let tmpLit = new Huffman();
let tmpDist = new Huffman();

/* ------------------------------------------------------------------ */
/* Lector ZIP                                                         */
/* ------------------------------------------------------------------ */

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number; // valor del directorio central
  compressedSize: number;
  uncompressedSize: number;
  /** Datos verificados (CRC + tamaño) ya descomprimidos. */
  data: Uint8Array;
}

type Read =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; reason: string };

function u16(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8);
}
function u32(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;

/** Nombre de entrada legítimo: sin zip-slip ni controles. */
function safeName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LEN) return false;
  if (name.includes('\u0000')) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false; // absoluta
  if (/^[a-zA-Z]:/.test(name)) return false; // letra de unidad
  const parts = name.split(/[\\/]/);
  for (const p of parts) if (p === '..') return false; // traversal
  return true;
}

function decodeName(bytes: Uint8Array, start: number, len: number, utf8: boolean): string {
  if (utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + len));
    } catch {
      return ''; // UTF-8 declarado inválido ⇒ nombre vacío ⇒ hostil
    }
  }
  // CP437 aproximado a ASCII imprimible (resto ⇒ reemplazo — nombres de
  // campo real son ASCII; se rechaza control/NUL en safeName).
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[start + i];
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '\uFFFD';
  }
  return s;
}

/**
 * Punto de entrada: lee y verifica TODO el archivo ZIP. Cualquier
 * hostilidad ⇒ { ok:false, reason } con causa legible (la bitácora
 * registra la causa; el parser la convierte en rechazo limpio).
 */
export function readZip(bytes: Uint8Array): Read {
  const n = bytes.length;
  if (n < 22) return { ok: false, reason: 'archivo demasiado corto para EOCD' };

  // Localizador ZIP64 en la cola ⇒ rechazo (contrato: ZIP64 ⇒ rechazo)
  const tailStart = Math.max(0, n - 66_000);
  for (let p = n - 4; p >= tailStart; p--) {
    if (u32(bytes, p) === SIG_EOCD64_LOC) {
      return { ok: false, reason: 'ZIP64 (localizador EOCD64) — no soportado por contrato' };
    }
  }

  // EOCD: escaneo hacia atrás en la cola
  let eocd = -1;
  for (let p = n - 22; p >= tailStart; p--) {
    if (u32(bytes, p) === SIG_EOCD) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return { ok: false, reason: 'EOCD ausente (archivo truncado o no es ZIP)' };

  const diskNo = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const entriesThisDisk = u16(bytes, eocd + 8);
  const entriesTotal = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  const commentLen = u16(bytes, eocd + 20);

  if (diskNo !== 0 || cdDisk !== 0 || entriesThisDisk !== entriesTotal) {
    return { ok: false, reason: 'multi-disco o conteo inconsistente entre discos' };
  }
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, reason: 'sentinelas ZIP64 en EOCD — no soportado por contrato' };
  }
  if (entriesTotal > MAX_ZIP_ENTRIES) {
    return { ok: false, reason: `demasiadas entradas (${entriesTotal} > ${MAX_ZIP_ENTRIES})` };
  }
  if (eocd + 22 + commentLen > n) {
    return { ok: false, reason: 'longitud de comentario EOCD excede el archivo' };
  }
  if (cdOffset + cdSize > eocd || cdSize > n) {
    return { ok: false, reason: 'directorio central fuera de los límites del archivo' };
  }

  // Directorio central
  interface CdRow {
    name: string;
    rawName: Uint8Array;
    flags: number;
    method: number;
    crc: number;
    compSize: number;
    uncompSize: number;
    localOffset: number;
  }
  const cd: CdRow[] = [];
  {
    let p = cdOffset;
    for (let e = 0; e < entriesTotal; e++) {
      if (p + 46 > n || u32(bytes, p) !== SIG_CD) {
        return { ok: false, reason: `directorio central roto en la entrada ${e}` };
      }
      const flags = u16(bytes, p + 8);
      const method = u16(bytes, p + 10);
      const crc = u32(bytes, p + 16);
      const compSize = u32(bytes, p + 20);
      const uncompSize = u32(bytes, p + 24);
      const nameLen = u16(bytes, p + 28);
      const extraLen = u16(bytes, p + 30);
      const commentLenE = u16(bytes, p + 32);
      const diskStart = u16(bytes, p + 34);
      const localOffset = u32(bytes, p + 42);
      if (nameLen === 0 || nameLen > MAX_NAME_LEN) {
        return { ok: false, reason: `nombre de entrada inválido en la entrada ${e}` };
      }
      if (p + 46 + nameLen + extraLen + commentLenE > n) {
        return { ok: false, reason: `entrada ${e} excede los límites del archivo` };
      }
      if (diskStart !== 0) return { ok: false, reason: 'entrada de disco distinto (multi-disco)' };
      if (
        compSize === 0xffffffff ||
        uncompSize === 0xffffffff ||
        crc === 0xffffffff ||
        localOffset === 0xffffffff
      ) {
        return { ok: false, reason: 'sentinelas ZIP64 en entrada — no soportado por contrato' };
      }
      if (flags & 0x1) return { ok: false, reason: 'entrada cifrada (bit 0) — hostil por contrato' };
      if (flags & 0x40) return { ok: false, reason: 'cifrado fuerte (bit 6) — hostil por contrato' };
      if (method !== 0 && method !== 8) {
        return { ok: false, reason: `método de compresión no soportado (${method})` };
      }
      const utf8 = (flags & 0x800) !== 0;
      const name = decodeName(bytes, p + 46, nameLen, utf8);
      if (!safeName(name)) {
        return { ok: false, reason: `nombre hostil (zip-slip/absoluta/control): «${name.slice(0, 40)}»` };
      }
      if (method === 0 && compSize !== uncompSize) {
        return { ok: false, reason: `tamaño inconsistente en entrada almacenada «${name}»` };
      }
      if (uncompSize > MAX_ENTRY_BYTES) {
        return { ok: false, reason: `entrada «${name}» declara ${uncompSize} B > presupuesto por entrada` };
      }
      cd.push({
        name,
        rawName: bytes.subarray(p + 46, p + 46 + nameLen),
        flags,
        method,
        crc,
        compSize,
        uncompSize,
        localOffset,
      });
      p += 46 + nameLen + extraLen + commentLenE;
    }
    if (p - cdOffset > cdSize) {
      return { ok: false, reason: 'directorio central declara menos bytes de los ocupados' };
    }
  }

  // Nombres duplicados ⇒ hostil
  {
    const seen = new Set<string>();
    for (const e of cd) {
      if (seen.has(e.name)) return { ok: false, reason: `entrada duplicada «${e.name}»` };
      seen.add(e.name);
    }
  }

  // Presupuesto acumulado ANTES de inflar (declarado)
  let totalDeclared = 0;
  for (const e of cd) {
    totalDeclared += e.uncompSize;
    if (totalDeclared > MAX_TOTAL_UNCOMPRESSED) {
      return { ok: false, reason: 'presupuesto total del pack excedido (bomba declarada)' };
    }
  }

  // Rangos de datos solapados (hostil por contrato: entradas solapadas)
  // y extracción con verificación por entrada.
  const entries: ZipEntry[] = [];
  const ranges: Array<{ a: number; b: number }> = [];
  for (let e = 0; e < cd.length; e++) {
    const row = cd[e];
    const lp = row.localOffset;
    if (lp + 30 > n || u32(bytes, lp) !== SIG_LOCAL) {
      return { ok: false, reason: `cabecera local rota en «${row.name}»` };
    }
    const lFlags = u16(bytes, lp + 6);
    const lMethod = u16(bytes, lp + 8);
    const lCrc = u32(bytes, lp + 14);
    const lComp = u32(bytes, lp + 18);
    const lUncomp = u32(bytes, lp + 22);
    const lNameLen = u16(bytes, lp + 26);
    const lExtraLen = u16(bytes, lp + 28);
    if (lNameLen !== row.rawName.length) {
      return { ok: false, reason: `desacuerdo de longitud de nombre local/central en «${row.name}»` };
    }
    for (let i = 0; i < row.rawName.length; i++) {
      if (bytes[lp + 30 + i] !== row.rawName[i]) {
        return { ok: false, reason: `nombre local ≠ central en «${row.name}»` };
      }
    }
    if ((lFlags & 0x1) !== 0) return { ok: false, reason: 'entrada cifrada en cabecera local' };
    if (lMethod !== row.method) {
      return { ok: false, reason: `método local ≠ central en «${row.name}»` };
    }
    // Bit 3 (data descriptor): los tamaños locales valen 0 — la verdad
    // está en el directorio central, que es lo que verificamos.
    if (!(row.flags & 0x8)) {
      if (lComp !== row.compSize || lUncomp !== row.uncompSize || lCrc !== row.crc) {
        return { ok: false, reason: `tamaños/CRC local ≠ central en «${row.name}»` };
      }
    }
    const dataStart = lp + 30 + lNameLen + lExtraLen;
    if (dataStart + row.compSize > n) {
      return { ok: false, reason: `datos de «${row.name}» truncados` };
    }
    // Solapamiento de rangos de datos
    const a = dataStart;
    const b = dataStart + row.compSize;
    for (const r of ranges) {
      if (a < r.b && r.a < b) {
        return { ok: false, reason: `entradas con datos solapados («${row.name}») — hostil por contrato` };
      }
    }
    ranges.push({ a, b });

    let data: Uint8Array;
    if (row.method === 0) {
      data = bytes.slice(a, b);
    } else {
      const res = inflateRaw(bytes, a, b, row.uncompSize);
      if (!res) return { ok: false, reason: `stream Deflate inválido en «${row.name}»` };
      if (res.overflow) {
        return { ok: false, reason: `bomba de descompresión en «${row.name}» (excede lo declarado)` };
      }
      if (!res.complete) {
        return { ok: false, reason: `stream Deflate incompleto en «${row.name}» (menos de lo declarado)` };
      }
      if (res.out.length !== row.uncompSize) {
        return { ok: false, reason: `tamaño real ≠ declarado en «${row.name}»` };
      }
      data = res.out;
    }
    const actualCrc = crc32(data);
    if (actualCrc !== row.crc) {
      return { ok: false, reason: `CRC32 inconsistente en «${row.name}»` };
    }
    entries.push({
      name: row.name,
      method: row.method,
      crc32: row.crc,
      compressedSize: row.compSize,
      uncompressedSize: row.uncompSize,
      data,
    });
  }

  return { ok: true, entries };
}
