/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-4 — D11: Gramática semántica de línea para los 7 layer types del
 * LIENZO (agenda FR 1.0 · orden fijo · checkpoint de ingeniería, trace
 * ).
 *
 * PRINCIPIO E-INK-FIRST (contractual): la codificación se define en BLANCO
 * Y NEGRO sobre papel — el tipo se distingue por peso + continuidad + nodo
 * SIN color. La paleta gris+naranja de la casa se aplica ENCIMA como
 * refuerzo en modo estándar; en modo E-Ink (`eink`) la tinta es negra pura.
 * Un brigadista con mapa fotocopiado en B/N debe poder leer la capa.
 *
 * Los 7 tipos y su justificación (ADR D11 — docs/ADR-D11-gramatica-lineas.md):
 *   1. curva-maestra     — cada 25 m: la MÁS pesada (esqueleto altimétrico).
 *   2. curva-intermedia  — cada 1 m: la más fina (textura, no guía).
 *   3. cauce             — media, sólida, nodo circular (agua = punto crítico).
 *   4. divisoria         — media-pesada, guión LARGO (convención cartográfica
 *                          de límite; nunca confundible con una curva).
 *   5. hachura           — muy fina, sólida (sombra, no dato; debe leerse
 *                          como textura de fondo).
 *   6. vector            — media, sólida, nodo cuadrado (geometría ingestada
 *                          genérica: OBJ/DXF/GeoJSON).
 *   7. ruta              — pesada, guión-punto, flechas de dirección como
 *                          NODOS PRESUPUESTADOS (la capa operativa del
 *                          brigadista: su dirección manda).
 *
 * Forward-compat (contractual): un tipo DESCONOCIDO recibe la codificación
 * genérica (vector) + nota honesta — nunca un fallo.
 *
 * v1.1 DEFENSIVA (checkpoint  — lectura, no emisión):
 * `route_class`/`confidence` (+ alias `rutaClase`/`confianza` del ADR) se
 * CONSUMEN si presentes; si ausentes, la salida es byte-idéntica a v1.0.
 * La EMISIÓN del consorcio permanece v1.0 hasta que REQ-10 (14 días)
 * venza — los fixtures FR-W1 no emiten atributos v1.1. Gramática v1.1
 * VERIFICADA par-a-par ANTES de implementar (3 rondas del rasterizador:
 * ronda 1 halló el anegamiento por nodos con stride=1, ronda 2 halló el
 * colapso físico de pesos bajo punteado, ronda 3 cerró con 0
 * indistinguibles — ver ADR §v1.1).
 *
 * H-4 a nivel LIENZO: una capa con estado DIVERGE (cruce triangular FR-3)
 * lleva MARCADOR VISIBLE de advertencia: discontinuidad de alerta (guión
 * corto 4-2), halo reforzado y triángulos en hasta MAX_DIVERGE_MARKS
 * vértices muestreados de forma determinista.
 *
 * Rasterizador de software incluido: permite verificación por píxel (B/N
 * por tipo + distinguibilidad par-a-par con los 7 juntos) en CPU puro y
 * determinista, sin canvas ni GPU — coherente con la regla 0 GPU.
 */

/* ------------------------------------------------------------------ */
/* Tipos de capa D11                                                  */
/* ------------------------------------------------------------------ */

export const D11_LAYER_TYPES = [
  'curva-maestra',
  'curva-intermedia',
  'cauce',
  'divisoria',
  'hachura',
  'vector',
  'ruta',
] as const;

export type D11LayerType = (typeof D11_LAYER_TYPES)[number];

/** Tipo genérico para tipos desconocidos (forward-compat con nota). */
export const D11_GENERIC: D11LayerType = 'vector';

export type D11State = 'normal' | 'diverge';

export type D11NodeGlyph = 'none' | 'square' | 'circle' | 'arrow' | 'triangle';

/* ------------------------------------------------------------------ */
/* v1.1 defensiva — clases de ruta y confianza (lectura, no emisión)  */
/* ------------------------------------------------------------------ */

/** Jerarquía de rutas propuesta en el schema v1.1 (ADR) — solo aplica a
 *  `ruta`. Un valor desconocido ⇒ «primaria» + nota honesta (nunca fallo). */
