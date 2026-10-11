/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SHA-256 puro TypeScript (EX-004 · checkpoint de ingeniería).
 *
 * ¿Por qué no WebCrypto ni node:crypto? La semilla MXP1 debe verificar
 * idéntica en worker, SSR y cliente, SIN dependencias y de forma SINCRONA
 * (el pack se genera dentro de render/hidratación). FIPS 180-4.
 * Determinismo bit-exacto verificado contra vectores oficiales en la
 * suite forense (`bun test`).
 */

/** Constantes K de FIPS 180-4 (primeras 32 bits de las fracciones cúbicas de los primeros 64 primos). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = '0123456789abcdef';

/** Hash SHA-256 de una cadena UTF-8 → hex completo (64 chars). Sincrono, determinista, 0 dependencias. */
export function sha256Hex(input: string): string {
  // UTF-8 sin TextEncoder (idéntico resultado en todos los runtimes; payload MXP1 es ASCII/numérico)
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const c2 = input.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return sha256Core(bytes);
}

/** Núcleo FIPS 180-4 compartido: padding + compresión sobre bytes crudos. */
function sha256Core(rawBytes: Uint8Array | number[]): string {
  const bytes: number[] = Array.isArray(rawBytes)
    ? (rawBytes as number[])
    : Array.from(rawBytes as Uint8Array);
  const bitLen = bytes.length * 8;
  // Padding FIPS: 0x80, ceros, longitud de 64 bits big-endian
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / 2 ** (8 * i)) & 0xff);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
      const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) {
    const v = H[i];
    for (let s = 28; s >= 0; s -= 4) out += HEX[(v >>> s) & 15];
  }
  return out;
}

/**
 * SHA-256 sobre bytes arbitrarios (FR-3 · custodia del Mission Pack) → hex.
 * Comparte el núcleo FIPS con sha256Hex — determinista, síncrono, 0 deps.
 * Nota de rendimiento (hallazgo F-3 del checkpoint, ):
 * la implementación TS pura mide ~136 ms/MB — para packs reales > 10 MB
 * corresponde el ADR WebCrypto con fallback a worker (registrado, no
 * bloquea: el límite duro de ingesta es 50 MB y los packs de campo son
 * órdenes de magnitud menores).
 */
export function sha256HexBytes(inputBytes: Uint8Array): string {
  return sha256Core(inputBytes);
}

/** Checksum MXP1 v2: primeros 64 bits del SHA-256 → 16 hex (sin ambigüedad con djb2 base36 de v1). */
export function sha256Trunc64(input: string): string {
  return sha256Hex(input).slice(0, 16);
}
