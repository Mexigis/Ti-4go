/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-4 — Gramática semántica de línea D11 (7 layer types,
 * E-Ink-first pixel-verified, H-4 DIVERGE en LIENZO, flechas presupuestadas,
 * forward-compat genérico+nota).
 *
 * Verificación POR PÍXEL con el rasterizador de software (CPU puro, 0 GPU,
 * determinista):
 *   - Por tipo: peso medido ≈ peso declarado, continuidad (huecos según
 *     patrón), tinta presente.
 *   - Distinguibilidad PAR-A-PAR con los 7 juntos: los 7 tipos rasterizados
 *     sobre la MISMA geometría en un solo lienzo lado a lado; cada par de
 *     tipos difiere ≥ umbral de Hamming (B/N estricto — sin color).
 *   - DIVERGE (H-4): estilo de alerta distinguible del mismo tipo en estado
 *     normal + triángulos presupuestados (≤ D11_MAX_DIVERGE_MARKS).
 *   - Flechas de ruta: nodos presupuestados (≤ D11_MAX_NODES) y orientados.
 *   - Forward-compat: tipo desconocido ⇒ codificación genérica + nota,
 *     nunca rechazo.
 *
 * NOTA de timeout (nota del checkpoint sobre valores de timeout en tests):
 * los tests de presupuesto declaran su timeout literal en el propio test
 * ({ timeout: 10_000 } — ver cada test).
 */
import { describe, expect, test } from 'bun:test';
import {
  D11_LAYER_TYPES,
  D11_GENERIC,
  D11_MAX_NODES,
  D11_MAX_DIVERGE_MARKS,
  D11_PROBABLE_WEIGHT,
  resolveLineStyle,
  sampleNodes,
  createTarget,
  rasterizeLine,
  inkRatio,
  pixelHamming,
  hasGaps,
  measuredWeight,
  type D11LayerType,
} from '../src/lib/terrain/linegrammar';

/* Geometría de referencia: misma para todos los tipos (equidad del cruce). */
function refLine(n = 40): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    pts.push([6 + (i * (180 - 12)) / (n - 1), 30 + (i % 2 === 0 ? 0 : 2)]);
  }
  return pts;
}

const EXPECTED_WEIGHT: Record<D11LayerType, number> = {
  'curva-maestra': 1.6,
  'curva-intermedia': 0.9,
  cauce: 1.1,
  divisoria: 1.3,
  hachura: 0.5,
  vector: 1.0,
  ruta: 1.4,
};
const EXPECTED_GAPS: Record<D11LayerType, boolean> = {
  'curva-maestra': false,
  'curva-intermedia': false,
  cauce: false,
  divisoria: true,
  hachura: false,
  vector: false,
  ruta: true,
};

describe('FR-4 gramática D11 — resolvedor', () => {
  test('exactamente 7 tipos registrados, sin duplicados', () => {
    expect(D11_LAYER_TYPES.length).toBe(7);
    expect(new Set(D11_LAYER_TYPES).size).toBe(7);
    expect([...D11_LAYER_TYPES]).toContain('ruta');
    expect([...D11_LAYER_TYPES]).toContain('curva-maestra');
  });

  test('pesos y continuidad por tipo (la gramática es la del ADR)', () => {
    const w = D11_LAYER_TYPES.map((t) => resolveLineStyle(t).style.weightPx);
    // La maestra es la más pesada; la intermedia y hachura las más finas
    expect(Math.max(...w)).toBe(resolveLineStyle('curva-maestra').style.weightPx);
    expect(resolveLineStyle('curva-intermedia').style.weightPx).toBeLessThan(
      resolveLineStyle('cauce').style.weightPx
    );
    expect(resolveLineStyle('divisoria').style.dash).toEqual([7, 5]);
    expect(resolveLineStyle('ruta').style.dash).toEqual([2, 3, 7, 3]);
    expect(resolveLineStyle('curva-maestra').style.dash).toEqual([]);
    expect(resolveLineStyle('ruta').style.nodeGlyph).toBe('arrow');
    expect(resolveLineStyle('vector').style.nodeGlyph).toBe('square');
    expect(resolveLineStyle('cauce').style.nodeGlyph).toBe('circle');
    expect(resolveLineStyle('hachura').style.nodeGlyph).toBe('none');
  });

  test('determinismo: misma entrada ⇒ mismo resolvedor', () => {
    const a = JSON.stringify(resolveLineStyle('ruta', 'diverge'));
    const b = JSON.stringify(resolveLineStyle('ruta', 'diverge'));
    expect(a).toBe(b);
  });

  test('forward-compat: tipo desconocido ⇒ genérico + nota honesta, nunca fallo', () => {
    const r = resolveLineStyle('capa-futura-ignis');
    expect(r.known).toBe(false);
    expect(r.type).toBe(D11_GENERIC);
    expect(r.note).toContain('capa-futura-ignis');
    expect(r.note).toContain('genérica');
    // tipo vacío/undefined ⇒ genérico silencioso (sin nota de desconocido)
    expect(resolveLineStyle(undefined).known).toBe(false);
    expect(resolveLineStyle('').note).toBe('');
  });

  test('DIVERGE: guión de alerta 4-2, halo 2.5, triángulos', () => {
    const r = resolveLineStyle('vector', 'diverge');
    expect(r.state).toBe('diverge');
    expect(r.style.dash).toEqual([4, 2]);
    expect(r.style.haloPx).toBe(2.5);
    expect(r.style.nodeGlyph).toBe('triangle');
    expect(r.note).toContain('DIVERGE');
    // y sobre un tipo ya discontinuo igualmente impone el patrón de alerta
    expect(resolveLineStyle('ruta', 'diverge').style.dash).toEqual([4, 2]);
  });
});

