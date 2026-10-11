/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * Roadmap de Renderizado 0 GPU — fuente única de verdad.
 *
 * El visor ya rasteriza exclusivamente con Canvas 2D en CPU (sin WebGL,
 * WebGPU ni shaders). Este módulo describe el plan para mantener y mejorar
 * ese esquema: hilo de trabajo, cachés, degradación elegante y ahorro
 * energético. Lo consume la sección "Roadmap 0 GPU" del panel.
 */

export type RoadmapStatus = 'hecho' | 'activo' | 'siguiente' | 'planificado' | 'exploracion';

export interface RoadmapPhase {
  /** Identificador corto: F0…F5 */
  code: string;
  title: string;
  status: RoadmapStatus;
  /** Objetivo de la fase en una línea */
  goal: string;
  /** Entregables / acciones concretas */
  items: string[];
  /** Criterio de aceptación medible (opcional) */
  criteria?: string;
}

export const ROADMAP_UPDATED = '2026-09-24';

/* Nota Task 23 (Roadmap Atómico Quirúrgico · F5): sombra vectorial falsa
   (F5-01: copia única desplazada del path de maestras, 1 stroke extra sobre
   Path2D cacheado, E-Ink la omite) y niebla de profundidad (F5-02: mezcla
   O(8) del color de buckets hacia el fondo por elevación + 3 niveles de
   zoom cuantizados que entran en la clave de la capa acumulable; trazo
   0.8 px con niebla profunda) — ambas bajo el toggle «Relieve F5» y
   WYSIWYG en el export vía ExportScene.fogIdx. Hachurado pendiente. */

/* Nota Task 19 (Export vectorial): además de las fases, §6.2 del roadmap —
   Export SVG/PDF (WYSIWYG, 0 dependencias: lista de despliegue compartida →
   serializadores SVG 1.1 y PDF 1.4 propios, FlateDecode vía CompressionStream)
   y estado de vista por URL (#v=1|r=…|az=…|el=…|z=…|p=…|L=…|er=…|fs=…|e=…|s=…)
   con restauración región+cámara+capas post-hidratación. Documentado en
   ROADMAP-0GPU.md §6.2 y README §3. */

/* Nota Task 20 (Design tokens dual Dark/Day): el archivo maestro
   design-tokens.json (DTCG v1.0.0) gobierna ahora la UI completa vía puente
   en globals.css (:root,.dark + .day → --dt-* → puente shadcn) con next-themes
   (clases dark|day, storage ti4go-theme, default dark). El tema conmuta
   también la paleta del LIENZO: ViewOpts.day → DAY_COLORS (paper #EFEFEF,
   acento orange-600/700, gradiente de intermedias invertido) con invalidación
   de capa acumulable por kDay; prioridad de paleta eink > day > estándar. El
   export SVG/PDF replica la paleta activa (WYSIWYG): 'paleta estándar' /
   'paleta día' / 'E-Ink B/N' en metadatos. Ver ROADMAP-UI.md U7 y README §0-b. */