export const D11_ROUTE_CLASSES = ['primaria', 'secundaria', 'emergencia'] as const;
export type D11RouteClass = (typeof D11_ROUTE_CLASSES)[number];
export const D11_ROUTE_GENERIC: D11RouteClass = 'primaria';

/** Umbral de confianza: < 50 ⇒ estado «probable, no confirmado» (ADR v1.1). */
export const D11_CONFIDENCE_MIN = 50;

/** Escalera de pesos del estado probable, CUANTIZADA a 3 clases B/N
 *  distintas. Hallazgo físico de la pre-verificación (ronda 2): bajo
 *  punteado [1,3] sin nodos, pesos que difieren <0.5 px colapsan
 *  (Hamming < 0.004) — mismo límite físico que el hallazgo 0.9/0.5 de
 *  v1.0. La gramática la fija la verificación por píxel, no el gusto. */
export const D11_PROBABLE_WEIGHT = { fina: 0.7, media: 1.1, pesada: 1.5 } as const;

/** Peso probable para un peso base dado (cuantización a la escalera). */
export function probableWeightClass(weightPx: number): number {
  if (weightPx <= 0.9) return D11_PROBABLE_WEIGHT.fina;
  if (weightPx <= 1.3) return D11_PROBABLE_WEIGHT.media;
  return D11_PROBABLE_WEIGHT.pesada;
}

/** Opacidad para confianza ≥ umbral: 0.55→1.0 lineal en [50..100]. NUNCA
 *  toca al rasterizador B/N (la legibilidad binaria no baja: el hallazgo
 *  del ADR); solo aplica en el lienzo a color. Determinista. */
export function confidenceOpacity(confidence: number): number {
  const c = Math.min(100, Math.max(D11_CONFIDENCE_MIN, confidence));
  return 0.55 + (0.45 * (c - D11_CONFIDENCE_MIN)) / (100 - D11_CONFIDENCE_MIN);
}

/** Atributos defensivos v1.1: se consumen si presentes, defaults si
 *  ausentes (retrocompatibilidad contractual del ADR). */
export interface D11Attrs {
  /** Clase de la ruta: 'primaria' | 'secundaria' | 'emergencia' (solo ruta). */
  routeClass?: string;
  /** Confianza 0-100; ausente/inválida ⇒ 100 (dibujado confirmado). */
  confidence?: number;
}

export interface D11Style {
  /** Peso de línea en px (CSS px a DPR 1). */
  weightPx: number;
  /** Patrón de discontinuidad en px [tinta, gap, tinta, gap…]; [] = sólida. */
  dash: number[];
  /** Halo (separación del fondo) en px; 0 = sin halo. */
  haloPx: number;
  /** Glifo de nodo asociado al tipo. */
  nodeGlyph: D11NodeGlyph;
}

export interface D11Resolved {
  type: D11LayerType;
  state: D11State;
  style: D11Style;
  /** false si el tipo declarado es desconocido ⇒ codificación genérica. */
  known: boolean;
  /** Nota honesta (tipo desconocido / DIVERGE / clase no registrada /
   *  probable, no confirmado). */
  note: string;
  /** Intensidad de tinta v1.1 (0.55–1] según confianza; 1 en v1.0.
   *  El rasterizador B/N la IGNORA (legibilidad binaria). */
  opacity: number;
}

/* ------------------------------------------------------------------ */
/* Gramática (E-Ink first: valores definidos para tinta negra/papel)  */
/* ------------------------------------------------------------------ */

const GRAMMAR: Record<D11LayerType, D11Style> = {
  // Hallazgo del test par-a-par (FR-4, reverificado in situ antes del fix —
  // regla formalizada): 0.7 vs 0.6 px en líneas sólidas era INDISTINGUIBLE
  // en B/N (Hamming 0.0014 < umbral 0.004) ⇒ separados a 0.9/0.5. La
  // gramática la fija la verificación por píxel, no el gusto.
  'curva-maestra': { weightPx: 1.6, dash: [], haloPx: 0, nodeGlyph: 'none' },
  'curva-intermedia': { weightPx: 0.9, dash: [], haloPx: 0, nodeGlyph: 'none' },
  cauce: { weightPx: 1.1, dash: [], haloPx: 0, nodeGlyph: 'circle' },
  divisoria: { weightPx: 1.3, dash: [7, 5], haloPx: 0, nodeGlyph: 'none' },
  hachura: { weightPx: 0.5, dash: [], haloPx: 0, nodeGlyph: 'none' },
  vector: { weightPx: 1.0, dash: [], haloPx: 0, nodeGlyph: 'square' },
  ruta: { weightPx: 1.4, dash: [2, 3, 7, 3], haloPx: 0, nodeGlyph: 'arrow' },
};