describe('FR-4 E-Ink pixel-verified por tipo', () => {
  for (const type of D11_LAYER_TYPES) {
    test(`B/N ${type}: peso medido ≈ declarado, continuidad según patrón, tinta presente`, () => {
      const res = resolveLineStyle(type);
      const t = createTarget(200, 60);
      // Línea de referencia HORIZONTAL SIN nodos — el grosor se mide sobre
      // la LÍNEA; los glifos se verifican aparte (pixel-verified también).
      const pts: Array<[number, number]> = refLine().map(([x]) => [x, 30]);
      rasterizeLine(t, pts, res, false);
      const ratio = inkRatio(t);
      expect(ratio).toBeGreaterThan(0);
      const w = measuredWeight(t);
      // El disco de cobertura redondea hacia arriba ±1 px
      expect(w).toBeGreaterThanOrEqual(Math.floor(EXPECTED_WEIGHT[type]));
      expect(w).toBeLessThanOrEqual(Math.ceil(EXPECTED_WEIGHT[type]) + 1);
      expect(hasGaps(t)).toBe(EXPECTED_GAPS[type]);
    });
  }

  test('glifos por tipo impresos: cauce círculo, vector cuadrado, ruta flechas (pixel-verified)', () => {
    const glyphs: Array<[D11LayerType, number]> = [
      ['cauce', inkRatio((() => { const t = createTarget(200, 60); rasterizeLine(t, refLine().map(([x, y]) => [x, y]), resolveLineStyle('cauce'), true); return t; })())],
      ['vector', inkRatio((() => { const t = createTarget(200, 60); rasterizeLine(t, refLine().map(([x, y]) => [x, y]), resolveLineStyle('vector'), true); return t; })())],
      ['ruta', inkRatio((() => { const t = createTarget(200, 60); rasterizeLine(t, refLine().map(([x, y]) => [x, y]), resolveLineStyle('ruta'), true); return t; })())],
    ];
    for (const [type, withNodes] of glyphs) {
      const bare = createTarget(200, 60);
      rasterizeLine(bare, refLine().map(([x, y]) => [x, y]), resolveLineStyle(type), false);
      expect(withNodes).toBeGreaterThan(inkRatio(bare)); // el glifo añade tinta
    }
  });

  test('los 7 pesos declarados son distintos dos a dos (sin ambigüedad sola)', () => {
    const ws = D11_LAYER_TYPES.map((t) => resolveLineStyle(t).style.weightPx);
    expect(new Set(ws).size).toBe(7);
  });
});