export const ROADMAP_PHASES: RoadmapPhase[] = [
  {
    code: 'F0',
    title: 'Base 0 GPU — rasterizador CPU puro',
    status: 'hecho',
    goal: 'Garantizar que todo píxel sale de Canvas 2D en CPU, con consumo mínimo en reposo.',
    items: [
      'Canvas 2D único rasterizador: sin WebGL, WebGPU ni shaders',
      'Solo primitivas vectoriales (trazos y nodos): sin rellenos ni imágenes del terreno',
      'Render bajo demanda: rAF activo solo al interactuar; reposo = 0 cuadros',
      'Proyección isométrica (ortográfica az/el) evaluada íntegramente en CPU',
      'Culling por bbox de polilínea antes de trazar',
      'DPR limitado a 2 · presupuesto 60 000 seg. escritorio / 26 000 móvil',
      'LOD adaptativo por predicción de coste: intervalo 1 → 2 → 5 m',
      'HUD de telemetría: ms/cuadro, segmentos dibujados, intervalo activo',
      'Pausa total con pestaña oculta (visibilitychange): cancela rAF pendiente',
    ],
    criteria: '2–18 ms/cuadro medidos en escritorio; 0 cuadros en reposo y con pestaña oculta.',
  },
  {
    code: 'F1',
    title: 'Hilo de trabajo — generación off-main-thread',
    status: 'hecho',
    goal: 'Mover la generación del MDT y el marching squares a un Web Worker para no bloquear jamás la UI.',
    items: [
      'Web Worker (terrain.worker.ts) con generación procedural y curvas de nivel',
      'Transferables (Float32Array) para copia cero entre hilos',
      'Cancelación de generación obsoleta por id al cambiar de región en vuelo',
      'Progreso por fases (esculpir → curvas → empaquetado) en el overlay',
      'Fallback síncrono automático si el entorno no ofrece Worker',
    ],
    criteria: 'Hilo principal libre > 90 % durante la regeneración; región < 300 ms sin jank.',
  },
  {
    code: 'F2',
    title: 'Caché de proyección y capas estáticas',
    status: 'hecho',
    goal: 'Reutilizar cómputo entre cuadros: proyectar una vez, trazar muchas.',
    items: [
      'Marching squares optimizado (cell-major + claves enteras): 303 → 69 ms (4.4×) — ✅ hecho',
      'Simplificación Douglas–Peucker en generación (tol 1 m): −44.6 % de vértices — ✅ hecho',
      'Agrupación de trazos de intermedias por bucket de gris: ≤ 8 strokes/cuadro — ✅ hecho',
      'Caché Path2D por polilínea + matriz afín por cota (addPath): 5.9 → 4.1 ms/cuadro (−31 %) a igual estado, render píxel-idéntico — ✅ hecho',
      'Capa de contornos acumulable en OffscreenCanvas (fallback a canvas desconectado) con invalidación por clave numérica de vista: redibujos con vista estable = 1 drawImage — ✅ hecho',
    ],
    criteria: '−40 % de tiempo de cuadro en vistas repetidas frente a F0.',
  },
  {
    code: 'F3',
    title: 'Degradación elegante y presupuesto dinámico',
    status: 'hecho',
    goal: 'Mantener fluidez en equipos modestos reduciendo detalle, nunca congelando la UI.',
    items: [
      'Time-slicing del trazado con presupuesto de 8 ms por cuadro (maestras 25 m primero, intermedias por tandas; escenas baratas permanecen en pase único) — ✅ hecho',
      'Render progresivo con degradación adaptativa: si la escena no termina en 2 cuadros parciales, el intervalo sube en vez de congelar cuadros — ✅ hecho',
      'Presupuesto según hardwareConcurrency / deviceMemory (gama baja detectada): 24 k en sandbox de 2 núcleos — ✅ hecho (F2-C)',
      'Modo Ahorro manual: DPR 1 y tope de 30 cuadros/s durante interacción (toggle en Capas; la capa acumulable se invalida por kDpr) — ✅ hecho',
    ],
    criteria: '≥ 40 FPS sostenidos en móvil gama media durante órbita y pellizco.',
  },
  {
    code: 'F4',
    title: 'Energía, accesibilidad y producto',
    status: 'hecho',
    goal: 'Reducir CPU al mínimo absoluto según contexto y cerrar la capa de producto.',
    items: [
      'prefers-reduced-motion: sin inercia ni animaciones de vuelo (cámara instantánea, suscripción a cambio de la media query) — ✅ hecho',
      'Battery API (feature-detect): Modo Ahorro automático con batería ≤ 20 % sin cargar — ✅ hecho',
      'Pausa al minimizar/ocultar ya activa en F0; auditada: sin otros estados con rAF vivo — ✅ hecho',
      'Presupuesto CPU documentado en la ficha técnica (cajetín CAD + panel móvil + README) — ✅ hecho',
      'Modo E-Ink: paleta B/N puro conmutada por toggle — ✅ hecho',
      'Compresión de semilla MXP1: MDT ≈101 KB → 193–230 chars con checksum — ✅ hecho',
      'Motor DEM Real: strips GeoTIFF (None/LZW/Deflate/PackBits, Int8–Float64, Predictor 1/2, NODATA) → reamuestreo 161×161 anclado por CRS → curvas de nivel y cotas reales en worker, 0 dependencias — ✅ hecho',
      'Export vectorial SVG/PDF WYSIWYG (§6.2): lista de despliegue del último cuadro → SVG 1.1 y PDF 1.4 propios (0 deps, fuentes base-14, FlateDecode nativo) + estado de vista por URL (#v=1) con restauración de región, cámara y capas — ✅ hecho',
    ],
    criteria: '0 trabajo de CPU en reposo, pestaña oculta y con reduced-motion activo.',
  },
  {
    code: 'F5',
    title: 'Calidad visual sin shaders (en curso)',
    status: 'activo',
    goal: 'Enriquecer la estética tipo Blender usando solo trazos vectoriales.',
    items: [
      'Niebla de profundidad simulada: color y grosor por elevación + zoom (3 niveles cuantizados, toggle Relieve F5, WYSIWYG en export) — ✅ hecho (F5-02)',
      'Sombra vectorial falsa: offset de maestras hacia el azimut solar (sol NW, 1 stroke extra sobre Path2D cacheado) — ✅ hecho (F5-01)',
      'Hachurado de pendiente por tramas (solo líneas, opcional) — APROBADO por revisión de ingeniería (revisión de gobernanza v2.1) con inversión export-first: SVG/PDF primero, 0 ms en interactivo; pendiente de ejecución',
    ],
    criteria: 'Mejora percibida de profundidad sin superir el presupuesto de segmentos (sombra: +1 stroke ≤ 1 ms; niebla: O(8) colores).',
  },
];

export const ROADMAP_METRICS: string[] = [
  '≤ 8 ms/cuadro en escritorio (vista general)',
  '≥ 40 FPS sostenidos en móvil gama media durante interacción',
  '0 cuadros en reposo y con pestaña oculta',
  'Generación de región < 300 ms sin bloquear la UI (tras F1)',
];

export const ROADMAP_RISKS: string[] = [
  'Canvas 2D usa un solo hilo → mitigado con Worker (F1) y cachés (F2)',
  'Simplificar polilíneas puede degradar maestras → validar con diag-terrain',
  'Battery/Network API no estándar → aplicar solo con feature-detection',
  'GeoTIFF tiled (COG), Predictor 3 y JPEG/LERC no decodificados → rechazo honesto en ficha; geotiff.js perezoso como escape (F5)',
];

export const STATUS_META: Record<
  RoadmapStatus,
  { label: string; cls: string }
> = {
  hecho: {
    label: 'Hecho',
    cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400',
  },
  activo: {
    label: 'En curso',
    cls: 'border-orange-500/50 bg-orange-500/10 text-orange-400',
  },
  siguiente: {
    label: 'Siguiente',
    cls: 'border-orange-500/50 bg-orange-500/10 text-orange-400',
  },
  planificado: {
    label: 'Planificado',
    cls: 'border-zinc-500/50 bg-zinc-500/10 text-zinc-300',
  },
  exploracion: {
    label: 'Exploración',
    cls: 'border-zinc-500/40 bg-zinc-500/5 text-zinc-400',
  },
};