/** Modificador DIVERGE (H-4): discontinuidad de alerta + marcadores. */
const DIVERGE_DASH = [4, 2];
const DIVERGE_HALO = 2.5;

/** Presupuesto de nodos por capa (flechas de ruta y triángulos DIVERGE). */
export const D11_MAX_NODES = 48;
export const D11_MAX_DIVERGE_MARKS = 8;

/**
 * Resuelve el estilo de una capa. Determinista: misma (tipo, estado,
 * attrs) ⇒ mismo estilo byte a byte. Tipo desconocido ⇒ genérico + nota.
 *
 * v1.1 defensiva: `attrs` se consume si presente; SIN attrs la salida es
 * byte-idéntica a la v1.0 (retrocompatibilidad contractual del ADR).
 *
 * Precedencia documentada: DIVERGE (alarma de datos, H-4) gana
 * continuidad/halo/nodo sobre «probable» (duda); la nota de confianza y
 * la opacidad siguen aplicándose.
 */
export function resolveLineStyle(
  type: string | undefined,
  state: D11State = 'normal',
  attrs: D11Attrs = {}
): D11Resolved {
  const known = typeof type === 'string' && (D11_LAYER_TYPES as readonly string[]).includes(type);
  const t: D11LayerType = known ? (type as D11LayerType) : D11_GENERIC;
  const base = GRAMMAR[t];
  let style: D11Style = { ...base };
  const extra: string[] = [];

  /* --- v1.1: clase de ruta (solo sobre 'ruta' conocida) ------------- */
  if (known && t === 'ruta' && typeof attrs.routeClass === 'string' && attrs.routeClass.trim() !== '') {
    const rc = attrs.routeClass.trim().toLowerCase();
    if ((D11_ROUTE_CLASSES as readonly string[]).includes(rc)) {
      if (rc === 'secundaria') style = { ...style, weightPx: 1.0 };
      else if (rc === 'emergencia') style = { ...style, weightPx: 1.6, dash: [2, 3, 7, 3, 7, 3] };
      // 'primaria' ⇒ base tal cual (peso 1.4)
    } else {
      extra.push(`route_class «${attrs.routeClass.trim()}» no registrado — se aplica «primaria»`);
    }
  }

  /* --- v1.1: confianza (cualquier tipo) ------------------------------ */
  let opacity = 1;
  const conf = attrs.confidence;
  const confOk = typeof conf === 'number' && Number.isFinite(conf) && conf >= 0 && conf <= 100;
  if (confOk && (conf as number) < D11_CONFIDENCE_MIN) {
    // Probable: punteado fino + NODOS RETIRADOS (un trazo no confirmado
    // no lleva glifos firmes — hallazgo de la ronda 1: con nodos stride=1
    // la banda de glifos anula el punteado) + peso cuantizado a clase.
    style = {
      weightPx: probableWeightClass(style.weightPx),
      dash: [1, 3],
      haloPx: style.haloPx,
      nodeGlyph: 'none',
    };
    extra.push('probable, no confirmado');
  } else if (confOk) {
    opacity = confidenceOpacity(conf as number);
  }

  /* --- H-4: DIVERGE — la alarma gana continuidad/halo/nodo ----------- */
  if (state === 'diverge') {
    style = {
      weightPx: Math.max(style.weightPx, 1.2),
      dash: DIVERGE_DASH,
      haloPx: DIVERGE_HALO,
      nodeGlyph: 'triangle',
    };
  }

  let note = '';
  if (!known && typeof type === 'string' && type !== '')
    note = `Tipo «${type}» no registrado en D11 — codificación genérica (vector) aplicada`;
  for (const n of extra) note = note ? `${note} · ${n}` : n;
  if (state === 'diverge')
    note = note
      ? `${note} · DIVERGE: marcador de advertencia activo`
      : 'DIVERGE: marcador de advertencia activo';
  return { type: t, state, style, known, note, opacity };
}

