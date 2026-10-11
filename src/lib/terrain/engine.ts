/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Motor de render isométrico (Canvas 2D, proyección ortográfica estilo Blender).
 *
 * Principios de "baja inferencia":
 *  - Cero WebGL / cero IA: solo Canvas 2D con líneas y vectores (paths y nodos).
 *  - Render bajo demanda: el bucle rAF se detiene cuando no hay interacción.
 *  - Culling por bounding box + LOD adaptativo por presupuesto de segmentos.
 *  - Curvas de nivel con caché Path2D + matriz afín por cota (F2): cero
 *    proyección JS de vértices por cuadro; el trazo ocurre en espacio
 *    dispositivo (anchos de línea uniformes).
 *  - DPR limitado a 2 y presupuesto menor en pantallas táctiles.
 *
 * Fase 2 (rendimiento):
 *  - F2-B: capa de contornos acumulable en OffscreenCanvas (con fallback a
 *    canvas desconectado) invalidada por clave numérica de vista — los
 *    redibujos con vista estable cuestan un solo drawImage.
 *  - F2-A: time-slicing con presupuesto de 8 ms/cuadro — maestras 25 m
 *    primero, intermedias 1 m por tandas; si la escena no termina en 2
 *    cuadros parciales, degradación adaptativa del intervalo (nunca jank).
 *  - Fase 4: paleta E-Ink (B/N puro) conmutada por `opts.eink`.
 *
 * Cámara: acimut (rotación Z) + elevación (inclinación) + zoom ortográfico + pan.
 * Convención: X=este, Y=norte, Z=cota (m s.n.m.). El norte es +Y.
 */

import type { Contours, Poly } from './contours';
import { sampleGrid, type TerrainModel } from './generator';
import { clamp } from './noise';
import { INEGI_SHEETS, formatDegMin, inegiCodesJoin } from './inegi';
import { buildLehmannSegs, lehmannStride } from './lehmann';
import {
  frictionPlacement,
  FRICTION_LEN_PX,
  frictionClassOf,
  type FrictionAnchor,
  type FrictionField,
} from '../ingest/friction';
import {
  drawGpsMarkerAt,
  type GpsMarkerInks,
  type GpsMarkerTone,
} from '../gps/marker';

export interface ViewOpts {
  /** curvas intermedias 1 m (con LOD automático) */
  minor: boolean;
  /** curvas maestras 25 m */
  major: boolean;
  /** malla base del MDT */
  mesh: boolean;
  /** nodos (vértices) del MDT */
  nodes: boolean;
  /** red de drenaje */
  streams: boolean;
  /** divisorias de aguas */
  divides: boolean;
  /** etiquetas de subcuencas */
  labels: boolean;
  /** cotas en maestras */
  cotas: boolean;
  /** marco cartográfico INEGI (crucetas, ticks minutales y sello) */
  inegi: boolean;
  /** rango de elevación visible [min,max] m s.n.m. */
  elevRange: [number, number];
  /** intervalo forzado de curvas intermedias; 0 = automático por presupuesto */
  forcedStep: number;
  /** F5 · relieve visual sin shaders: sombra vectorial de maestras (F5-01)
   *  + niebla de profundidad por elevación/zoom (F5-02). Solo orden de
   *  pintado y color: 0 shaders, 0 bucles por píxel, 0 trabajo por vértice. */
  reliefFx: boolean;
  /** modo tinta electrónica: lienzo B/N puro */
  eink: boolean;
  /** Modo Día (design-tokens.json day): lienzo claro para campo abierto,
   *  alta luz. Lo gobierna el tema de la UI (next-themes), no es una capa. */
  day: boolean;
  /** Modo Ahorro (F3): DPR 1 y tope de 30 cuadros/s durante interacción */
  powerSave: boolean;
  /** F5-03 · hachurado de pendiente (tramas Lehmann). Fase 1: SOLO export
   *  (SVG/PDF) — 0 ms en el canvas interactivo. La fase 2 (canvas) es #11. */
  hachures?: boolean;
  /** FR-5 · D12: tramas del campo de fricción (costo) bajo el linework.
   *  Requiere un campo activo (setFrictionField); guard 6 ms/8 ms igual que
   *  hachures. Sin 10.º bit en el hash de URL (retrocompat 9 bits). */
  friction?: boolean;
}

export interface HudInfo {
  azDeg: number;
  elDeg: number;
  zoom: number;
  /** intervalo efectivo de curvas intermedias (1 = 1 m real) */
  interval: number;
  drawnSegs: number;
  frameMs: number;
  idle: boolean;
  /** Modo Ahorro activo (manual o por batería baja, F3/F4) */
  save: boolean;
  /** #11 fase 2: hachurado interactivo activo (false = suprimido/fallback) */
  hachureActive: boolean;
  /** #11 fase 2: motivo del fallback a export-only ('' = activo) */
  hachureFallback: '' | 'guard' | 'frame';
  /** FR-5 · D12: tramas de fricción activas (false = sin campo/fallback) */
  frictionActive: boolean;
  /** FR-5 · motivo del fallback a export-only ('' = activo) */
  frictionFallback: '' | 'guard' | 'frame';
}

export type PresetName = 'iso' | 'top' | 'front' | 'side' | 'fit';

/**
 * Escena serializable para el export vectorial (SVG/PDF, §6.2 del roadmap).
 * Contiene TODO lo que el motor dibuja: modelo + curvas + opciones + cámara
 * del último cuadro + el estado efectivo de LOD, de modo que el export sea
 * un espejo exacto (WYSIWYG) de lo que hay en pantalla.
 */
export interface ExportScene {
  model: TerrainModel;
  contours: Contours;
  opts: ViewOpts;
  /** Cámara del último cuadro dibujado (proyección reproducible píxel-exacta). */
  cam: CamSnapshot;
  /** Intervalo efectivo de curvas intermedias (forzado o LOD activo). */
  step: number;
  /** Variante ligera activa para intermedias (ATOM-03, sub-píxel). */
  useLight: boolean;
  /** Color por bucket de gris de intermedias (agrupación F2). Con F5-02
   *  activo ya viene mezclado con la niebla (WYSIWYG). */
  bucketColor: string[];
  /** Nivel de niebla de profundidad efectivo (0 none · 1 moderada · 2 profunda). */
  fogIdx: number;
  /** FR-5 · D12: campo de fricción activo + anclaje escénico (WYSIWYG:
   *  el export emite la MISMA trama vía el MISMO núcleo Lehmann). */
  friction?: { field: FrictionField; anchor: FrictionAnchor } | null;
  /** FR-7 · GGM25: etiqueta del datum vertical vigente al export
   *  (WYSIWYG — el cajetín declara lo que la escena usa). null = el
   *  honesto «WGS84 (elipsoidal)» (FR-7 elipsoidal-declarado, ADR D10). */
  verticalDatum?: string | null;
}

/** Instantánea de cámara para overlays externos (ingesta GIS/CAD).
 *  Misma convención que la proyección interna: X=este, Y=norte, Z=cota. */
export interface CamSnapshot {
  az: number;
  el: number;
  zoom: number;
  panX: number;
  panY: number;
  /** píxeles por metro (baseScale × zoom) */
  pxPerM: number;
  w: number;
  h: number;
  dpr: number;
}

const ISO_EL = (35.264 * Math.PI) / 180;
const MINOR_STEPS = [1, 2, 5, 10, 20];
/** buckets del gradiente gris de curvas intermedias (agrupación de trazos) */
const MINOR_BUCKETS = 8;
/**
 * Umbral sub-píxel para la variante ligera de curvas (ATOM-03): se usa
 * `polysLight` solo cuando tol_ligera · pxPerM < LIGHT_PX ⇒ desviación
 * máxima garantizada < 1 px respecto a la variante fina.
 */
const LIGHT_PX = 1;

/* ---------------- Fase 2: time-slicing + capa acumulable ---------------- */

/** Contexto 2D admitido como destino de la capa de contornos. */
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Presupuesto de trazado por cuadro (ms) antes de ceder el cuadro (F2-A). */
const SLICE_MS = 8;
/** Ventana mínima entre cuadros dibujados en Modo Ahorro: tope ~30 cps (F3). */
const SAVE_FRAME_MS = 1000 / 30;
/**
 * Cuadros parciales tolerados a la misma vista antes de degradar el
 * intervalo (adaptación en el dominio del tiempo; nunca congela la UI).
 */
const SLICE_PARTIALS_MAX = 2;
/** Coste por segmento de respaldo (ms/seg) cuando aún no hay medición. */
const PER_SEG_MS = 0.000075;

const EL_MIN = -0.35;
const EL_MAX = 1.553;
const ZOOM_MIN = 0.12;
const ZOOM_MAX = 90;

/** Paleta estándar del lienzo (design tokens §0-b del README; única fuente).
 *  Fondo alineado al primitivo dark.background del sistema dual (#181C20). */
export const COLORS = {
  bg: '#181c20',
  mesh: 'rgba(113, 113, 122, 0.16)',
  frame: 'rgba(82, 82, 91, 0.55)',
  minor: '#7a7a85',
  major: '#f97316',
  /** F5-01 · sombra de maestras (alpha reducido, detrás del trazo principal) */
  majorShadow: 'rgba(9, 9, 11, 0.38)',
  cotaText: '#fdba74',
  stream: 'rgba(161, 161, 170, 0.5)',
  divide: '#fb923c',
  node: 'rgba(249, 115, 22, 0.6)',
  label: '#e4e4e7',
  inegiFrame: 'rgba(148, 148, 158, 0.55)',
  inegiText: 'rgba(190, 190, 198, 0.85)',
  inegiAccent: '#fdba74',
  gizmoBg: 'rgba(24, 28, 32, 0.72)',
  axisX: '#f97316',
  axisY: '#a1a1aa',
  axisZ: '#e4e4e7',
  halo: 'rgba(24, 28, 32, 0.9)',
  haloSoft: 'rgba(24, 28, 32, 0.85)',
  stampBg: 'rgba(24, 28, 32, 0.78)',
  stampBorder: 'rgba(82, 82, 91, 0.6)',
  stampSub: 'rgba(161, 161, 170, 0.9)',
  scale: 'rgba(228, 228, 231, 0.85)',
  /** F5-03 · tinta de hachurado (gris zinc sutil, bajo el linework) */
  hachure: 'rgba(113, 113, 122, 0.5)',
  /** A-8 · tinta del marcador GPS (fix de calidad / degradado) */
  gpsOk: '#22c55e',
  gpsWarn: '#f59e0b',
};

/**
 * Paleta E-Ink: tinta negra sobre papel blanco, sin grises
 * de relieve ni acentos de color. Mantiene los mismos anchos de línea y la
 * misma geometría: solo cambia el color del trazo.
 */
export const EINK_COLORS = {
  bg: '#ffffff',
  mesh: 'rgba(0, 0, 0, 0.14)',
  frame: 'rgba(0, 0, 0, 0.5)',
  minor: '#1c1c1c',
  major: '#000000',
  /** F5-01 · sin uso en E-Ink (la sombra se desactiva: tinta pura) */
  majorShadow: 'rgba(0, 0, 0, 0.16)',
  cotaText: '#000000',
  stream: 'rgba(0, 0, 0, 0.55)',
  divide: '#000000',
  node: 'rgba(0, 0, 0, 0.65)',
  label: '#000000',
  inegiFrame: 'rgba(0, 0, 0, 0.6)',
  inegiText: 'rgba(0, 0, 0, 0.8)',
  inegiAccent: '#000000',
  gizmoBg: 'rgba(255, 255, 255, 0.82)',
  axisX: '#000000',
  axisY: '#3f3f46',
  axisZ: '#000000',
  halo: 'rgba(255, 255, 255, 0.95)',
  haloSoft: 'rgba(255, 255, 255, 0.92)',
  stampBg: 'rgba(255, 255, 255, 0.85)',
  stampBorder: 'rgba(0, 0, 0, 0.5)',
  stampSub: 'rgba(0, 0, 0, 0.75)',
  scale: 'rgba(0, 0, 0, 0.85)',
  /** F5-03 · tinta de hachurado (negra 0.44 — técnica clásica Lehmann) */
  hachure: 'rgba(0, 0, 0, 0.44)',
  /** A-8 · marcador GPS en tinta pura (E-Ink: jerarquía por textura, no color) */
  gpsOk: '#000000',
  gpsWarn: 'rgba(0, 0, 0, 0.55)',
};

