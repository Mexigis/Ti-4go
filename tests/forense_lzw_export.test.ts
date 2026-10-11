/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — LZW (KwKwK vs encoder propio) y hash de export por-entorno.
 * (a) El decodificador LZW propio maneja el caso clásico KwKwK (código que
 *     referencia la entrada que se está definiendo), verificado contra un
 *     encoder LZW-TIFF simétrico escrito en el test (early change en
 *     511/1023/2047, Clear 256, EOI 257, MSB-first).
 * (b) El SVG de export es determinista dentro de un entorno: escena fija ⇒
 *     hash SHA-256 idéntico. El pin está etiquetado por entorno (bun) para
 *     detectar deriva cross-runtime cuando se compare en producción.
 */
import { describe, expect, test } from 'bun:test';
import { lzwDecodeTiff } from '../src/lib/ingest/geotiff-dem';
import { sha256Hex } from '../src/lib/terrain/sha256';
import { buildTerrain } from '../src/lib/terrain/generator';
import { buildContours } from '../src/lib/terrain/contours';
import { buildDisplayList, serializeSvg } from '../src/lib/terrain/export';
import { COLORS, type ViewOpts } from '../src/lib/terrain/engine';
import { getRegion } from '../src/lib/terrain/regions';

/* ------------------------------------------------------------------ */
/* Encoder LZW-TIFF simétrico (solo test)                              */
/* ------------------------------------------------------------------ */

/**
 * Encoder LZW-TIFF simétrico (solo test) — umbral early change
 * 512/1024/2048, validado 2026-09-26 contra libtiff REAL (gdal_translate
 * COMPRESS=LZW): bitstream IDÉNTICO byte a byte al strip de libtiff.
 * (El umbral 511/1023/2047 previo cambiaba de ancho un código antes y
 * divergía con presión de diccionario; el decodificador de producción ya
 * era el canónico — umbral 511 — y decodifica libtiff real bit-exacto.)
 */
function lzwEncodeTiff(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  let codeBits = 9;
  let next = 258;
  const dict = new Map<string, number>();
  const reset = () => {
    dict.clear();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
    next = 258;
    codeBits = 9;
  };
  const emit = (code: number) => {
    acc = (acc << codeBits) | code;
    bits += codeBits;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  };
  emit(256); // Clear
  reset();
  let w = '';
  for (const ch of input) {
    const c = w + String.fromCharCode(ch);
    if (dict.has(c)) {
      w = c;
      continue;
    }
    emit(dict.get(w)!);
    if (next < 4096) {
      dict.set(c, next++);
      if (next === 512 || next === 1024 || next === 2048) codeBits += 1;
    }
    w = String.fromCharCode(ch);
  }
  if (w !== '') emit(dict.get(w)!);
  emit(257); // EOI
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return new Uint8Array(out);
}

describe('LZW — KwKwK y round-trip vs encoder propio', () => {
  test('patrón KwKwK clásico ("aaaaa") decodifica exacto', () => {
    const input = new Uint8Array([97, 97, 97, 97, 97]);
    const stream = lzwEncodeTiff(input);
    const out = lzwDecodeTiff(stream, input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });
  test('los códigos emitidos incluyen code === next (rama KwKwK ejercitada)', () => {
    // "aaaaa" produce [Clear, 97, 258, 258, EOI] — el 258 es code===next en el decoder
    const stream = lzwEncodeTiff(new Uint8Array([97, 97, 97, 97, 97]));
    // 9 bits: Clear(256), 97, 258, 258, EOI(257) ⇒ bitstream verificable a mano
    const codes: number[] = [];
    let acc = 0, bits = 0, cb = 9;
    for (const b of stream) {
      acc = (acc << 8) | b;
      bits += 8;
      while (bits >= cb) {
        bits -= cb;
        codes.push((acc >> bits) & ((1 << cb) - 1));
        acc &= (1 << bits) - 1;
      }
    }
    expect(codes[0]).toBe(256); // Clear
    expect(codes[1]).toBe(97); // 'a'
    expect(codes[2]).toBe(258); // primera entrada del diccionario
    expect(codes[3]).toBe(258); // KwKwK: el decoder resuelve cadena(prev)+first(prev)
  });
  test('round-trip de patrones adversos (repetición, escalera, vacío-informativo)', () => {
    const cases: Uint8Array[] = [
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
      Uint8Array.from({ length: 64 }, (_, i) => i & 0xff),
      new Uint8Array(300).fill(200),
      Uint8Array.from([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]),
    ];
    for (const input of cases) {
      const out = lzwDecodeTiff(lzwEncodeTiff(input), input.length);
      expect(Array.from(out)).toEqual(Array.from(input));
    }
  });
  test('degradación honesta: flujo truncado termina sin colgar (≤ esperado)', () => {
    const stream = lzwEncodeTiff(new Uint8Array(64).fill(7));
    const out = lzwDecodeTiff(stream.slice(0, Math.max(1, stream.length - 2)), 64);
    expect(out.length).toBeLessThanOrEqual(64);
  });
});

/* ------------------------------------------------------------------ */
/* Hash de export por-entorno                                          */
/* ------------------------------------------------------------------ */

describe('Export — hash determinista por-entorno', () => {
  const model = buildTerrain(getRegion('soledad'));
  const contours = buildContours(model.grid);
  const opts: ViewOpts = {
    minor: true,
    major: true,
    mesh: true,
    nodes: false,
    streams: true,
    divides: true,
    labels: true,
    cotas: true,
    inegi: true,
    elevRange: [contours.minV, contours.maxV],
    forcedStep: 0,
    reliefFx: true,
    eink: false,
    day: false,
    powerSave: false,
  };
  const scene = {
    model,
    contours,
    opts,
    cam: { az: (-45 * Math.PI) / 180, el: (35.3 * Math.PI) / 180, zoom: 1, panX: 0, panY: 0, pxPerM: 0.08, w: 800, h: 600, dpr: 1 },
    step: 1,
    useLight: false,
    bucketColor: ['#7a7a85', '#7a7a85', '#7a7a85', '#8a8a92'],
    fogIdx: 0,
  } as const;

  test('buildDisplayList + serializeSvg deterministas (mismo input ⇒ mismo output)', () => {
    const a = serializeSvg(buildDisplayList(scene as never), scene as never);
    const b = serializeSvg(buildDisplayList(scene as never), scene as never);
    expect(a).toBe(b);
  });
  test('pin de hash etiquetado por entorno (deriva cross-runtime detectable)', () => {
    const svg = serializeSvg(buildDisplayList(scene as never), scene as never);
    const hash = sha256Hex(svg);
    // PIN[bun]: re-estampado en la unidad geoid.ts (FR-7 · GGM25, trace
    // ): el cajetín gana la fila «Datum» (WGS84 elipsoidal
    // ⟷ GGM25 ortométrica) — parte del contrato de aceptación de la
    // unidad; el hash anterior (a91da70b…, 2026-09-25) queda en historia.
    // Si este test falla en OTRO entorno, comparar el hash obtenido contra
    // este pin para localizar la deriva cross-runtime (no es bug por sí
    // mismo: es el contrato de verificación peritaje).
    expect(hash).toBe('209c2215a981fb0132e0f9bc8f9711480488f783b043baad72a4d05f64ed151b');
  });
  test('el SVG lleva la marca de calidad (Ti-4GO) y el cajetín', () => {
    const svg = serializeSvg(buildDisplayList(scene as never), scene as never);
    expect(svg).toContain('Ti-4GO');
    expect(svg.startsWith('<?xml') || svg.startsWith('<svg')).toBe(true);
  });
});