/* ------------------------------------------------------------------ */
/* Glifos de nodo (deterministas, presupuesto incluido)               */
/* ------------------------------------------------------------------ */

export interface NodeSpec {
  /** Índice del vértice portador del nodo. */
  vertex: number;
  glyph: D11NodeGlyph;
  /** Dirección de viaje (solo 'arrow'): ángulo en radianes del segmento. */
  angle: number;
}

/**
 * Muestreo determinista de nodos sobre una polilínea con presupuesto.
 * Para 'arrow': flechas de dirección cada `every` segmentos — son NODOS
 * presupuestados (D11_MAX_NODES), nunca ilimitados.
 */
export function sampleNodes(
  kind: D11NodeGlyph,
  segs: Array<{ a: number; b: number; ax: number; ay: number; bx: number; by: number }>,
  vertexCount: number,
  every = 12
): NodeSpec[] {
  if (kind === 'none') return [];
  const budget = kind === 'triangle' ? D11_MAX_DIVERGE_MARKS : D11_MAX_NODES;
  const out: NodeSpec[] = [];
  if (kind === 'circle' || kind === 'square' || kind === 'triangle') {
    // Determinista: vértices espaciados uniformemente desde el inicio.
    const stride = Math.max(1, Math.floor(vertexCount / Math.max(1, Math.min(budget, vertexCount))));
    for (let v = 0; v < vertexCount && out.length < budget; v += stride) out.push({ vertex: v, glyph: kind, angle: 0 });
    return out;
  }
  // 'arrow': cada `every` segmentos, dirección del segmento portador.
  for (let s = 0; s < segs.length && out.length < budget; s += every) {
    const g = segs[s];
    out.push({ vertex: g.a, glyph: 'arrow', angle: Math.atan2(g.by - g.ay, g.bx - g.ax) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rasterizador de software (verificación por píxel, CPU puro)        */
/* ------------------------------------------------------------------ */

export interface RasterTarget {
  w: number;
  h: number;
  /** 1 = tinta, 0 = papel (B/N estricto). */
  ink: Uint8Array;
}

export function createTarget(w: number, h: number): RasterTarget {
  return { w, h, ink: new Uint8Array(w * h) };
}

function stampDisc(t: RasterTarget, cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(t.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(t.h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) t.ink[y * t.w + x] = 1;
    }
}

function stampTri(t: RasterTarget, cx: number, cy: number, r: number): void {
  // Triángulo de advertencia ▲ (vértice arriba), relleno.
  for (let dy = -r; dy <= r; dy++) {
    const half = Math.max(0, Math.round((r - Math.abs(dy)) * 0.9));
    for (let dx = -half; dx <= half; dx++) {
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x >= 0 && x < t.w && y >= 0 && y < t.h) t.ink[y * t.w + x] = 1;
    }
  }
}

/** Traza un segmento con el peso dado (discos encadenados = cobertura). */
function drawSeg(t: RasterTarget, ax: number, ay: number, bx: number, by: number, weight: number): void {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len * 2));
  const r = weight / 2;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    stampDisc(t, ax + (bx - ax) * s, ay + (by - ay) * s, r);
  }
}

/**
 * Dibuja una polilínea con el estilo resuelto en el raster objetivo.
 * `pts` son pares [x, y] en px del raster. Determinista (misma entrada
 * ⇒ misma tinta). El halo se rasteriza como tinta separada del fondo
 * SOLO para la medición de presencia (en papel el halo es papel).
 */