/**
 * Paleta Día (design-tokens.json · color.primitive.day): lienzo claro para
 * campo abierto con alta luz. El acento cartográfico (maestras/cotas) sube a
 * orange-600/700 por contraste sobre papel; el resto baja a grises de tinta
 * (stroke-vector-primary #666 / secondary #999 del sistema de tokens).
 * Misma geometría y anchos que COLORS: solo cambia el color del trazo.
 */
export const DAY_COLORS = {
  bg: '#efefef',
  mesh: 'rgba(102, 102, 102, 0.14)',
  frame: 'rgba(102, 102, 102, 0.5)',
  minor: '#8b8b90',
  major: '#ea580c',
  /** F5-01 · sombra de maestras sobre papel (alpha reducido) */
  majorShadow: 'rgba(63, 63, 70, 0.24)',
  cotaText: '#c2410c',
  stream: 'rgba(113, 113, 122, 0.55)',
  divide: '#ea580c',
  node: 'rgba(234, 88, 12, 0.65)',
  label: '#27272a',
  inegiFrame: 'rgba(113, 113, 122, 0.6)',
  inegiText: 'rgba(82, 82, 91, 0.9)',
  inegiAccent: '#c2410c',
  gizmoBg: 'rgba(255, 255, 255, 0.8)',
  axisX: '#ea580c',
  axisY: '#71717a',
  axisZ: '#3f3f46',
  halo: 'rgba(255, 255, 255, 0.92)',
  haloSoft: 'rgba(255, 255, 255, 0.88)',
  stampBg: 'rgba(255, 255, 255, 0.85)',
  stampBorder: 'rgba(0, 0, 0, 0.35)',
  stampSub: 'rgba(82, 82, 91, 0.9)',
  scale: 'rgba(63, 63, 70, 0.85)',
  /** F5-03 · tinta de hachurado (gris sobre papel, modo Día) */
  hachure: 'rgba(82, 82, 91, 0.5)',
  /** A-8 · marcador GPS (verde/ámbar de papel — contraste sobre #efefef) */
  gpsOk: '#15803d',
  gpsWarn: '#b45309',
};

interface FlyAnim {
  t0: number;
  dur: number;
  az0: number;
  az1: number;
  el0: number;
  el1: number;
  z0: number;
  z1: number;
  px0: number;
  px1: number;
  py0: number;
  py1: number;
}