describe('FR-4 distinguibilidad par-a-par con los 7 juntos', () => {
  // Un solo lienzo con los 7 tipos lado a lado (misma geometría, franjas
  // separadas) — verificación de que CADA PAR es distinguible en B/N.
  const N = D11_LAYER_TYPES.length;
  const STRIP_W = 200;
  const STRIP_H = 44;
  const canvas = createTarget(STRIP_W, STRIP_H * N);
  const perType = new Map<D11LayerType, ReturnType<typeof createTarget>>();

  for (let i = 0; i < N; i++) {
    const type = D11_LAYER_TYPES[i];
    const res = resolveLineStyle(type);
    const strip = createTarget(STRIP_W, STRIP_H);
    rasterizeLine(strip, refLine().map(([x, y]) => [x, y]), res, true);
    perType.set(type, strip);
    // copiar franja al lienzo conjunto (offset y = i*STRIP_H)
    for (let y = 0; y < STRIP_H; y++)
      for (let x = 0; x < STRIP_W; x++)
        canvas.ink[(i * STRIP_H + y) * STRIP_W + x] = strip.ink[y * STRIP_W + x];
  }

  test('los 7 tipos juntos: cada franja tiene tinta y su patrón propio', () => {
    expect(inkRatio(canvas)).toBeGreaterThan(0.01);
    for (const type of D11_LAYER_TYPES) {
      const strip = perType.get(type)!;
      expect(inkRatio(strip)).toBeGreaterThan(0);
    }
  });

  test('par-a-par: Hamming ≥ 0.004 entre TODOS los pares (21 pares = C(7,2))', () => {
    const UMBRAL = 0.004; // 0.4 % de píxeles — umbral de distinguibilidad B/N
    let pairs = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = perType.get(D11_LAYER_TYPES[i])!;
        const b = perType.get(D11_LAYER_TYPES[j])!;
        const d = pixelHamming(a, b);
        if (!(d >= UMBRAL)) {
          throw new Error(`par indistinguible: ${D11_LAYER_TYPES[i]} vs ${D11_LAYER_TYPES[j]} Hamming=${d}`);
        }
        pairs++;
      }
    }
    expect(pairs).toBe(21); // C(7,2) — todos los pares de los 7 tipos
  });

  test('par-a-par DIVERGE: el estado de alerta distingue del mismo tipo normal (7 tipos × 2 estados)', () => {
    for (const type of D11_LAYER_TYPES) {
      const normal = createTarget(STRIP_W, STRIP_H);
      const diverge = createTarget(STRIP_W, STRIP_H);
      rasterizeLine(normal, refLine().map(([x, y]) => [x, y]), resolveLineStyle(type, 'normal'), true);
      rasterizeLine(diverge, refLine().map(([x, y]) => [x, y]), resolveLineStyle(type, 'diverge'), true);
      expect(pixelHamming(normal, diverge)).toBeGreaterThanOrEqual(0.004);
    }
  });
});

describe('FR-4 nodos presupuestados y flechas', () => {
  test('flechas de ruta: presupuesto D11_MAX_NODES respetado con muestreo determinista', () => {
    const segs: Array<{ a: number; b: number; ax: number; ay: number; bx: number; by: number }> = [];
    const V = 5000; // polilínea larga: sin presupuesto serían ~400 flechas
    for (let i = 1; i < V; i++)
      segs.push({ a: i - 1, b: i, ax: i - 1, ay: 0, bx: i, by: 0 });
    const n1 = sampleNodes('arrow', segs, V);
    const n2 = sampleNodes('arrow', segs, V);
    expect(n1.length).toBeLessThanOrEqual(D11_MAX_NODES);
    expect(n1.length).toBeGreaterThan(0);
    // determinista
    expect(JSON.stringify(n1)).toBe(JSON.stringify(n2));
    // orientadas: ángulo del portador (0 → este)
    expect(n1[0].angle).toBe(0);
  }, 10_000);

  test('triángulos DIVERGE: presupuesto D11_MAX_DIVERGE_MARKS respetado', () => {
    const segs: Array<{ a: number; b: number; ax: number; ay: number; bx: number; by: number }> = [];
    const V = 20000;
    for (let i = 1; i < V; i++) segs.push({ a: i - 1, b: i, ax: i - 1, ay: 0, bx: i, by: 0 });
    const n = sampleNodes('triangle', segs, V);
    expect(n.length).toBeLessThanOrEqual(D11_MAX_DIVERGE_MARKS);
    expect(n.length).toBe(D11_MAX_DIVERGE_MARKS); // el presupuesto se USA (marcadores visibles)
  });

  test('glifo none ⇒ 0 nodos (curvas sin ruido)', () => {
    const segs = [{ a: 0, b: 1, ax: 0, ay: 0, bx: 10, by: 0 }];
    expect(sampleNodes('none', segs, 2).length).toBe(0);
  });

  test('DIVERGE en el lienzo: los triángulos quedan impresos (pixel-verified)', () => {
    const res = resolveLineStyle('vector', 'diverge');
    const t = createTarget(220, 60);
    rasterizeLine(t, refLine().map(([x, y]) => [x, y]), res, true);
    // con triángulos la tinta supera con claridad a la línea sola
    const sinNodos = createTarget(220, 60);
    rasterizeLine(sinNodos, refLine().map(([x, y]) => [x, y]), res, false);
    expect(inkRatio(t)).toBeGreaterThan(inkRatio(sinNodos));
  });
});