export function rasterizeLine(
  t: RasterTarget,
  pts: Array<[number, number]>,
  res: D11Resolved,
  withNodes = true
): void {
  if (pts.length === 0) return;
  const { style } = res;
  // Discontinuidad: partir la polilínea en tramos tinta/gap por longitud.
  const dash = style.dash;
  if (dash.length === 0) {
    for (let i = 1; i < pts.length; i++)
      drawSeg(t, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], style.weightPx);
  } else {
    let phase = 0; // índice en el patrón
    let rem = dash[0]; // longitud restante del tramo actual (tinta si par)
    let inking = true;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0];
      const ay = pts[i - 1][1];
      const bx = pts[i][0];
      const by = pts[i][1];
      let segLen = Math.hypot(bx - ax, by - ay);
      let sx = ax;
      let sy = ay;
      while (segLen > 0) {
        const step = Math.min(segLen, rem);
        const ex = sx + ((bx - sx) / segLen) * step;
        const ey = sy + ((by - sy) / segLen) * step;
        if (inking) drawSeg(t, sx, sy, ex, ey, style.weightPx);
        sx = ex;
        sy = ey;
        segLen -= step;
        rem -= step;
        if (rem <= 0) {
          phase = (phase + 1) % dash.length;
          rem = dash[phase];
          inking = phase % 2 === 0;
        }
      }
    }
  }
  // Nodos (presupuestados)
  if (withNodes && style.nodeGlyph !== 'none') {
    const segs: Array<{ a: number; b: number; ax: number; ay: number; bx: number; by: number }> = [];
    for (let i = 1; i < pts.length; i++)
      segs.push({ a: i - 1, b: i, ax: pts[i - 1][0], ay: pts[i - 1][1], bx: pts[i][0], by: pts[i][1] });
    const nodes = sampleNodes(style.nodeGlyph, segs, pts.length);
    for (const nd of nodes) {
      const [x, y] = pts[nd.vertex];
      if (nd.glyph === 'circle') stampDisc(t, x, y, 2.2);
      else if (nd.glyph === 'square') {
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const px = Math.round(x + dx);
            const py = Math.round(y + dy);
            if (px >= 0 && px < t.w && py >= 0 && py < t.h) t.ink[py * t.w + px] = 1;
          }
      } else if (nd.glyph === 'triangle') stampTri(t, x, y - 3, 4);
      else if (nd.glyph === 'arrow') {
        // Chevron orientado: dos trazos a ±135° de la dirección de viaje.
        const L = 5;
        for (const off of [Math.PI * 0.75, -Math.PI * 0.75]) {
          const ang = nd.angle + off;
          drawSeg(t, x, y, x + Math.cos(ang) * L, y + Math.sin(ang) * L, 1.4);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Métricas de verificación por píxel                                 */
/* ------------------------------------------------------------------ */

/** Ratio de tinta [0..1]. */
export function inkRatio(t: RasterTarget): number {
  let n = 0;
  for (let i = 0; i < t.ink.length; i++) if (t.ink[i]) n++;
  return n / t.ink.length;
}

/** Distancia de Hamming normalizada entre dos rasters (píxeles distintos). */
export function pixelHamming(a: RasterTarget, b: RasterTarget): number {
  if (a.w !== b.w || a.h !== b.h) return 1;
  let d = 0;
  for (let i = 0; i < a.ink.length; i++) if (a.ink[i] !== b.ink[i]) d++;
  return d / a.ink.length;
}

/** ¿Contiene el raster un patrón de hueco (discontinuidad visible)? */
export function hasGaps(t: RasterTarget): boolean {
  // Barrido por filas: una fila con tinta en ambos extremos y un hueco
  // interior de ≥2 px demuestra discontinuidad (el glifo no engaña).
  for (let y = 0; y < t.h; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < t.w; x++) {
      if (t.ink[y * t.w + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0 && last > first + 4) {
      let gap = 0;
      for (let x = first; x <= last; x++) {
        if (!t.ink[y * t.w + x]) {
          gap++;
          if (gap >= 2) return true;
        } else gap = 0;
      }
    }
  }
  return false;
}

/** Peso medido: run VERTICAL máximo por columna — para líneas de referencia
 *  horizontales equivale al grosor de la línea en px. */
export function measuredWeight(t: RasterTarget): number {
  let best = 0;
  for (let x = 0; x < t.w; x++) {
    let run = 0;
    let maxRun = 0;
    for (let y = 0; y < t.h; y++) {
      if (t.ink[y * t.w + x]) {
        run++;
        if (run > maxRun) maxRun = run;
      } else run = 0;
    }
    if (maxRun > best) best = maxRun;
  }
  return best;
}