export class IsoEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private onHud?: (h: HudInfo) => void;

  /** Callback por cuadro dibujado (overlays externos: ingesta GIS/CAD).
   *  Se emite UNA vez por redibujo del motor — 0 coste en reposo. */
  onFrame: ((cam: CamSnapshot) => void) | null = null;

  private model: TerrainModel | null = null;
  private contours: Contours | null = null;
  /** bucket de gris por nivel (agrupación de trazos: ≤ 8 strokes por cuadro) */
  private minorBucket: Uint8Array = new Uint8Array(0);
  private bucketColor: string[] = [];
  /** Colores base de los buckets ANTES de la niebla (F5-02). */
  private bucketBase: string[] = [];
  /** Niebla de profundidad efectiva del último cuadro (0 · 1 · 2, F5-02). */
  private fogIdx = 0;
  /** Último nivel de niebla aplicado a bucketColor (evita recomputar por cuadro). */
  private fogApplied = -1;
  private labelPoly: Int32Array = new Int32Array(0); // índice de polilínea más larga por nivel
  /** Path2D por polilínea en coords de mundo (cache entre cuadros, F2). */
  private polyPaths: Path2D[][] = [];
  /** Path2D de la variante ligera (ATOM-03); null si el modelo no la trae. */
  private polyPathsLight: Path2D[][] | null = null;

  opts: ViewOpts = {
    minor: true,
    major: true,
    mesh: true,
    nodes: false,
    streams: true,
    divides: true,
    labels: true,
    cotas: true,
    inegi: true,
    elevRange: [0, 9999],
    forcedStep: 0,
    reliefFx: true,
    eink: false,
    day: false,
    powerSave: false,
  };

  /** Paleta activa: E-Ink (B/N) > Día (campo abierto) > estándar nocturna. */
  private pal(): typeof COLORS {
    return this.opts.eink ? EINK_COLORS : this.opts.day ? DAY_COLORS : COLORS;
  }

  // cámara
  private az = -Math.PI / 4;
  private el = ISO_EL;
  private zoom = 1;
  private panX = 0;
  private panY = 0;

  // viewport
  private w = 0;
  private h = 0;
  private dpr = 1;
  private budget = 26000;

  // bucle
  private raf = 0;
  private lastT = 0;
  private lastDrawT = 0; // Modo Ahorro (F3): ventana de 30 cps
  private dirty = false;
  private anim: FlyAnim | null = null;
  private frameEma = 0;
  /* — #11 fase 2 · hachurado interactivo (condicionado, checkpoint
     ): geometría MUNDIAL cacheada por k; re-proyección por
     cuadro es la única carga (~2.4k segmentos). Guard: build > 6 ms ⇒
     fallback export-only. Auto-fallback por ATRIBUCIÓN de regresión
     (umbral = max(8, 1.2·línea base) sostenido ≥ 30 cuadros).
     MAX_SAMPLES 20k con k→doble. Sin 10.º bit en el hash de URL
     (retrocompat 9 bits verificada). */
  private hachureCache: { k: number; segs: Float32Array; count: number } | null = null;
  private hachureFallback: '' | 'guard' | 'frame' = '';
  private hachureSlowFrames = 0;
  private hachureDrawn = 0;
  /* EMA al momento de ACTIVAR hachures: el auto-fallback usa ATRIBUCIÓN de
     regresión — umbral = max(8, 1.2·línea base). En hardware cuyo baseline ya
     excede 8 ms (p. ej. bufa 106k segs ⇒ ~14 ms en el sandbox), un fallback
     estricto mataría la fase 2 siempre; la regresión atribuible a los
     hachures (≥ +20 %) es la señal honesta. Interpretación documentada en
     §9/bitácora de ingeniería — el propietario puede endurecirla a 8 ms estrictos. */
  private hachureBaselineEma = 0;
  /* — FR-5 · D12: tramas del campo de fricción — mismo esquema de guard
     y de fallback por atribución que el hachurado interactivo: build > 6 ms
     ⇒ export-only; EMA > max(8, 1.2·baseline) sostenida ≥ 30 cuadros ⇒
     reversión automática. La geometría es MUNDIAL (cacheada por k) y se
     DRapea sobre el grid del modelo activo (sampleGrid) — un campo es una
     propiedad DEL terreno. Sin 10.º bit en el hash de URL. */
  private frictionRef: { field: FrictionField; anchor: FrictionAnchor } | null = null;
  /* FR-7 · GGM25: etiqueta del datum vertical (DATO — el export la declara
     en el cajetín; la cota del GPS sigue siendo del dispositivo hasta que
     la unidad de cableo FR-7 la convierta con toOrthometric). */
  private datumRef: string | null = null;
  /* A-8 · marcador GPS: el fix es DATO de escena (W5) — el motor proyecta
     con su convención de marco (drawInegiFrame) y dibuja ≤ 8 nodos. */
  private gpsRef: {
    lat: number;
    lon: number;
    tone: GpsMarkerTone;
    anchor: { centerLat: number; centerLon: number; extentM: number };
  } | null = null;
  private frictionCache: { k: number; segs: Float32Array; count: number } | null = null;
  private frictionFallback: '' | 'guard' | 'frame' = '';
  private frictionSlowFrames = 0;
  private frictionBaselineEma = 0;
  private frictionDrawn = 0;
  private drawnSegs = 0;
  private lodIdx = 0;
  private lastHud = 0;
  private pendingRedraw = false;
  private lastMinorSegs = 0;
  private lastMaestraSegs = 0;
  /* DRAPE-1 · sello del modelo activo (++ en setModel) — la caché de drape
     del overlay se invalida cuando el terreno cambia (región/DEM real). */
  private modelRev = 0;

  /* --- Fase 2: capa acumulable (F2-B) + time-slicing (F2-A) --- */
  /** Capa de contornos: OffscreenCanvas o canvas desconectado (fallback). */
  private layer: { cnv: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx2D } | null = null;
  /** La capa corresponde a la vista actual y está completa (blit directo). */
  private layerReady = false;
  /** Segmentos de maestras del último pintado (para HUD en slicing). */
  private mastersSegs = 0;
  /** Estado de slicing: siguiente nivel menor y cuadros parciales acumulados. */
  private slice: { next: number; partials: number; segs: number } | null = null;
  /** Coste histórico por segmento (ms/seg) para la predicción de slicing. */
  private perSegEma = 0;
  /* Clave numérica de la vista asociada a la capa (comparación sin strings). */
  private kAz = NaN;
  private kEl = NaN;
  private kZoom = NaN;
  private kPx = NaN;
  private kPy = NaN;
  private kW = -1;
  private kH = -1;
  private kDpr = -1;
  private kStep = -1;
  private kLight = false;
  private kRMin = NaN;
  private kRMax = NaN;
  private kMinor = false;
  private kMajor = false;
  private kEink = false;
  private kDay = false;
  private kFog = -1;

  // F4: prefers-reduced-motion — sin inercia ni animaciones de vuelo
  private mqMotion: MediaQueryList | null = null;
  private reducedMotion = false;
  private onMotionChange = (): void => {
    this.reducedMotion = this.mqMotion?.matches ?? false;
  };

  // interacción
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private pinchMx = 0;
  private pinchMy = 0;
  private velAz = 0;
  private velEl = 0;
  private ro: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, onHud?: (h: HudInfo) => void) {
    this.canvas = canvas;
    this.onHud = onHud;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('dblclick', this.onDblClick);
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('visibilitychange', this.onVisibility);

    /* F4: consulta y suscripción a prefers-reduced-motion (con guardas: la
       media query no existe en entornos sin window.matchMedia). */
    if (typeof window.matchMedia === 'function') {
      this.mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = this.mqMotion.matches;
      this.mqMotion.addEventListener('change', this.onMotionChange);
    }

    this.resize();
  }

  dispose(): void {
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    window.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.mqMotion?.removeEventListener('change', this.onMotionChange);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  /**
   * F0 del roadmap 0 GPU: con la pestaña oculta se cancela el rAF pendiente
   * para dejar la CPU en cero. Al volver, el bucle se reanuda solo si había
   * trabajo pendiente (dirty) o animación en curso.
   */
  private onVisibility = (): void => {
    if (document.hidden) {
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      this.anim = null;
      this.velAz = 0;
      this.velEl = 0;
    } else {
      this.lastT = performance.now();
      if (this.dirty || this.slice) this.ensureRaf();
    }
  };

  setModel(model: TerrainModel, contours: Contours): void {
    this.model = model;
    this.modelRev++; // DRAPE-1: sello de modelo — invalida la caché de drape del overlay
    this.contours = contours;
    this.hachureCache = null; // nuevo terreno ⇒ geometría hachure inválida
    this.hachureFallback = '';
    this.hachureSlowFrames = 0;
    this.frictionCache = null; // nuevo terreno ⇒ drapeado de fricción inválido
    this.frictionFallback = '';
    this.frictionSlowFrames = 0;
    this.opts.elevRange = [Math.floor(contours.minV), Math.ceil(contours.maxV)];
    const span = Math.max(1, contours.maxV - contours.minV);
    // gradiente gris cuantizado en 8 buckets: niveles consecutivos comparten
    // estilo ⇒ se trazan en un solo beginPath/stroke (F2, batching)
    this.computeBuckets();
    this.minorBucket = new Uint8Array(contours.levels.length);
    contours.levels.forEach((l, i) => {
      const t = (l.v - contours.minV) / span;
      this.minorBucket[i] = Math.min(MINOR_BUCKETS - 1, Math.max(0, Math.floor(t * MINOR_BUCKETS)));
    });
    this.labelPoly = new Int32Array(contours.levels.length);
    contours.levels.forEach((l, i) => {
      let best = 0;
      for (let p = 1; p < l.polys.length; p++) if (l.polys[p].n > l.polys[best].n) best = p;
      this.labelPoly[i] = best;
    });
    this.buildPolyPaths();
    this.budget = this.computeBudget(this.canvas.clientWidth);
    this.lodIdx = 0;
    this.slice = null;
    this.layerReady = false;
    this.fitView();
  }

  /* ---------------- DRAPE-1 · acceso al MDT activo ----------------
     El overlay drapea los features SIN cota sobre el terreno vivo
     (directiva ): el motor expone el muestreo
     bilineal + el sello de modelo que invalida la caché. 0 estado nuevo
     en el overlay: el sampler es lectura pura del grid. */

  /** Muestreo bilineal del MDT activo (sampleGrid, total por clamp al
   *  borde). Sin modelo ⇒ NaN (el overlay cae a proyección neutra). */
  sampleTerrainZ(xM: number, yM: number): number {
    return this.model ? sampleGrid(this.model.grid, xM, yM) : NaN;
  }

  /** Sello del modelo activo: cambia ⇒ cachés de drape inválidas. */
  terrainStamp(): number {
    return this.modelRev;
  }

  /** Celda del MDT activo en m (paso máximo de densificación = cellM/2). */
  terrainCellM(): number {
    return this.model ? this.model.grid.cell : NaN;
  }

  setOpts(o: Partial<ViewOpts>): void {
    /* Modo Ahorro (F3): cambia el DPR ⇒ re-layout del lienzo (resize ya
       redibuja y la capa acumulable se invalida por la clave kDpr). */
    const psChanged = o.powerSave !== undefined && o.powerSave !== this.opts.powerSave;
    /* Modo Día: recolorea los buckets de intermedias (la capa acumulable se
       invalida por la clave kDay, mismo patrón que kEink). */
    const dayChanged = o.day !== undefined && o.day !== this.opts.day;
    /* #11 fase 2: re-activar el toggle reintenta el guard (medición fresca)
       y captura la línea base EMA para el umbral de regresión. */
    if (o.hachures !== undefined && o.hachures !== (this.opts.hachures ?? false)) {
      this.hachureFallback = '';
      this.hachureSlowFrames = 0;
      this.hachureBaselineEma = this.frameEma;
    }
    /* FR-5 · D12: re-activar el toggle reintenta el guard (medición fresca)
       y captura la línea base EMA para el umbral de regresión. */
    if (o.friction !== undefined && o.friction !== (this.opts.friction ?? false)) {
      this.frictionFallback = '';
      this.frictionSlowFrames = 0;
      this.frictionBaselineEma = this.frameEma;
    }
    Object.assign(this.opts, o);
    if (psChanged) {
      this.resize();
      return;
    }
    if (dayChanged) this.computeBuckets();
    this.requestDraw();
  }

  /**
   * Gradiente gris de curvas intermedias cuantizado en 8 buckets.
   * Dark: bajo→claro (tinta que emerge del fondo nocturno). Día: invertido
   * (cota alta = tinta más densa sobre papel). E-Ink no lo usa (usa pal().minor).
   */
  private computeBuckets(): void {
    this.bucketBase = [];
    for (let b = 0; b < MINOR_BUCKETS; b++) {
      const t = (b + 0.5) / MINOR_BUCKETS;
      if (this.opts.day) {
        const g = Math.round(216 - t * 120);
        this.bucketBase.push(`rgb(${g},${g},${g - 4})`);
      } else {
        const g = Math.round(96 + t * 120);
        this.bucketBase.push(`rgb(${g},${g},${g + 4})`);
      }
    }
    this.fogApplied = -1; // fuerza recolor de niebla en el próximo cuadro
    this.applyFog();
  }

  /**
   * F5-02 · Nivel de niebla por zoom: 0 = sin niebla (zoom de trabajo),
   * 1 = moderada al alejar, 2 = profunda en zoom-out extremo. E-Ink la
   * desactiva (tinta pura). Cuantizada en 3 niveles para que la capa
   * acumulable (F2-B) solo se invalida al cruzar un umbral de zoom.
   */
  private fogLevel(): number {
    if (!this.opts.reliefFx || this.opts.eink) return 0;
    return this.zoom < 0.45 ? 2 : this.zoom < 0.75 ? 1 : 0;
  }

  /**
   * F5-02 · Niebla de profundidad por elevación: mezcla el color de cada
   * bucket de intermedias hacia el fondo — las cotas bajas se desvanecen
   * antes — con O(8) operaciones por cambio de nivel. Cero cálculo por
   * vértice en el hilo principal (reutiliza la agrupación de buckets F2).
   */
  private applyFog(): void {
    const fog = this.fogLevel();
    this.fogIdx = fog;
    if (fog === this.fogApplied && this.bucketColor.length === this.bucketBase.length) return;
    this.fogApplied = fog;
    this.bucketColor = this.bucketBase.slice();
    if (fog === 0 || this.bucketColor.length !== MINOR_BUCKETS) return;
    const bg = this.pal().bg;
    const bgRgb = [
      parseInt(bg.slice(1, 3), 16),
      parseInt(bg.slice(3, 5), 16),
      parseInt(bg.slice(5, 7), 16),
    ];
    const strength = fog === 2 ? 0.72 : 0.4;
    for (let b = 0; b < MINOR_BUCKETS; b++) {
      const mm = /rgb\((\d+),(\d+),(\d+)\)/.exec(this.bucketBase[b]);
      if (!mm) continue;
      const t = strength * (1 - b / (MINOR_BUCKETS - 1));
      const r = Math.round(Number(mm[1]) + (bgRgb[0] - Number(mm[1])) * t);
      const g = Math.round(Number(mm[2]) + (bgRgb[1] - Number(mm[2])) * t);
      const bl = Math.round(Number(mm[3]) + (bgRgb[2] - Number(mm[3])) * t);
      this.bucketColor[b] = `rgb(${r},${g},${bl})`;
    }
  }

  /**
   * Preconstruye un Path2D en coordenadas de mundo por cada polilínea
   * (una sola vez por modelo, ~100 k vértices ⇒ pocos ms). Como cada curva
   * vive a cota constante, la proyección ortográfica es una transform afín:
   * por cuadro basta componer el path cacheado con la matriz del nivel
   * (Path2D.addPath) sin reproyectar vértice por vértice en JS.
   */
  private buildPolyPaths(): void {
    const cont = this.contours;
    if (!cont) {
      this.polyPaths = [];
      this.polyPathsLight = null;
      return;
    }
    const hasLight = cont.levels.some((l) => l.polysLight !== undefined);
    const lightPaths: Path2D[][] | null = hasLight ? new Array(cont.levels.length) : null;
    const paths: Path2D[][] = new Array(cont.levels.length);
    for (let li = 0; li < cont.levels.length; li++) {
      const lvl = cont.levels[li];
      const build = (polys: Poly[]): Path2D[] => {
        const arr = new Array<Path2D>(polys.length);
        for (let pi = 0; pi < polys.length; pi++) {
          const p = polys[pi];
          const path = new Path2D();
          path.moveTo(p.pts[0], p.pts[1]);
          for (let i = 1; i < p.n; i++) path.lineTo(p.pts[i * 2], p.pts[i * 2 + 1]);
          arr[pi] = path;
        }
        return arr;
      };
      paths[li] = build(lvl.polys);
      if (lightPaths) lightPaths[li] = build(lvl.polysLight ?? []);
    }
    this.polyPaths = paths;
    this.polyPathsLight = lightPaths;
  }

  /**
   * Presupuesto de segmentos según dispositivo (F2-C, degradación adaptativa):
   * base por tamaño de pantalla, atenuado por hardwareConcurrency y
   * deviceMemory cuando se detecta gama baja. Acotado a [10k, 72k].
   */
  private computeBudget(widthPx: number): number {
    let budget = widthPx < 768 ? 26000 : 60000;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = nav.hardwareConcurrency ?? 8;
    const mem = nav.deviceMemory ?? 8;
    if (cores <= 2) budget *= 0.5;
    else if (cores <= 4) budget *= 0.75;
    if (mem <= 2) budget *= 0.6;
    else if (mem <= 4) budget *= 0.8;
    return Math.round(Math.min(72000, Math.max(10000, budget)));
  }

  /* ---------------- cámara / navegación ---------------- */

  private baseScale(): number {
    const ext = this.model ? this.model.region.extent : 6000;
    return Math.min(this.w, this.h) / (ext * 1.18);
  }

  private pxPerM(): number {
    return this.baseScale() * this.zoom;
  }

  fitView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.az = -Math.PI / 4;
    this.el = ISO_EL;
    this.requestDraw();
  }

  applyPreset(p: PresetName): void {
    if (!this.model) return;
    const r = this.model.region;
    switch (p) {
      case 'iso':
        this.flyTo(0, 0, 0, r.extent * 0.44, -Math.PI / 4, ISO_EL);
        break;
      case 'fit':
        this.flyTo(0, 0, 0, r.extent * 0.44, this.az, this.el);
        break;
      case 'top':
        this.flyTo(0, 0, 0, r.extent * 0.44, this.az, 1.535);
        break;
      case 'front':
        this.flyTo(0, 0, 0, r.extent * 0.44, 0, 0.06);
        break;
      case 'side':
        this.flyTo(0, 0, 0, r.extent * 0.44, Math.PI / 2, 0.06);
        break;
    }
  }

  flyToBasin(i: number): void {
    if (!this.model) return;
    const b = this.model.basins[i];
    if (!b) return;
    const z = sampleGrid(this.model.grid, b.cx, b.cy);
    this.flyTo(b.cx, b.cy, z, b.r * 1.25, this.az, ISO_EL);
  }

  /**
   * B-D1 · API WC (U4): vuelo suave a un BBox ESCÉNICO (metros, centro
   * relativo al centro de la región activa; convención X=este, Y=norte de
   * CamSnapshot). La conversión WGS84→metros vive en el llamador (aprox.
   * lineal del marco INEGI — la misma de pickTerrain). El azimut se conserva
   * (no re-orienta: menos sorpresa para el embedder) y el radio se acota con
   * un floor de extent·0.02 (anti zoom-absurdo).
   */
  flyToBBoxM(cx: number, cy: number, radiusM: number): void {
    if (!this.model) return;
    const r = this.model.region;
    const lim = r.extent / 2;
    const x = clamp(cx, -lim, lim);
    const y = clamp(cy, -lim, lim);
    const z = sampleGrid(this.model.grid, x, y);
    this.flyTo(x, y, z, Math.max(radiusM, r.extent * 0.02), this.az, ISO_EL);
  }

  nudge(d: { dAz?: number; dEl?: number; dZoom?: number }): void {
    if (d.dAz) this.az += d.dAz;
    if (d.dEl) this.el = clamp(this.el + d.dEl, EL_MIN, EL_MAX);
    if (d.dZoom) this.zoom = clamp(this.zoom * (1 + d.dZoom), ZOOM_MIN, ZOOM_MAX);
    this.anim = null;
    this.velAz = 0;
    this.velEl = 0;
    this.requestDraw();
  }

  /** Animación suave hacia un punto del terreno (easing cúbico) */
  private flyTo(x: number, y: number, z: number, radiusM: number, az: number, el: number): void {
    const base = this.baseScale();
    const targetPxPerM = Math.min(this.w, this.h) / (radiusM * 2.6);
    const z1 = clamp(targetPxPerM / base, ZOOM_MIN, ZOOM_MAX);
    const S1 = base * z1;
    const az1 = az;
    const el1 = clamp(el, EL_MIN, EL_MAX);
    const c = Math.cos(az1);
    const s = Math.sin(az1);
    const es = Math.sin(el1);
    const ec = Math.cos(el1);
    const rx = x * c - y * s;
    const ry = x * s + y * c;
    const px1 = -rx * S1;
    const py1 = (ry * es + z * ec) * S1;

    /* F4: prefers-reduced-motion — sin animación de vuelo: la cámara salta
       al objetivo en un solo cuadro (mismo destino, cero interpolación). */
    if (this.reducedMotion) {
      this.anim = null;
      this.az = az1;
      this.el = el1;
      this.zoom = z1;
      this.panX = px1;
      this.panY = py1;
      this.requestDraw();
      return;
    }

    let dAz = az1 - this.az;
    while (dAz > Math.PI) dAz -= Math.PI * 2;
    while (dAz < -Math.PI) dAz += Math.PI * 2;

    this.anim = {
      t0: performance.now(),
      dur: 750,
      az0: this.az,
      az1: this.az + dAz,
      el0: this.el,
      el1,
      z0: Math.log(this.zoom),
      z1: Math.log(z1),
      px0: this.panX,
      px1,
      py0: this.panY,
      py1,
    };
    this.velAz = 0;
    this.velEl = 0;
    this.requestDraw();
  }

  /* ---------------- proyección ---------------- */

  // sx = w/2 + (x*cos(az) - y*sin(az))*S + panX
  // sy = h/2 - ((x*sin(az) + y*cos(az))*sin(el) + z*cos(el))*S + panY
  // (el=90°: norte (+Y) hacia arriba; el=0°: +Z hacia arriba)

  /* ---------------- bucle de render ---------------- */

  private requestDraw(): void {
    this.dirty = true;
    this.ensureRaf();
  }

  private ensureRaf(): void {
    if (!this.raf) {
      this.lastT = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  private tick = (t: number): void => {
    this.raf = 0;
    /* F3 · Modo Ahorro: tope de 30 cps — los cuadros intermedios se ceden
       (rAF reagenda hasta la ventana de 33 ms) sin tocar lastT, de modo que
       la animación (tiempo absoluto) y la inercia (dt) no se perturban. */
    if (this.opts.powerSave && t - this.lastDrawT < SAVE_FRAME_MS - 1) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    this.lastDrawT = t;
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;
    let active = false;

    if (this.anim) {
      const a = this.anim;
      let k = (t - a.t0) / a.dur;
      if (k >= 1) {
        k = 1;
        this.anim = null;
      } else {
        active = true;
      }
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.az = a.az0 + (a.az1 - a.az0) * e;
      this.el = a.el0 + (a.el1 - a.el0) * e;
      this.zoom = Math.exp(a.z0 + (a.z1 - a.z0) * e);
      this.panX = a.px0 + (a.px1 - a.px0) * e;
      this.panY = a.py0 + (a.py1 - a.py0) * e;
      this.dirty = true;
    } else if (!this.reducedMotion && (Math.abs(this.velAz) > 2 || Math.abs(this.velEl) > 2)) {
      // F4: con prefers-reduced-motion la inercia no se aplica
      this.az -= this.velAz * 0.005 * dt;
      this.el = clamp(this.el - this.velEl * 0.005 * dt, EL_MIN, EL_MAX);
      const decay = Math.exp(-dt * 4.2);
      this.velAz *= decay;
      this.velEl *= decay;
      this.dirty = true;
      active = true;
    } else {
      this.velAz = 0;
      this.velEl = 0;
    }

    if (this.dirty || this.slice !== null) {
      const t0 = performance.now();
      this.draw();
      const ms = performance.now() - t0;
      this.frameEma = this.frameEma === 0 ? ms : this.frameEma * 0.85 + ms * 0.15;
      this.dirty = false;
      /* #11 fase 2 · auto-fallback por ATRIBUCIÓN: frameEma > max(8 ms,
         1.2·línea base) sostenido ≥ 30 cuadros con hachures interactivos ⇒
         export-only (reversión automática aprobada). Contador se reinicia
         al bajar del umbral. */
      if (this.opts.hachures && this.hachureFallback === '') {
        const thr = Math.max(8, this.hachureBaselineEma * 1.2);
        if (this.frameEma > thr) {
          this.hachureSlowFrames++;
          if (this.hachureSlowFrames >= 30) {
            this.hachureFallback = 'frame';
            this.hachureSlowFrames = 0;
            this.dirty = true; // redibujar sin hachures
          }
        } else if (this.frameEma > 0) {
          this.hachureSlowFrames = 0;
        }
      }
      /* FR-5 · D12: auto-fallback por ATRIBUCIÓN del campo de fricción —
         mismo esquema: EMA > max(8 ms, 1.2·baseline) sostenida ≥ 30 cuadros */
      if (this.opts.friction && this.frictionRef && this.frictionFallback === '') {
        const thr = Math.max(8, this.frictionBaselineEma * 1.2);
        if (this.frameEma > thr) {
          this.frictionSlowFrames++;
          if (this.frictionSlowFrames >= 30) {
            this.frictionFallback = 'frame';
            this.frictionSlowFrames = 0;
            this.dirty = true; // redibujar sin tramas
          }
        } else if (this.frameEma > 0) {
          this.frictionSlowFrames = 0;
        }
      }
      // overlay externo (ingesta GIS/CAD): misma cadencia que el motor
      if (this.onFrame) this.onFrame(this.snapshotCam());
      // el LOD cambió durante el dibujo: redibujar ya con el nuevo intervalo
      if (this.pendingRedraw) {
        this.pendingRedraw = false;
        this.dirty = true;
      }
    }

    const now = performance.now();
    const continuing = active || this.dirty || this.slice !== null;
    // emitir también al DETENERSE el bucle: el HUD debe reflejar el estado final
    if (active || now - this.lastHud > 180 || !continuing) {
      this.lastHud = now;
      this.emitHud(!continuing);
    }
    if (continuing) this.ensureRaf();
  };

  private emitHud(idle: boolean): void {
    if (!this.onHud) return;
    const azDeg = ((((this.az * 180) / Math.PI) % 360) + 360) % 360;
    const elDeg = (this.el * 180) / Math.PI;
    this.onHud({
      azDeg,
      elDeg,
      zoom: this.zoom,
      interval: this.opts.forcedStep > 0 ? this.opts.forcedStep : MINOR_STEPS[this.lodIdx],
      drawnSegs: this.drawnSegs,
      frameMs: this.frameEma,
      idle,
      save: this.opts.powerSave,
      hachureActive: !!(this.opts.hachures && this.hachureFallback === ''),
      hachureFallback: this.hachureFallback,
      frictionActive: !!(
        this.opts.friction &&
        this.frictionRef &&
        this.frictionFallback === ''
      ),
      frictionFallback: this.frictionFallback,
    });
  }

  /**
   * Cámara fija desde fuera (estado de vista por URL, §6.2): restaura acimut,
   * elevación, zoom y pan con las mismas cotas que la interacción.
   */
  setCamera(az: number, el: number, zoom: number, panX: number, panY: number): void {
    this.az = az;
    this.el = clamp(el, EL_MIN, EL_MAX);
    this.zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    this.panX = panX;
    this.panY = panY;
    this.anim = null;
    this.velAz = 0;
    this.velEl = 0;
    this.requestDraw();
  }

  /**
   * Escena completa para el export vectorial (§6.2): el intervalo y la
   * variante ligera son los EFECTIVOS del último cuadro, de modo que el
   * SVG/PDF contiene exactamente la geometría visible.
   *
   * A-9 (FR-6 · aditivo, sin cambio para llamadas sin argumento): `pres`
   * restaura llaves de PRESENTACIÓN del lienzo (eink/mesh/nodes/reliefFx/
   * powerSave/forcedStep — el modo campo solo viste el lienzo, no la escena)
   * para el snapshot: paleta/niebla se hornean en bucketColor y un parche
   * posterior de opts no alcanza. Estado vivo re-establecido BYTE-EXACTO
   * (opts + bucketBase + bucketColor + fogApplied guardados y devueltos) en
   * el mismo turno síncrono: 0 cuadros intermedios, 0 parpadeo.
   */
  getExportScene(pres?: Partial<ViewOpts>): ExportScene | null {
    if (!this.model || !this.contours) return null;
    const restore = pres && Object.keys(pres).length > 0;
    const savedOpts = restore ? { ...this.opts } : null;
    const savedBucketBase = restore ? this.bucketBase.slice() : null;
    const savedBucketColor = restore ? this.bucketColor.slice() : null;
    const savedFogApplied = restore ? this.fogApplied : 0;
    if (restore && savedOpts) {
      Object.assign(this.opts, pres);
      this.computeBuckets(); // re-expresa buckets con la paleta restaurada (fogApplied = -1)
    }
    const forced = this.opts.forcedStep > 0;
    const step = forced ? this.opts.forcedStep : MINOR_STEPS[this.lodIdx];
    const lightTol = this.contours.lightTol;
    const useLight = lightTol > 0 && lightTol * this.pxPerM() < LIGHT_PX;
    this.applyFog(); // WYSIWYG: el export recibe los colores ya con niebla
    const scene = {
      model: this.model,
      contours: this.contours,
      opts: { ...this.opts },
      cam: this.snapshotCam(),
      step,
      useLight,
      bucketColor: this.bucketColor.slice(),
      fogIdx: this.fogIdx,
      friction: this.frictionRef,
      verticalDatum: this.datumRef,
    };
    if (restore && savedOpts && savedBucketBase && savedBucketColor) {
      Object.assign(this.opts, savedOpts);
      this.bucketBase = savedBucketBase;
      this.bucketColor = savedBucketColor;
      this.fogApplied = savedFogApplied;
    }
    return scene;
  }

  /** Instantánea de cámara sincronizada con el último cuadro dibujado. */
  snapshotCam(): CamSnapshot {
    return {
      az: this.az,
      el: this.el,
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
      pxPerM: this.pxPerM(),
      w: this.w,
      h: this.h,
      dpr: this.dpr,
    };
  }

  /**
   * Muestreo puntual sobre el terreno (Motor DEM Real, Task 18): invierte la
   * proyección ortográfica en el plano horizontal a cota desconocida — se
   * itera dos veces partiendo de la cota mínima (convergencia inmediata al
   * ser la proyección afín). Devuelve mundo (m) + geográfica (grados, misma
   * aproximación lineal que el marco INEGI), o null fuera del recorte.
   */
  pickTerrain(pxCss: number, pyCss: number): { x: number; y: number; z: number; lon: number; lat: number } | null {
    if (!this.model || this.w === 0) return null;
    const es = Math.sin(this.el);
    if (es < 0.08) return null; // vista casi horizontal: el plano degenera
    const S = this.pxPerM();
    const c = Math.cos(this.az);
    const s = Math.sin(this.az);
    const ec = Math.cos(this.el);
    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    const g = this.model.grid;
    const half = ((g.n - 1) / 2) * g.cell;

    const u = (pxCss - w2) / S;
    const V = (h2 - pyCss) / S;
    let z = g.min;
    let x = 0;
    let y = 0;
    for (let it = 0; it < 3; it++) {
      const v = (V - z * ec) / es;
      x = u * c + v * s;
      y = v * c - u * s;
      if (Math.abs(x) > half * 1.6 || Math.abs(y) > half * 1.6) return null;
      z = sampleGrid(g, x, y);
    }
    const r = this.model.region;
    const rad = (r.centerLat * Math.PI) / 180;
    const lon = r.centerLon + x / (111320 * Math.cos(rad));
    const lat = r.centerLat + y / 111320;
    return { x, y, z, lon, lat };
  }

  /** Redibuja en el siguiente cuadro (p. ej. al llegar geometría ingestada). */
  redraw(): void {
    this.requestDraw();
  }

  /**
   * Techo duro del backing store (Task 61 — kill-switch de la clase
   * «layout-sin-CSS»): si el canvas pierde su posicionamiento (regresión de
   * estilos, shadow root sin hojas) cae en flujo normal y su atributo
   * height INFLA al padre ⇒ ResizeObserver ⇒ resize() ⇒ crecimiento
   * ~exponencial ×dpr hasta buffers impintables (1118×2^25, terreno en
   * blanco). El clamp convierte cualquier regresión futura en degradación
   * ACOTADA — jamás un buffer por encima del máximo renderizable.
   * 16384 = techo universal del stack 2D (≤ max texture/render de GPU).
   */
  private static readonly MAX_BACKING = 16384;

  private resize(): void {
    const parent = this.canvas.parentElement;
    const cw = parent ? parent.clientWidth : this.canvas.clientWidth;
    const ch = parent ? parent.clientHeight : this.canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    // F3 · Modo Ahorro: DPR fijo en 1 (la calidad la recompone el trazo vectorial)
    this.dpr = this.opts.powerSave ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    // Clamp de la clase «layout-sin-CSS» (Task 61): el espacio lógico se
    // deriva del backing REAL (w = backing/dpr) para que setTransform(dpr)
    // siga siendo exacto aunque el clamp engage.
    const bw = Math.min(Math.round(cw * this.dpr), IsoEngine.MAX_BACKING);
    const bh = Math.min(Math.round(ch * this.dpr), IsoEngine.MAX_BACKING);
    this.w = Math.round(bw / this.dpr);
    this.h = Math.round(bh / this.dpr);
    this.canvas.width = bw;
    this.canvas.height = bh;
    this.budget = this.computeBudget(this.w);
    this.requestDraw();
  }

  /* ---------------- dibujo ---------------- */

  private draw(): void {
    const { ctx } = this;
    if (!this.model || !this.contours || this.w === 0) return;
    const C = this.pal();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const S = this.pxPerM();
    const c = Math.cos(this.az);
    const s = Math.sin(this.az);
    const es = Math.sin(this.el);
    const ec = Math.cos(this.el);
    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    this.drawnSegs = 0;
    this.lastMaestraSegs = 0;

    const sx = (x: number, y: number): number => w2 + (x * c - y * s) * S;
    const sy = (x: number, y: number, z: number): number => h2 - ((x * s + y * c) * es + z * ec) * S;

    this.drawMesh(sx, sy);
    if (this.opts.inegi) this.drawInegiFrame(sx, sy);
    this.applyFog(); // F5-02: colores de bucket vigentes para este zoom
    if (this.opts.hachures && this.hachureFallback === '') this.drawHachures(sx, sy);
    /* FR-5 · D12: tramas de fricción DEBAJO del linework (coexistencia D11) */
    if (this.opts.friction && this.frictionFallback === '' && this.frictionRef) this.drawFriction(sx, sy);
    this.drawContours(S, c, s, es, ec);
    if (this.opts.streams) this.drawStreams(sx, sy);
    if (this.opts.divides) this.drawDivides(sx, sy);
    if (this.opts.nodes) this.drawNodes(sx, sy);
    if (this.opts.labels) this.drawBasinLabels(sx, sy);
    if (this.gpsRef) this.drawGpsMarker(sx, sy);
    this.drawGizmo();
    this.drawScaleBar();
    if (this.opts.inegi) this.drawInegiStamp();
  }

  /**
   * #11 fase 2 · Geometría hachure MUNDIAL (cacheada por k). FR-5: el bloque
   * legacy (duplicado del export) pasa POR EL NÚCLEO LEHMANN puro
   * (lehmann.ts) con los parámetros legacy — paridad byte-idéntica exigida
   * por test (tests/forense_lehmann.test.ts). Dirección de máximo descenso,
   * longitud ∝ pendiente (min(1.5+s·24, 9) px), extremos rebajados.
   * Stride 6: [x0,y0,z0, x1,y1,z1] en metros/cota — sin proyección.
   */
  private buildHachureGeometry(k: number): { segs: Float32Array; count: number; buildMs: number } {
    const g = this.model!.grid;
    const n = g.n;
    return buildLehmannSegs(g.h, n, {
      k,
      cellXm: g.cell,
      cellYm: g.cell,
      originI: -(n - 1) / 2,
      originJ: -(n - 1) / 2,
      originX: 0,
      originY: 0,
      metersPerPx: 1 / (this.pxPerM() || 0.08),
      maxCount: 20000,
      lenPx: (_v, s) => Math.min(1.5 + s * 24, 9),
      skip: (_v, s) => s < 0.04,
      zPair: (v, s, hm) => [v + s * hm, v - s * hm],
    });
  }

  /**
   * #11 fase 2 · Capa hachure en el canvas: re-proyección de la geometría
   * cacheada (solo matemática de cámara + culling), 1 op de stroke.
   * Guard aprobado: si el BUILD (>6 ms) excede el presupuesto, fallback
   * export-only. La longitud/pendiente NO dependen del zoom de pantalla —
   * son mundo — pero k (espaciado objetivo 11 px) sí: al cruzar cambia k y
   * se reconstruye (medición de guard en cada reconstrucción).
   */
  private drawHachures(sx: (x: number, y: number) => number, sy: (x: number, y: number, z: number) => number): void {
    const g = this.model!.grid;
    const n = g.n;
    const metersPerPx = 1 / (this.pxPerM() || 0.08);
    const k = lehmannStride(n, g.cell, 11, metersPerPx, 20000);
    let cache = this.hachureCache;
    if (!cache || cache.k !== k) {
      const built = this.buildHachureGeometry(k);
      cache = { k, segs: built.segs, count: built.count };
      this.hachureCache = cache;
      if (built.buildMs > 6) {
        // condición #11: guard > 6 ms verificado ⇒ fallback export-only
        this.hachureFallback = 'guard';
        this.hachureDrawn = 0;
        this.dirty = true; // redibujar ya sin hachures
        return;
      }
    }
    const { ctx } = this;
    const pad = 24;
    const S = this.pxPerM();
    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    ctx.beginPath();
    let drawn = 0;
    const segs = cache.segs;
    for (let i = 0; i < cache.count; i++) {
      const x0 = segs[i * 6];
      const y0 = segs[i * 6 + 1];
      const z0 = segs[i * 6 + 2];
      // culling por punto central proyectado (pad 24 px, igual que export)
      const px = w2 + (x0 * Math.cos(this.az) - y0 * Math.sin(this.az)) * S;
      if (px < -pad || px > this.w + pad) continue;
      const x1 = segs[i * 6 + 3];
      const y1 = segs[i * 6 + 4];
      const z1 = segs[i * 6 + 5];
      ctx.moveTo(sx(x0, y0), sy(x0, y0, z0));
      ctx.lineTo(sx(x1, y1), sy(x1, y1, z1));
      drawn++;
    }
    ctx.strokeStyle = this.pal().hachure;
    ctx.lineWidth = 0.7;
    ctx.stroke();
    this.hachureDrawn = drawn;
    this.drawnSegs += drawn;
  }

  /* ---------------- FR-5 · D12: campo de fricción ---------------- */

  /**
   * A-8 · marcador GPS (débito FR-7). Recibe el fix como DATO — el motor
   * NUNCA toca geolocation (W3: eso vive en gpsController) ni persiste nada
   * (I-6). fix=null ⇒ marcador ausente. Redibujo inmediato.
   */
  setGpsMarker(
    fix: { lat: number; lon: number; tone: GpsMarkerTone } | null,
    anchor: { centerLat: number; centerLon: number; extentM: number } | null
  ): void {
    this.gpsRef = fix && anchor ? { ...fix, anchor } : null;
    this.requestDraw();
  }

  /**
   * Campo de fricción activo (o null para retirarlo). El anclaje escénico
   * (centro de la región activa) vive fuera del campo: al cambiar de región
   * el visor re-aplica. Reinicia caché, guard y baseline (medición fresca).
   */
  setFrictionField(field: FrictionField | null, anchor: FrictionAnchor | null): void {
    this.frictionRef = field && anchor ? { field, anchor } : null;
    this.frictionCache = null;
    this.frictionFallback = '';
    this.frictionSlowFrames = 0;
    this.frictionBaselineEma = this.frameEma;
    this.requestDraw();
  }

  /**
   * FR-7 · GGM25: etiqueta del datum vertical vigente (DATO de escena, no
   * de render — `null` = «WGS84 (elipsoidal)», la declaración honesta de
   * FR-7 sin geoides). El cajetín del export la refleja (WYSIWYG).
   */
  setVerticalDatum(label: string | null): void {
    if (this.datumRef === label) return; // idempotente (efectos de React)
    this.datumRef = label;
  }

  /**
   * FR-5 · Geometría de tramas de fricción MUNDIAL vía el NÚCLEO LEHMANN
   * (lehmann.ts — el mismo que el export): campo de costo → clase D12 →
   * longitud; dirección = eje del gradiente de costo; trazo DRapeado sobre
   * el grid del modelo activo (sampleGrid). NODATA: celda y stencil fuera.
   */
  private buildFrictionGeometry(k: number): { segs: Float32Array; count: number; buildMs: number } {
    const ref = this.frictionRef!;
    const f = ref.field;
    const g = this.model!.grid;
    const pl = frictionPlacement(f, ref.anchor);
    return buildLehmannSegs(f.data, f.w, {
      k,
      cellXm: pl.cellXm,
      cellYm: pl.cellYm,
      originI: 0,
      originJ: 0,
      originX: pl.originX,
      originY: pl.originY,
      metersPerPx: 1 / (this.pxPerM() || 0.08),
      maxCount: 20000,
      lenPx: (v) => FRICTION_LEN_PX[frictionClassOf(v, f.vmin, f.vmax)],
      skip: (v, s) =>
        s < 1e-9 || frictionClassOf(v, f.vmin, f.vmax) === 0,
      zPair: (_v, _s, _hm, _ux, _uy, x, y) => {
        const z = sampleGrid(g, x, y);
        return [z, z];
      },
      nodata: (v) =>
        Number.isNaN(v) || (f.nodata !== null && (v === f.nodata || Number.isNaN(f.nodata))),
    });
  }

  /**
   * FR-5 · Capa de tramas de fricción en el canvas: DEBAJO del linework
   * (se llama antes de drawContours). Guard idéntico al hachurado: build
   * > 6 ms ⇒ fallback export-only. Tono = tinta de fondo de la casa.
   */
  private drawFriction(sx: (x: number, y: number) => number, sy: (x: number, y: number, z: number) => number): void {
    const ref = this.frictionRef;
    if (!ref || !this.model) return;
    const f = ref.field;
    const metersPerPx = 1 / (this.pxPerM() || 0.08);
    const pl = frictionPlacement(f, ref.anchor);
    const cellRef = Math.min(Math.abs(pl.cellXm), Math.abs(pl.cellYm)) || 10;
    let k = Math.max(1, Math.round((14 * metersPerPx) / cellRef));
    while (((Math.floor((f.w - 1) / k) + 1) * (Math.floor((f.h - 1) / k) + 1)) > 20000) k *= 2;
    let cache = this.frictionCache;
    if (!cache || cache.k !== k) {
      const built = this.buildFrictionGeometry(k);
      cache = { k, segs: built.segs, count: built.count };
      this.frictionCache = cache;
      if (built.buildMs > 6) {
        // guard #11 verificado ⇒ fallback export-only (D12 §5)
        this.frictionFallback = 'guard';
        this.frictionDrawn = 0;
        this.dirty = true; // redibujar ya sin tramas
        return;
      }
    }
    const { ctx } = this;
    const pad = 24;
    const S = this.pxPerM();
    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    const c = Math.cos(this.az);
    const s = Math.sin(this.az);
    const es = Math.sin(this.el);
    const ec = Math.cos(this.el);
    ctx.beginPath();
    let drawn = 0;
    const segs = cache.segs;
    for (let i = 0; i < cache.count; i++) {
      const x0 = segs[i * 6];
      const y0 = segs[i * 6 + 1];
      const z0 = segs[i * 6 + 2];
      const px = w2 + (x0 * c - y0 * s) * S;
      if (px < -pad || px > this.w + pad) continue;
      const py = h2 - ((x0 * s + y0 * c) * es + z0 * ec) * S;
      if (py < -pad || py > this.h + pad) continue;
      const x1 = segs[i * 6 + 3];
      const y1 = segs[i * 6 + 4];
      const z1 = segs[i * 6 + 5];
      ctx.moveTo(sx(x0, y0), sy(x0, y0, z0));
      ctx.lineTo(sx(x1, y1), sy(x1, y1, z1));
      drawn++;
    }
    ctx.strokeStyle = this.pal().hachure;
    ctx.lineWidth = 0.7;
    ctx.stroke();
    this.frictionDrawn = drawn;
    this.drawnSegs += drawn;
  }

  /**
   * Marco cartográfico INEGI: crucetas de esquina, ticks minutales en los
   * bordes del recorte y coordenadas geográficas de las esquinas. Todo se
   * dibuja sobre el plano a cota mínima para seguir la vista 3D.
   */
  /**
   * A-8 · marcador GPS sobre el terreno: proyección con la MISMA convención
   * del marco INEGI (111_320 m/° en ambos ejes, origen = centro de región),
   * regla §5.1 (fuera del extent ⇒ JAMÁS se dibuja), z = celda más próxima
   * del grid (índice j*n+i). Nodos de path: exactamente GPS_MARKER_NODOS.
   */
  private drawGpsMarker(
    sx: (x: number, y: number) => number,
    sy: (x: number, y: number, z: number) => number
  ): void {
    const ref = this.gpsRef;
    if (!ref || !this.model) return;
    const rad = (ref.anchor.centerLat * Math.PI) / 180;
    const mPerLon = 111_320 * Math.cos(rad);
    const xM = (ref.lon - ref.anchor.centerLon) * mPerLon;
    const yM = (ref.lat - ref.anchor.centerLat) * 111_320;
    if (Math.abs(xM) > ref.anchor.extentM / 2 || Math.abs(yM) > ref.anchor.extentM / 2) return;
    const px = sx(xM, yM);
    const py = sy(xM, yM, this.groundZAt(xM, yM));
    if (px < -20 || px > this.w + 20 || py < -20 || py > this.h + 20) return;
    const P = this.pal();
    const inks: GpsMarkerInks = { gpsOk: P.gpsOk, gpsWarn: P.gpsWarn, gpsHole: P.bg };
    drawGpsMarkerAt(this.ctx, px, py, ref.tone, inks);
  }

  /** Celda más próxima del grid (índice j*n+i) — O(1), sin interpolar. */
  private groundZAt(xM: number, yM: number): number {
    const g = this.model!.grid;
    const half = ((g.n - 1) / 2) * g.cell;
    if (Math.abs(xM) > half || Math.abs(yM) > half) return g.min;
    const i = Math.min(g.n - 1, Math.max(0, Math.round(xM / g.cell + (g.n - 1) / 2)));
    const j = Math.min(g.n - 1, Math.max(0, Math.round(yM / g.cell + (g.n - 1) / 2)));
    return g.h[j * g.n + i];
  }

  private drawInegiFrame(
    sx: (x: number, y: number) => number,
    sy: (x: number, y: number, z: number) => number
  ): void {
    const { ctx } = this;
    const r = this.model!.region;
    const g = this.model!.grid;
    const half = ((g.n - 1) / 2) * g.cell;
    const zmin = g.min;
    const rad = (r.centerLat * Math.PI) / 180;
    const mPerLon = 111320 * Math.cos(rad);
    const dLon = half / mPerLon;
    const dLat = half / 111320;
    const Ci = this.pal();

    ctx.save();
    ctx.strokeStyle = Ci.inegiFrame;
    ctx.fillStyle = Ci.inegiText;
    ctx.lineWidth = 1;

    const cull = (px: number, py: number): boolean =>
      px < -80 || px > this.w + 80 || py < -80 || py > this.h + 80;

    // Crucetas de esquina (sobresalen del marco, estilo hoja cartográfica)
    for (const [x, y] of [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ] as Array<[number, number]>) {
      const px = sx(x, y);
      const py = sy(x, y, zmin);
      if (cull(px, py)) continue;
      const ex = x < 0 ? 1 : -1;
      const ey = y < 0 ? 1 : -1;
      const a = { x: sx(x + ex * 40, y), y: sy(x + ex * 40, y, zmin) };
      const b = { x: sx(x, y + ey * 40), y: sy(x, y + ey * 40, zmin) };
      let d1x = a.x - px;
      let d1y = a.y - py;
      let l1 = Math.hypot(d1x, d1y) || 1;
      d1x /= l1;
      d1y /= l1;
      let d2x = b.x - px;
      let d2y = b.y - py;
      let l2 = Math.hypot(d2x, d2y) || 1;
      d2x /= l2;
      d2y /= l2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + d1x * 14, py + d1y * 14);
      ctx.moveTo(px, py);
      ctx.lineTo(px + d2x * 14, py + d2y * 14);
      ctx.stroke();
    }

    // Ticks minutales: longitud en bordes N/S, latitud en bordes E/W
    const edgeTicks = (from: number, to: number, isLon: boolean): void => {
      const step = 1 / 60;
      const start = Math.ceil(from * 60 - 1e-6) / 60;
      for (let v = start; v <= to + 1e-9; v += step) {
        if (v <= from + 1e-9 || v >= to - 1e-9) continue; // sin ticks sobre las esquinas
        for (const edge of [-half, half]) {
          const x = isLon ? (v - r.centerLon) * mPerLon : edge;
          const y = isLon ? edge : (v - r.centerLat) * 111320;
          const px = sx(x, y);
          const py = sy(x, y, zmin);
          if (cull(px, py)) continue;
          // dirección de la arista → normal hacia el interior
          const dxw = isLon ? x + 30 : x;
          const dyw = isLon ? y : y + 30;
          let ex = sx(dxw, dyw) - px;
          let ey = sy(dxw, dyw, zmin) - py;
          const l = Math.hypot(ex, ey) || 1;
          ex /= l;
          ey /= l;
          let nx = -ey;
          let ny = ex;
          const toC = this.w / 2 - px;
          const tcY = this.h / 2 - py;
          if (nx * toC + ny * tcY < 0) {
            nx = -nx;
            ny = -ny;
          }
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + nx * 8, py + ny * 8);
          ctx.stroke();
        }
      }
    };
    edgeTicks(r.centerLon - dLon, r.centerLon + dLon, true);
    edgeTicks(r.centerLat - dLat, r.centerLat + dLat, false);

    // Coordenadas geográficas en las esquinas
    ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = (x: number, y: number, lat: number, lon: number): void => {
      const px = sx(x, y);
      const py = sy(x, y, zmin);
      if (cull(px, py)) return;
      let ox = px - this.w / 2;
      let oy = py - this.h / 2;
      const l = Math.hypot(ox, oy) || 1;
      ox /= l;
      oy /= l;
      const txt = `${formatDegMin(lat)} ${lat >= 0 ? 'N' : 'S'} · ${formatDegMin(lon)} ${lon < 0 ? 'W' : 'E'}`;
      ctx.fillText(txt, px + ox * 42, py + oy * 42);
    };
    label(-half, -half, r.centerLat - dLat, r.centerLon - dLon);
    label(half, -half, r.centerLat - dLat, r.centerLon + dLon);
    label(half, half, r.centerLat + dLat, r.centerLon + dLon);
    label(-half, half, r.centerLat + dLat, r.centerLon - dLon);

    ctx.restore();
  }

  /** Sello del marco INEGI (espacio de pantalla, arriba al centro) */
  private drawInegiStamp(): void {
    const { ctx } = this;
    const C = this.pal();
    const r = this.model!.region;
    const compact = this.w < 560;
    const font = compact ? '500 8.5px ui-monospace, monospace' : '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const pre = 'INEGI · ';
    const codes = compact ? inegiCodesJoin('·') : inegiCodesJoin(' · ');
    const line2 = `MTN 1:50 000 · ${Math.abs(r.centerLat).toFixed(4)}° N ${Math.abs(r.centerLon).toFixed(4)}° W`;
    const wPre = ctx.measureText(pre).width;
    const wCodes = ctx.measureText(codes).width;
    const w2 = ctx.measureText(line2).width;
    const boxW = Math.ceil(Math.max(wPre + wCodes, w2)) + 20;
    const boxH = 36;
    const x0 = (this.w - boxW) / 2;
    const y0 = 10;

    ctx.beginPath();
    ctx.roundRect(x0, y0, boxW, boxH, 6);
    ctx.fillStyle = C.stampBg;
    ctx.fill();
    ctx.strokeStyle = C.stampBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = C.inegiText;
    ctx.fillText(pre, x0 + 10, y0 + 12);
    ctx.fillStyle = C.inegiAccent;
    ctx.fillText(codes, x0 + 10 + wPre, y0 + 12);
    ctx.fillStyle = C.stampSub;
    ctx.fillText(line2, x0 + 10, y0 + 25);
  }

  /** Culling por AABB proyectada de la polilínea (sin allocaciones por cuadro). */
  private cullPoly(
    p: Poly,
    z: number,
    S: number,
    c: number,
    s: number,
    es: number,
    ec: number
  ): boolean {
    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    const pad = 60;
    let minSx = Infinity;
    let maxSx = -Infinity;
    let minSy = Infinity;
    let maxSy = -Infinity;
    for (let xi = 0; xi < 2; xi++) {
      const x = xi === 0 ? p.minX : p.maxX;
      for (let yi = 0; yi < 2; yi++) {
        const y = yi === 0 ? p.minY : p.maxY;
        const px = w2 + (x * c - y * s) * S;
        const py = h2 - ((x * s + y * c) * es + z * ec) * S;
        if (px < minSx) minSx = px;
        if (px > maxSx) maxSx = px;
        if (py < minSy) minSy = py;
        if (py > maxSy) maxSy = py;
      }
    }
    return maxSx < -pad || minSx > this.w + pad || maxSy < -pad || minSy > this.h + pad;
  }

  private drawMesh(sx: (x: number, y: number) => number, sy: (x: number, y: number, z: number) => number): void {
    const { ctx } = this;
    const C = this.pal();
    const g = this.model!.grid;
    const n = g.n;
    const half = (n - 1) / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.mesh;

    if (this.opts.mesh) {
      ctx.beginPath();
      const step = 8;
      for (let j = 0; j < n; j += step) {
        const y = (j - half) * g.cell;
        ctx.moveTo(sx(-half * g.cell, y), sy(-half * g.cell, y, g.h[j * n]));
        for (let i = 1; i < n; i++) {
          const x = (i - half) * g.cell;
          ctx.lineTo(sx(x, y), sy(x, y, g.h[j * n + i]));
        }
      }
      for (let i = 0; i < n; i += step) {
        const x = (i - half) * g.cell;
        ctx.moveTo(sx(x, -half * g.cell), sy(x, -half * g.cell, g.h[i]));
        for (let j = 1; j < n; j++) {
          const y = (j - half) * g.cell;
          ctx.lineTo(sx(x, y), sy(x, y, g.h[j * n + i]));
        }
      }
      ctx.stroke();
    }

    // marco del recorte a cota mínima
    ctx.strokeStyle = C.frame;
    ctx.beginPath();
    const e = half * g.cell;
    const zmin = g.min;
    ctx.moveTo(sx(-e, -e), sy(-e, -e, zmin));
    ctx.lineTo(sx(e, -e), sy(e, -e, zmin));
    ctx.lineTo(sx(e, e), sy(e, e, zmin));
    ctx.lineTo(sx(-e, e), sy(-e, e, zmin));
    ctx.closePath();
    ctx.stroke();
  }

  /* ---------------- capa de contornos ---------------- */

  /** Crea/reamuestra la capa de contornos; false si el entorno no permite 2D. */
  private ensureLayer(): boolean {
    const pw = Math.max(1, Math.round(this.w * this.dpr));
    const ph = Math.max(1, Math.round(this.h * this.dpr));
    if (!this.layer || this.layer.cnv.width !== pw || this.layer.cnv.height !== ph) {
      let cnv: OffscreenCanvas | HTMLCanvasElement;
      let ctx: Ctx2D | null;
      if (typeof OffscreenCanvas !== 'undefined') {
        cnv = new OffscreenCanvas(pw, ph);
        ctx = (cnv as OffscreenCanvas).getContext('2d', { alpha: true });
      } else {
        const hc = document.createElement('canvas');
        hc.width = pw;
        hc.height = ph;
        cnv = hc;
        ctx = hc.getContext('2d', { alpha: true });
      }
      if (!ctx) return false;
      this.layer = { cnv, ctx };
      this.layerReady = false;
      this.slice = null;
    }
    return true;
  }

  /** ¿La clave de vista difiere de la almacenada en la capa? (numérica, sin strings) */
  private keyDiffers(step: number, useLight: boolean): boolean {
    const [rMin, rMax] = this.opts.elevRange;
    return (
      this.kAz !== this.az ||
      this.kEl !== this.el ||
      this.kZoom !== this.zoom ||
      this.kPx !== this.panX ||
      this.kPy !== this.panY ||
      this.kW !== this.w ||
      this.kH !== this.h ||
      this.kDpr !== this.dpr ||
      this.kStep !== step ||
      this.kLight !== useLight ||
      this.kRMin !== rMin ||
      this.kRMax !== rMax ||
      this.kMinor !== this.opts.minor ||
      this.kMajor !== this.opts.major ||
      this.kEink !== this.opts.eink ||
      this.kDay !== this.opts.day ||
      this.kFog !== this.fogIdx
    );
  }

  private storeKey(step: number, useLight: boolean): void {
    this.kAz = this.az;
    this.kEl = this.el;
    this.kZoom = this.zoom;
    this.kPx = this.panX;
    this.kPy = this.panY;
    this.kW = this.w;
    this.kH = this.h;
    this.kDpr = this.dpr;
    this.kStep = step;
    this.kLight = useLight;
    this.kRMin = this.opts.elevRange[0];
    this.kRMax = this.opts.elevRange[1];
    this.kMinor = this.opts.minor;
    this.kMajor = this.opts.major;
    this.kEink = this.opts.eink;
    this.kDay = this.opts.day;
    this.kFog = this.fogIdx;
  }

  private blitLayer(): void {
    if (!this.layer) return;
    this.ctx.drawImage(this.layer.cnv as CanvasImageSource, 0, 0, this.w, this.h);
  }

  /** Segmentos estimados para la vista/intervalo actuales (O(niveles) ≈ 300 it.). */
  private estimateSegs(step: number, useLight: boolean): number {
    const cont = this.contours!;
    const [rMin, rMax] = this.opts.elevRange;
    const forced = this.opts.forcedStep > 0;
    let total = 0;
    for (let li = 0; li < cont.levels.length; li++) {
      const lvl = cont.levels[li];
      if (lvl.v < rMin || lvl.v > rMax) continue;
      if (lvl.maestra) {
        if (this.opts.major) total += lvl.segs;
        continue;
      }
      if (!this.opts.minor) continue;
      /* FIX intervalo forzado (Task 19): con step forzado > 1 el filtro aplica
         aunque lodIdx sea 0 — antes, forzar 5 m desde un modelo fresco dibujaba
         TODAS las intermedias de 1 m contradiciendo el HUD. */
      if ((this.lodIdx > 0 || forced) && lvl.v % step !== 0) continue;
      total += useLight && lvl.segsLight !== undefined ? lvl.segsLight : lvl.segs;
    }
    return total;
  }

  /**
   * Pinta las curvas intermedias en el destino dado (agrupadas por bucket de
   * gris: 1 stroke por grupo). Con `deadline > 0` cede el cuadro al agotar el
   * presupuesto de time-slicing (F2-A); con `lodCheck` aplica el LOD por
   * presupuesto (pase único, comportamiento clásico).
   */
  private paintMinors(
    ctx: Ctx2D,
    S: number,
    c: number,
    s: number,
    es: number,
    ec: number,
    mat: DOMMatrix2DInit,
    step: number,
    useLight: boolean,
    fromLevel: number,
    deadline: number,
    lodCheck: boolean
  ): { drawn: number; next: number; done: boolean; lodRaised: boolean } {
    const cont = this.contours!;
    const [rMin, rMax] = this.opts.elevRange;
    const forced = this.opts.forcedStep > 0;
    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    let drawn = 0;
    let lodRaised = false;
    /* F5-02 · niebla profunda: trazo más fino (más claro ya vía bucketColor) */
    ctx.lineWidth = this.fogIdx >= 2 ? 0.8 : 1;
    let runBucket = -1;
    let runPath: Path2D | null = null;
    const flushRun = (): void => {
      if (runPath !== null) {
        ctx.stroke(runPath);
        runPath = null;
      }
    };
    let li = fromLevel;
    for (; li < cont.levels.length; li++) {
      const lvl = cont.levels[li];
      if (lvl.maestra) continue; // se dibujan encima
      if (lvl.v < rMin || lvl.v > rMax) continue;
      // FIX intervalo forzado (Task 19): el filtro aplica también con step
      // forzado aunque lodIdx sea 0 (mismo criterio que estimateSegs)
      if ((this.lodIdx > 0 || forced) && lvl.v % step !== 0) continue;

      const bucket = this.minorBucket[li];
      if (bucket !== runBucket) {
        flushRun();
        runBucket = bucket;
        ctx.strokeStyle = this.opts.eink ? this.pal().minor : this.bucketColor[bucket];
        runPath = new Path2D();
      }

      mat.f = h2 - ec * lvl.v * S;
      const light = useLight && lvl.polysLight !== undefined;
      const paths = (light ? this.polyPathsLight?.[li] : this.polyPaths[li]) as
        | Path2D[]
        | undefined;
      if (!paths) continue;
      const polys = light ? (lvl.polysLight as Poly[]) : lvl.polys;
      for (let pi = 0; pi < polys.length; pi++) {
        const p = polys[pi];
        if (this.cullPoly(p, lvl.v, S, c, s, es, ec)) continue;
        drawn += p.n - 1;
        runPath!.addPath(paths[pi], mat);
      }

      // LOD adaptativo solo en pase único (modo automático)
      if (lodCheck && !forced && drawn > this.budget) {
        if (this.lodIdx < MINOR_STEPS.length - 1) {
          this.lodIdx++;
          this.pendingRedraw = true;
          lodRaised = true;
        }
        break;
      }
      // Time-slicing (F2-A): ceder el cuadro al agotar el presupuesto de 8 ms
      if (deadline > 0 && performance.now() > deadline) {
        flushRun();
        return { drawn, next: li + 1, done: false, lodRaised: false };
      }
    }
    flushRun();
    return { drawn, next: li, done: true, lodRaised };
  }

  /** Pinta maestras 25 m + cotas en el destino dado; devuelve segmentos trazados. */
  private paintMasters(
    ctx: Ctx2D,
    S: number,
    c: number,
    s: number,
    es: number,
    ec: number,
    mat: DOMMatrix2DInit,
    rMin: number,
    rMax: number
  ): number {
    const cont = this.contours!;
    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    const C = this.pal();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = C.major;
    const majorPath = new Path2D();
    const cotas: Array<{ x: number; y: number; v: number }> = [];
    let segs = 0;
    for (let li = 0; li < cont.levels.length; li++) {
      const lvl = cont.levels[li];
      if (!lvl.maestra) continue;
      if (lvl.v < rMin || lvl.v > rMax) continue;
      mat.f = h2 - ec * lvl.v * S;
      const paths = this.polyPaths[li];
      const polys = lvl.polys;
      let drawn = false;
      for (let pi = 0; pi < polys.length; pi++) {
        const p = polys[pi];
        if (this.cullPoly(p, lvl.v, S, c, s, es, ec)) continue;
        segs += p.n - 1;
        drawn = true;
        majorPath.addPath(paths[pi], mat);
      }
      if (drawn && this.opts.cotas && this.zoom > 0.4 && polys.length > 0) {
        const lp = polys[this.labelPoly[li]] ?? polys[0];
        const mx = (lp.minX + lp.maxX) / 2;
        const my = (lp.minY + lp.maxY) / 2;
        const px = w2 + (mx * c - my * s) * S;
        const py = h2 - ((mx * s + my * c) * es + lvl.v * ec) * S;
        if (px > 40 && px < this.w - 40 && py > 24 && py < this.h - 24) {
          cotas.push({ x: px, y: py, v: lvl.v });
        }
      }
    }
    /* F5-01 · Sombra vectorial falsa: UNA copia desplazada del path de
     * maestras (offset fijo en pantalla = sol desde el NW, convención
     * cartográfica), color oscuro con alpha reducido, dibujada DETRÁS de la
     * línea principal. 1 stroke extra sobre Path2D cacheado: sin shaders,
     * sin bucles por píxel, sin trabajo por vértice. E-Ink la omite. */
    if (this.opts.reliefFx && !this.opts.eink) {
      ctx.save();
      ctx.translate(2.5, 3.5);
      ctx.strokeStyle = C.majorShadow;
      ctx.stroke(majorPath);
      ctx.restore();
    }
    ctx.stroke(majorPath);
    this.lastMaestraSegs = segs;

    if (cotas.length > 0) {
      // de-clutter: etiquetas separadas al menos 64 px en X
      cotas.sort((a, b) => a.x - b.x);
      const filtered: Array<{ x: number; y: number; v: number }> = [];
      for (const ct of cotas) {
        const last = filtered[filtered.length - 1];
        if (!last || ct.x - last.x > 64 || Math.abs(ct.y - last.y) > 40) filtered.push(ct);
      }
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.halo;
      for (const ct of filtered) {
        const txt = ct.v.toLocaleString('es-MX');
        ctx.strokeText(txt, ct.x, ct.y);
        ctx.fillStyle = C.cotaText;
        ctx.fillText(txt, ct.x, ct.y);
      }
    }
    return segs;
  }

  /**
   * Curvas de nivel con caché Path2D por polilínea (F2) sobre una capa
   * acumulable (F2-B) y time-slicing con degradación adaptativa (F2-A).
   * La proyección ortográfica es afín para cota constante: cada polilínea
   * cacheada (coords de mundo) se compone con la matriz mundo→pantalla de
   * su nivel vía Path2D.addPath — cero matemática de vértice en JS y trazo
   * en espacio dispositivo (anchos uniformes e idénticos al modo inmediato).
   */
  private drawContours(
    S: number,
    c: number,
    s: number,
    es: number,
    ec: number
  ): void {
    const cont = this.contours!;
    const [rMin, rMax] = this.opts.elevRange;
    const forced = this.opts.forcedStep > 0;
    const step = forced ? this.opts.forcedStep : MINOR_STEPS[this.lodIdx];
    // Variante ligera (ATOM-03): solo cuando su tolerancia es sub-píxel
    // (tol · pxPerM < LIGHT_PX) ⇒ desviación visual garantizada < 1 px.
    const lightTol = cont.lightTol;
    const useLight = lightTol > 0 && lightTol * this.pxPerM() < LIGHT_PX;

    if (!this.opts.minor && !this.opts.major) {
      this.slice = null;
      return;
    }

    const w2 = this.w / 2 + this.panX;
    const h2 = this.h / 2 + this.panY;
    // matriz afín mundo→pantalla (f depende solo de la cota del nivel: h2 − ec·v·S)
    const mat: DOMMatrix2DInit = { a: c * S, b: -es * s * S, c: -s * S, d: -es * c * S, e: w2, f: 0 };

    const hasLayer = this.ensureLayer();
    if (hasLayer && this.layerReady && !this.keyDiffers(step, useLight)) {
      this.blitLayer(); // vista estable y capa completa: un solo drawImage
      return;
    }

    const ctx: Ctx2D = hasLayer ? this.layer!.ctx : this.ctx;

    if (hasLayer) {
      const continuing = this.slice !== null && !this.keyDiffers(step, useLight);
      if (!continuing) {
        const lctx = this.layer!.ctx;
        lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        lctx.clearRect(0, 0, this.w, this.h);
        // F2-A: ¿cabe la escena en un cuadro? (segs estimados × ms/seg medido)
        const predicted =
          this.estimateSegs(step, useLight) *
          (this.perSegEma > 0 ? this.perSegEma : PER_SEG_MS);
        if (predicted > SLICE_MS && this.opts.minor) {
          // render progresivo: maestras 25 m visibles de inmediato
          this.slice = { next: 0, partials: 0, segs: 0 };
          this.storeKey(step, useLight);
          this.mastersSegs = this.paintMasters(lctx, S, c, s, es, ec, mat, rMin, rMax);
        } else {
          this.slice = null;
        }
      }
    } else {
      this.slice = null;
    }

    if (this.slice !== null) {
      // —— tanda de time-slicing (F2-A): intermedias dentro del presupuesto
      const lctx = this.layer!.ctx;
      const t0 = performance.now();
      const r = this.paintMinors(
        lctx,
        S,
        c,
        s,
        es,
        ec,
        mat,
        step,
        useLight,
        this.slice.next,
        t0 + SLICE_MS,
        false
      );
      const ms = performance.now() - t0;
      if (r.drawn > 0 && ms > 0) {
        this.perSegEma =
          this.perSegEma > 0 ? this.perSegEma * 0.6 + (ms / r.drawn) * 0.4 : ms / r.drawn;
      }
      this.slice.segs += r.drawn;
      this.drawnSegs = this.mastersSegs + this.slice.segs;
      if (r.done) {
        // maestras encima (paridad de apilado) y cierre de la capa
        this.paintMasters(lctx, S, c, s, es, ec, mat, rMin, rMax);
        // si sobra holgura, probar bajar un intervalo (solo auto)
        if (!forced && this.drawnSegs <= this.budget && this.lodIdx > 0) {
          const cur = MINOR_STEPS[this.lodIdx];
          const nxt = MINOR_STEPS[this.lodIdx - 1];
          const predicted = (this.slice.segs * cur) / nxt + this.lastMaestraSegs;
          if (predicted <= this.budget) {
            this.lodIdx--;
            this.pendingRedraw = true;
          }
        }
        this.lastMinorSegs = this.slice.segs;
        this.layerReady = true;
        this.slice = null;
      } else {
        this.slice.next = r.next;
        this.slice.partials++;
        // degradación adaptativa: subir intervalo en vez de congelar cuadros
        if (
          !forced &&
          this.slice.partials > SLICE_PARTIALS_MAX &&
          this.lodIdx < MINOR_STEPS.length - 1
        ) {
          this.lodIdx++;
          this.slice = null;
          this.pendingRedraw = true;
        }
      }
      if (hasLayer) this.blitLayer();
      return;
    }

    // —— pase único (comportamiento clásico): intermedias y luego maestras
    const t0 = performance.now();
    const rm = this.paintMinors(ctx, S, c, s, es, ec, mat, step, useLight, 0, 0, true);
    this.lastMinorSegs = rm.drawn;
    const segsM = this.paintMasters(ctx, S, c, s, es, ec, mat, rMin, rMax);
    this.drawnSegs = rm.drawn + segsM;
    const ms = performance.now() - t0;
    if (this.drawnSegs > 0 && ms > 0) {
      this.perSegEma =
        this.perSegEma > 0
          ? this.perSegEma * 0.85 + (ms / this.drawnSegs) * 0.15
          : ms / this.drawnSegs;
    }
    if (hasLayer) {
      if (!rm.lodRaised) this.layerReady = true;
      this.blitLayer();
    }
  }

  private drawStreams(sx: (x: number, y: number) => number, sy: (x: number, y: number, z: number) => number): void {
    const { ctx } = this;
    ctx.strokeStyle = this.pal().stream;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const st of this.model!.streams) {
      ctx.moveTo(sx(st[0], st[1]), sy(st[0], st[1], st[2]));
      for (let i = 1; i < st.length / 3; i++) {
        ctx.lineTo(sx(st[i * 3], st[i * 3 + 1]), sy(st[i * 3], st[i * 3 + 1], st[i * 3 + 2]));
      }
    }
    ctx.stroke();
  }

  private drawDivides(sx: (x: number, y: number) => number, sy: (x: number, y: number, z: number) => number): void {
    const { ctx } = this;
    const C = this.pal();
    ctx.strokeStyle = C.divide;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    for (const b of this.model!.basins) {
      const m = b.ring.length / 3;
      ctx.moveTo(sx(b.ring[0], b.ring[1]), sy(b.ring[0], b.ring[1], b.ring[2]));
      for (let i = 1; i < m; i++) {
        ctx.lineTo(sx(b.ring[i * 3], b.ring[i * 3 + 1]), sy(b.ring[i * 3], b.ring[i * 3 + 1], b.ring[i * 3 + 2]));
      }
      ctx.closePath();
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // marcador de salida (embalse)
    ctx.fillStyle = C.major;
    for (const b of this.model!.basins) {
      const px = sx(b.outlet.x, b.outlet.y);
      const py = sy(b.outlet.x, b.outlet.y, b.outlet.z);
      if (px < -20 || px > this.w + 20 || py < -20 || py > this.h + 20) continue;
      ctx.beginPath();
      ctx.moveTo(px, py - 5);
      ctx.lineTo(px + 5, py);
      ctx.lineTo(px, py + 5);
      ctx.lineTo(px - 5, py);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawNodes(sx: (x: number, y: number) => number, sy: (x: number, y: number, z: number) => number): void {
    const { ctx } = this;
    const g = this.model!.grid;
    const n = g.n;
    const half = (n - 1) / 2;
    const step = 6;
    ctx.fillStyle = this.pal().node;
    const size = 2.4;
    for (let j = 0; j < n; j += step) {
      const y = (j - half) * g.cell;
      for (let i = 0; i < n; i += step) {
        const x = (i - half) * g.cell;
        const px = sx(x, y);
        const py = sy(x, y, g.h[j * n + i]);
        if (px < 0 || px > this.w || py < 0 || py > this.h) continue;
        ctx.fillRect(px - size / 2, py - size / 2, size, size);
      }
    }
  }

  private drawBasinLabels(sx: (x: number, y: number) => number, sy: (x: number, y: number, z: number) => number): void {
    const { ctx } = this;
    const C = this.pal();
    const g = this.model!.grid;
    ctx.font = '600 10.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.haloSoft;
    ctx.fillStyle = C.label;
    for (const b of this.model!.basins) {
      const z = sampleGrid(g, b.cx, b.cy) + 42;
      const px = sx(b.cx, b.cy);
      const py = sy(b.cx, b.cy, z);
      if (px < 0 || px > this.w || py < 0 || py > this.h) continue;
      ctx.strokeText(b.name, px, py);
      ctx.fillText(b.name, px, py);
    }
  }

  /** Gizmo de ejes estilo Blender (abajo a la derecha) */
  private drawGizmo(): void {
    const { ctx } = this;
    const C = this.pal();
    const gx = this.w - 52;
    const gy = this.h - 76;
    const r = 30;
    const c = Math.cos(this.az);
    const s = Math.sin(this.az);
    const es = Math.sin(this.el);
    const ec = Math.cos(this.el);

    ctx.beginPath();
    ctx.arc(gx, gy, r + 12, 0, Math.PI * 2);
    ctx.fillStyle = C.gizmoBg;
    ctx.fill();
    ctx.strokeStyle = C.stampBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    const axes: Array<{ dx: number; dy: number; label: string; color: string }> = [
      { dx: c, dy: -s * es, label: 'E', color: C.axisX },
      { dx: -s, dy: -c * es, label: 'N', color: C.axisY },
      { dx: 0, dy: -ec, label: 'Z', color: C.axisZ },
    ];
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const a of axes) {
      const len = Math.hypot(a.dx, a.dy) || 1;
      const ux = a.dx / len;
      const uy = a.dy / len;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + ux * r, gy + uy * r);
      ctx.stroke();
      // eje negativo tenue
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx - ux * r * 0.6, gy - uy * r * 0.6);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = a.color;
      ctx.fillText(a.label, gx + ux * (r + 6), gy + uy * (r + 6));
    }
  }

  /** Barra de escala cartográfica (abajo a la izquierda, sobre la leyenda) */
  private drawScaleBar(): void {
    const { ctx } = this;
    const pxPerM = this.pxPerM();
    const targetPx = 120;
    const rawM = targetPx / pxPerM;
    const pow = Math.pow(10, Math.floor(Math.log10(rawM)));
    let nice = pow;
    for (const m of [5, 2, 1]) {
      if (rawM >= m * pow) {
        nice = m * pow;
        break;
      }
    }
    const px = nice * pxPerM;
    const x0 = 18;
    const y0 = this.h - 112;
    const Cs = this.pal().scale;
    ctx.strokeStyle = Cs;
    ctx.fillStyle = Cs;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + px, y0);
    ctx.lineTo(x0 + px, y0 - 4);
    ctx.moveTo(x0 + px / 2, y0);
    ctx.lineTo(x0 + px / 2, y0 - 3);
    ctx.stroke();
    ctx.font = '600 9.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = nice >= 1000 ? `${(nice / 1000).toLocaleString('es-MX')} km` : `${nice.toLocaleString('es-MX')} m`;
    ctx.fillText(label, x0, y0 - 7);
  }

  /* ---------------- interacción ---------------- */

  private onContextMenu = (e: Event): void => e.preventDefault();

  private onDblClick = (): void => {
    this.applyPreset('fit');
  };

  private onPointerDown = (e: PointerEvent): void => {
    /* pointerId sintético (automatización/eventos fabricados) no es un puntero
       activo: setPointerCapture lanzaría NotFoundError y rompería el gesto. */
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura: el seguimiento por eventos sigue funcionando */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.anim = null;
    this.velAz = 0;
    this.velEl = 0;
    if (this.pointers.size === 2) {
      const [p1, p2] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      this.pinchMx = (p1.x + p2.x) / 2;
      this.pinchMy = (p1.y + p2.y) / 2;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 1) {
      const panMode = e.buttons === 4 || e.buttons === 2 || e.shiftKey;
      if (panMode) {
        this.panX += dx;
        this.panY += dy;
      } else {
        const dtv = Math.max(8, e.timeStamp - (this.lastMoveT || e.timeStamp - 16));
        this.lastMoveT = e.timeStamp;
        this.velAz = this.velAz * 0.6 + (dx / dtv) * 1000 * 0.28;
        this.velEl = this.velEl * 0.6 + (dy / dtv) * 1000 * 0.28;
        this.az -= dx * 0.005;
        this.el = clamp(this.el - dy * 0.005, EL_MIN, EL_MAX);
      }
      this.requestDraw();
    } else if (this.pointers.size === 2) {
      const [p1, p2] = [...this.pointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      if (this.pinchDist > 0 && dist > 0) {
        this.zoomAt(mx, my, dist / this.pinchDist);
      }
      this.panX += mx - this.pinchMx;
      this.panY += my - this.pinchMy;
      this.pinchDist = dist;
      this.pinchMx = mx;
      this.pinchMy = my;
      this.requestDraw();
    }
  };

  private lastMoveT = 0;

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (this.pointers.size === 0) {
      // inercia solo si el gesto fue rápido; con prefers-reduced-motion, nunca
      if (this.reducedMotion || Math.hypot(this.velAz, this.velEl) < 60) {
        this.velAz = 0;
        this.velEl = 0;
      }
      this.lastMoveT = 0;
      this.requestDraw();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0014);
    this.zoomAt(e.clientX, e.clientY, factor);
    this.requestDraw();
  };

  /** Zoom manteniendo fijo el punto bajo el cursor */
  private zoomAt(mx: number, my: number, factor: number): void {
    const base = this.baseScale();
    const f0 = base * this.zoom;
    const z1 = clamp(this.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    const f1 = base * z1;
    if (f1 === f0) return;
    const k = f1 / f0;
    const rect = this.canvas.getBoundingClientRect();
    const mx0 = mx - rect.left;
    const my0 = my - rect.top;
    this.panX = this.panX - (mx0 - this.w / 2 - this.panX) * (k - 1);
    this.panY = this.panY + (this.h / 2 + this.panY - my0) * (k - 1);
    this.zoom = z1;
    this.anim = null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // Hallazgo #13 (Bundle B, aprobado 2026-09-25): los thumbs Radix son
    // <span role="slider"> — sus flechas burbujean a window y orbitaban la
    // cámara además de mover el slider. El motor cede el control.
    if (target?.closest?.('[role=slider]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const stepAz = (5 * Math.PI) / 180;
    const stepEl = (4 * Math.PI) / 180;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) this.panX += 40;
        else this.nudge({ dAz: -stepAz });
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) this.panX -= 40;
        else this.nudge({ dAz: stepAz });
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey) this.panY += 40;
        else this.nudge({ dEl: stepEl });
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey) this.panY -= 40;
        else this.nudge({ dEl: -stepEl });
        break;
      case '+':
      case '=':
        this.nudge({ dZoom: 0.25 });
        break;
      case '-':
        this.nudge({ dZoom: -0.2 });
        break;
      case '7':
        this.applyPreset('top');
        break;
      case '1':
        this.applyPreset('front');
        break;
      case '3':
        this.applyPreset('side');
        break;
      case '5':
      case '0':
        this.applyPreset('iso');
        break;
      case 'h':
      case 'H':
        this.fitView();
        break;
    }
  };
}