/* ------------------------------------------------------------------ */
/* FR-4 v1.1 defensiva — route_class / confidence (checkpoint trace   */
/* ): LECTURA, no emisión (REQ-10). Gramática v1.1    */
/* verificada par-a-par ANTES de implementar (ADR, 3 rondas).         */
/* ------------------------------------------------------------------ */

describe('FR-4 v1.1 defensiva — retrocompatibilidad byte-idéntica', () => {
  test('sin attrs ⇒ salida idéntica a v1.0 (los 7 tipos)', () => {
    for (const type of D11_LAYER_TYPES) {
      const v10 = resolveLineStyle(type);
      const sinAttrs = resolveLineStyle(type, 'normal');
      const vacio = resolveLineStyle(type, 'normal', {});
      const indefinidos = resolveLineStyle(type, 'normal', {
        routeClass: undefined,
        confidence: undefined,
      });
      expect(JSON.stringify(sinAttrs)).toBe(JSON.stringify(v10));
      expect(JSON.stringify(vacio)).toBe(JSON.stringify(v10));
      expect(JSON.stringify(indefinidos)).toBe(JSON.stringify(v10));
    }
  });

  test('confianza inválida ⇒ ignorada (= ausente, default 100)', () => {
    for (const conf of [-5, 150, NaN, Infinity]) {
      const r = resolveLineStyle('ruta', 'normal', { confidence: conf });
      expect(JSON.stringify(r)).toBe(JSON.stringify(resolveLineStyle('ruta')));
    }
  });
});

describe('FR-4 v1.1 defensiva — clases de ruta', () => {
  test('secundaria: peso 1.0, mismo guión-punto, flecha', () => {
    const r = resolveLineStyle('ruta', 'normal', { routeClass: 'secundaria' });
    expect(r.style.weightPx).toBe(1.0);
    expect(r.style.dash).toEqual([2, 3, 7, 3]);
    expect(r.style.nodeGlyph).toBe('arrow');
    expect(r.note).toBe('');
  });

  test('emergencia: peso 1.6 + guión 2-3-7-3-7-3 (seguridad de vida)', () => {
    const r = resolveLineStyle('ruta', 'normal', { routeClass: 'emergencia' });
    expect(r.style.weightPx).toBe(1.6);
    expect(r.style.dash).toEqual([2, 3, 7, 3, 7, 3]);
    expect(r.style.nodeGlyph).toBe('arrow');
    expect(r.note).toBe('');
  });

  test('primaria explícita = base; mayúsculas normalizadas', () => {
    expect(JSON.stringify(resolveLineStyle('ruta', 'normal', { routeClass: 'primaria' }))).toBe(
      JSON.stringify(resolveLineStyle('ruta'))
    );
    expect(resolveLineStyle('ruta', 'normal', { routeClass: 'EMERGENCIA' }).style.weightPx).toBe(1.6);
  });

  test('clase no registrada ⇒ primaria + nota honesta (nunca rechazo)', () => {
    const r = resolveLineStyle('ruta', 'normal', { routeClass: ' sendero-nocturno ' });
    expect(r.style.weightPx).toBe(1.4);
    expect(r.style.dash).toEqual([2, 3, 7, 3]);
    expect(r.note).toContain('sendero-nocturno');
    expect(r.note).toContain('primaria');
  });

  test('routeClass sobre tipo no-ruta ⇒ ignorado en silencio', () => {
    expect(JSON.stringify(resolveLineStyle('vector', 'normal', { routeClass: 'emergencia' }))).toBe(
      JSON.stringify(resolveLineStyle('vector'))
    );
    expect(JSON.stringify(resolveLineStyle('cauce', 'normal', { routeClass: 'secundaria' }))).toBe(
      JSON.stringify(resolveLineStyle('cauce'))
    );
  });
});

