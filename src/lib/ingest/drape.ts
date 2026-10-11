/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DRAPE-1 — Drapeado de features sin elevación declarada al MDT del lienzo.
 *
 * Contrato (checkpoint de ingeniería · directiva de visión, ):
 *  «feature sin elevación ⇒ z = z_terreno (MDT) + offset 2–3 px;
 *   feature con elevación declarada ⇒ se usa el valor declarado».
 *
 * Reglas:
 *  1. DETECCIÓN — `zDeclaredInSource`: la fuente declara elevación si existe
 *     al menos un z finito Y el rango (max−min sobre finitos) supera el
 *     épsilon. Una columna z plana (todo 0, todo igual) NO declara relieve:
 *     es candidata a drape, nunca «cota real».
 *  2. DRAPE — `drapeVertsToTerrain`: cada vértice (x,y) de escena se muestrea
 *     en el MDT activo con el sampler HONESTO (null fuera de cobertura —
 *     gps.sampleGridZ). Vértice fuera del MDT ⇒ conserva su z de respaldo
 *     (zMid del anclaje) y se cuenta en `outside`; NO se inventa cota
 *     (lección del checkpoint: «datos falsos apagan la señal que los corrige»).
 *  3. LIFT — `DRAPE_LIFT_PX = 2.5` px EN PANTALLA, aplicado en el dibujo
 *     (overlay), NO en metros: zoom-invariante por construcción — la línea
 *     drapeada flota a 2.5 px sobre las curvas a cualquier zoom (decisión
 *     documentada del checkpoint: «lift 2.5 px zoom-invariante»).
 *  4. FUENTE MANDA — capas con z declarada jamás se reescriben; el drape solo
 *     toca capas `zSource === 'sin-z'`.
 *
 * Determinista: mismo input + mismo MDT ⇒ mismos vértices (sin aleatorio,
 * sin tiempo). No muta la geometría ingerida: devuelve una copia nueva para
 * que el re-drape (cambio de región / DEM real) parta siempre del original.
 *
 * 0 dependencias · Canvas-free · testeable en bun (forense_drape).
 */

/** Elevación en píxeles de pantalla del lift del drape (rango del contrato: 2–3). */
export const DRAPE_LIFT_PX = 2.5;

/** Umbral de dispersión z (m) para considerar que la fuente declara relieve. */
export const DRAPE_EPS_Z = 1e-6;

/** Fuente de la z de la capa: declarada por el archivo o sin-z (drape). */
export type ZSource = 'declarada' | 'sin-z';

/**
 * ¿La fuente declara elevación? Regla 1 del contrato. Acepta cualquier
 * array-like de z en unidades de la fuente (ya mapeadas o crudas): la
 * dispersión relativa es invariante al mapeo afín.
 */
export function zDeclaredInSource(zs: ArrayLike<number>): boolean {
  const n = zs.length;
  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  for (let i = 0; i < n; i++) {
    const z = zs[i];
    if (Number.isFinite(z)) {
      finite++;
      if (z < min) min = z;
      if (z > max) max = z;
    }
  }
  // Sin ningún z finito ⇒ no hay elevación declarada.
  if (finite === 0) return false;
  // Rango por debajo del épsilon ⇒ z plana ⇒ sin relieve declarado.
  return max - min > DRAPE_EPS_Z;
}

/** Estadísticas honestas del drape (para la ficha y la QA). */
export interface DrapeStats {
  /** Vértices anclados al MDT (z reescrita por el sampler). */
  drapped: number;
  /** Vértices fuera del MDT o con sampler no finito ⇒ conservaron respaldo. */
  outside: number;
  /** Total de vértices procesados. */
  total: number;
}

export interface DrapeResult {
  /** COPIA nueva con la z drapeada (el original no se muta). */
  verts: Float32Array;
  stats: DrapeStats;
}

/**
 * Drapea TODOS los vértices al MDT (regla 2). El sampler devuelve la z del
 * terreno en metros de escena o null fuera de cobertura — un null conserva
 * la z de respaldo del vértice (zMid del anclaje) y suma a `outside`.
 *
 * Nota de diseño: NO acepta un «z de respaldo» global — cada vértice conserva
 * SU z previa, de modo que un drape parcial nunca crea planos falsos.
 */
export function drapeVertsToTerrain(
  verts: Float32Array,
  sampler: (x: number, y: number) => number | null
): DrapeResult {
  const n = verts.length / 3;
  const out = new Float32Array(verts.length);
  let drapped = 0;
  let outside = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const x = verts[a];
    const y = verts[a + 1];
    const zPrev = verts[a + 2];
    out[a] = x;
    out[a + 1] = y;
    const z = sampler(x, y);
    if (z !== null && Number.isFinite(z)) {
      out[a + 2] = z;
      drapped++;
    } else {
      out[a + 2] = zPrev;
      outside++;
    }
  }
  return { verts: out, stats: { drapped, outside, total: n } };
}

/**
 * Regla del contrato para elegir el camino de una capa:
 *  - 'declarada' ⇒ la fuente manda (sin drape, sin lift).
 *  - 'sin-z'     ⇒ drapeada al MDT + lift de pantalla.
 */
export function drapeAppliesTo(zSource: ZSource | undefined): boolean {
  return zSource === 'sin-z';
}

/** Etiqueta de la ficha de auditoría (fila «Z») según la fuente de la z. */
export function zSourceLabel(zs: ZSource): string {
  return zs === 'declarada'
    ? 'declarada por la fuente (la fuente manda — sin drape)'
    : `sin Z declarada ⇒ drapeada al MDT (lift ${DRAPE_LIFT_PX} px en pantalla)`;
}

/* ------------------------------------------------------------------ */
/* Aplicación por capa (hilo principal — el MDT vive en el visor)      */
/* ------------------------------------------------------------------ */

import type { GeomLayer } from '@/components/terrain/ingest';

/** GeomLayer lista para dibujar con el estado del drape anotado en meta
 *  (draped/drapeStats viven en IngestMeta desde el re-landing DRAPE-1). */
export type DrapedLayer = GeomLayer;

/**
 * Aplica el contrato DRAPE-1 a un lote de capas contra el MDT activo:
 *  - 'declarada' ⇒ la capa pasa INTACTA (la fuente manda).
 *  - 'sin-z'     ⇒ verts re-muestreados al MDT (copia nueva; el original
 *                  ingerido no se toca — el re-drape parte siempre del
 *                  original cuando cambia la región o llega un DEM real).
 *
 * El sampler es `(x,y) => number | null` (p. ej. gps.sampleGridZ sobre el
 * grid del modelo activo). Sin MDT (grid null) ⇒ capas intactas honestas:
 * sin terreno no hay drape, el lift tampoco se aplica (nada flota sobre
 * nada — la ficha ya declaró la intención).
 */
export function applyDrapeToLayers(
  layers: GeomLayer[],
  sampler: ((x: number, y: number) => number | null) | null
): DrapedLayer[] {
  return layers.map((layer) => {
    if (!drapeAppliesTo(layer.meta.zSource)) return layer as DrapedLayer;
    if (!sampler) return layer as DrapedLayer;
    const res = drapeVertsToTerrain(layer.geom.verts, sampler);
    return {
      ...layer,
      geom: { ...layer.geom, verts: res.verts },
      meta: { ...layer.meta, draped: true, drapeStats: res.stats },
    } satisfies DrapedLayer;
  });
}