describe('FR-4 v1.1 defensiva — confianza', () => {
  test('≥ umbral: opacidad lineal 0.55→1.0, patrón intacto, sin nota', () => {
    expect(resolveLineStyle('ruta').opacity).toBe(1);
    expect(resolveLineStyle('ruta', 'normal', { confidence: 100 }).opacity).toBe(1);
    expect(resolveLineStyle('ruta', 'normal', { confidence: 50 }).opacity).toBeCloseTo(0.55);
    expect(resolveLineStyle('ruta', 'normal', { confidence: 75 }).opacity).toBeCloseTo(0.775);
    const r = resolveLineStyle('vector', 'normal', { confidence: 80 });
    expect(r.style.dash).toEqual([]); // patrón v1.0 intacto
    expect(r.style.nodeGlyph).toBe('square');
    expect(r.note).toBe('');
  });

  test('< umbral ⇒ probable: punteado [1,3], nodos retirados, peso cuantizado, nota', () => {
    const casos: Array<[D11LayerType, number]> = [
      ['ruta', D11_PROBABLE_WEIGHT.pesada],
      ['curva-maestra', D11_PROBABLE_WEIGHT.pesada],
      ['cauce', D11_PROBABLE_WEIGHT.media],
      ['vector', D11_PROBABLE_WEIGHT.media],
      ['divisoria', D11_PROBABLE_WEIGHT.media],
      ['curva-intermedia', D11_PROBABLE_WEIGHT.fina],
      ['hachura', D11_PROBABLE_WEIGHT.fina],
    ];
    for (const [type, peso] of casos) {
      const r = resolveLineStyle(type, 'normal', { confidence: 25 });
      expect(r.style.dash).toEqual([1, 3]);
      expect(r.style.nodeGlyph).toBe('none');
      expect(r.style.weightPx).toBe(peso);
      expect(r.note).toContain('probable, no confirmado');
    }
  });

  test('DIVERGE > probable: la alarma gana dash/halo/nodo; nota y opacidad siguen', () => {
    const r = resolveLineStyle('ruta', 'diverge', { confidence: 30 });
    expect(r.style.dash).toEqual([4, 2]);
    expect(r.style.haloPx).toBe(2.5);
    expect(r.style.nodeGlyph).toBe('triangle');
    expect(r.note).toContain('probable, no confirmado');
    expect(r.note).toContain('DIVERGE');
  });

  test('el rasterizador B/N ignora la opacidad (legibilidad binaria intacta)', () => {
    const t80 = createTarget(200, 60);
    const t100 = createTarget(200, 60);
    rasterizeLine(
      t80,
      refLine().map(([x, y]) => [x, y]),
      resolveLineStyle('cauce', 'normal', { confidence: 80 }),
      true
    );
    rasterizeLine(
      t100,
      refLine().map(([x, y]) => [x, y]),
      resolveLineStyle('cauce', 'normal', { confidence: 100 }),
      true
    );
    expect(pixelHamming(t80, t100)).toBe(0);
  });
});

describe('FR-4 v1.1 — par-a-par verificado en suite (ronda 3 del ADR)', () => {
  const UMBRAL = 0.004;
  const mk = (res: ReturnType<typeof resolveLineStyle>): ReturnType<typeof createTarget> => {
    const t = createTarget(200, 44);
    rasterizeLine(
      t,
      refLine().map(([x, y]) => [x, y]),
      res,
      true
    );
    return t;
  };
  const prob = (type: D11LayerType): ReturnType<typeof resolveLineStyle> =>
    resolveLineStyle(type, 'normal', { confidence: 25 });

  test('escalera probable: fina/media/pesada distinguibles dos a dos', () => {
    const fina = mk(prob('hachura'));
    const media = mk(prob('cauce'));
    const pesada = mk(prob('ruta'));
    expect(pixelHamming(fina, media)).toBeGreaterThanOrEqual(UMBRAL);
    expect(pixelHamming(fina, pesada)).toBeGreaterThanOrEqual(UMBRAL);
    expect(pixelHamming(media, pesada)).toBeGreaterThanOrEqual(UMBRAL);
  });

  test('cada tipo normal vs su propio estado probable (7 tipos)', () => {
    for (const type of D11_LAYER_TYPES) {
      expect(pixelHamming(mk(resolveLineStyle(type)), mk(prob(type)))).toBeGreaterThanOrEqual(UMBRAL);
    }
  });

  test('clases de ruta: primaria/secundaria/emergencia y frente a curva-maestra/vector', () => {
    const pri = mk(resolveLineStyle('ruta'));
    const sec = mk(resolveLineStyle('ruta', 'normal', { routeClass: 'secundaria' }));
    const eme = mk(resolveLineStyle('ruta', 'normal', { routeClass: 'emergencia' }));
    const mas = mk(resolveLineStyle('curva-maestra'));
    const vec = mk(resolveLineStyle('vector'));
    expect(pixelHamming(pri, sec)).toBeGreaterThanOrEqual(UMBRAL);
    expect(pixelHamming(pri, eme)).toBeGreaterThanOrEqual(UMBRAL);
    expect(pixelHamming(mas, eme)).toBeGreaterThanOrEqual(UMBRAL);
    expect(pixelHamming(vec, sec)).toBeGreaterThanOrEqual(UMBRAL);
  });
});
