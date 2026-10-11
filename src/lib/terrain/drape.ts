/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DRAPE-1 · «la capa viva sobre las curvas» — drape por muestreo de MDT.
 *
 * Directiva del propietario (checkpoint de ingeniería):
 * el terreno de Ti-4GO es el SUELO de la plataforma — la capa viva aplica a
 * CADA pantalla de IGNIS. Contrato técnico de esta unidad:
 *
 *   1. Un feature SIN elevación declarada se DRapea por muestreo del MDT
 *      activo: z = z_terreno (bilineal, sampleGrid del motor) y un LIFT de
 *      pantalla de 2–3 px (DRAPE_LIFT_PX = 2.5) para que la tinta no se
 *      entierre en la curva que la porta.
 *   2. Un feature CON elevación declarada usa SU cota (jamás se toca) —
 *      provenance src=1; el drape nunca sobrescribe un dato del producto.
 *   3. Densificación preservando índices: los vértices originales mantienen
 *      SU índice (endpoints compartidos siguen compartidos); los puntos
 *      interiores de cada arista se insertan al final con paso ≤ maxStepM
 *      (½ celda del MDT) para que la línea TREPE las curvas correctas en
 *      lugar de cortar el valle en cuerda. Presupuestos duros.
 *   4. E-Ink-first: el drape es GEOMETRÍA (z + lift de pantalla) — no
 *      introduce color, glifo ni discontinuidad nueva. La gramática D11
 *      (route_class + confidence) se resuelve aguas arriba intacta.
 *
 * 0 GPU · 0 deps · determinista: misma (geometría, sampler, maxStep) ⇒
 * mismos buffers byte a byte. El sampler es CONTRATO total (bilineal con
 * clamp al borde, como sampleGrid): si devuelve no-finito, la señal NaN se
 * preserva — honestidad antes que invención.
 */

/** Lift de pantalla para vértices drapeados (px) — dentro del rango 2–3. */
export const DRAPE_LIFT_PX = 2.5 as const;

/** Presupuesto por arista: máximo de subdivisiones (denso pero acotado). */
export const DRAPE_MAX_SUBDIV = 32 as const;

/** Presupuesto global de vértices interiores añadidos (≈ ⅔ de MAX_VERTS). */
export const DRAPE_MAX_EXTRA_VERTS = 200_000 as const;

/** Provenance por vértice: 0 = MDT (drapeado, lleva lift) · 1 = declarada. */
export type DrapeSrc = 0 | 1;

export interface DrapeGeom {
  /** Vértices [x,y,z]×n — x/y intactos; z = declarada o terreno. */
  verts: Float32Array;
  /** Aristas reencadenadas (pares de índices) con los interiores insertados. */
  segs: Uint32Array;
  /** Provenance por vértice (mismo índice que verts). */
  src: Uint8Array;
  /** Vértices con cota declarada (dato del producto, sin lift). */
  declaredCount: number;
  /** Vértices drapeados desde el MDT (incluye interiores). */
  mdtCount: number;
  /** Vértices interiores añadidos por densificación. */
  extraVerts: number;
  /** true si el presupuesto global cortó la densificación (aristas rectas). */
  budgetHit: boolean;
}

/**
 * Drapea una geometría ingestada sobre el MDT activo.
 *
 * `sampler(xM, yM)` → z del terreno (m). `maxStepM` paso máximo de
 * densificación (recomendado: cellM/2 del grid activo).
 *
 * Devuelve `null` si NINGÚN vértice carece de cota (capa 100 % declarada ⇒
 * passthrough de costo cero — el overlay usa la geometría original).
 */
export function drapeGeom(
  verts: Float32Array,
  segs: Uint32Array,
  sampler: (xM: number, yM: number) => number,
  maxStepM: number
): DrapeGeom | null {
  const n = verts.length / 3;
  if (n === 0) return null;

  /* --- pasada 1: ¿hay vértices sin cota? ---------------------------- */
  let sinCota = 0;
  for (let i = 0; i < n; i++) if (!Number.isFinite(verts[i * 3 + 2])) sinCota++;
  if (sinCota === 0) return null;

  /* --- pasada 2: copia con z resuelta (declarada gana) --------------- */
  const out = new Float32Array(verts); // x/y intactos byte a byte
  const src = new Uint8Array(n);
  let declared = 0;
  let mdt = 0;
  for (let i = 0; i < n; i++) {
    const z = verts[i * 3 + 2];
    if (Number.isFinite(z)) {
      src[i] = 1;
      declared++;
    } else {
      out[i * 3 + 2] = sampler(out[i * 3], out[i * 3 + 1]);
      src[i] = 0;
      mdt++;
    }
  }

  /* --- pasada 3: densificación preservando índices -------------------
   * Los vértices originales conservan su índice (0..n-1); los interiores
   * se apéndan al final. Aristas compartidas siguen compartiendo endpoint.
   * El tope por arista (DRAPE_MAX_SUBDIV) es normalización, no fallo;
   * budgetHit solo se enciende cuando el PRESUPUESTO GLOBAL se agota —
   * las aristas restantes se emiten rectas (honesto y acotado). */
  const extra: number[] = [];
  const segsOut: number[] = [];
  const step = Math.max(maxStepM, 1e-6);
  let budgetHit = false;
  for (let k = 0; k + 1 < segs.length; k += 2) {
    const a = segs[k];
    const b = segs[k + 1];
    if (a >= n || b >= n) {
      // arista fuera de rango (hostil de ingesta): se copia tal cual
      segsOut.push(a, b);
      continue;
    }
    const ax = out[a * 3];
    const ay = out[a * 3 + 1];
    const bx = out[b * 3];
    const by = out[b * 3 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    let nSub = Math.floor(len / step);
    if (nSub > DRAPE_MAX_SUBDIV) nSub = DRAPE_MAX_SUBDIV;
    if (nSub < 1) nSub = 1;
    const extrasHere = nSub - 1;
    const globalLeft = DRAPE_MAX_EXTRA_VERTS - extra.length / 3;
    if (extrasHere > 0 && extrasHere <= globalLeft) {
      let prev = a;
      for (let s = 1; s <= extrasHere; s++) {
        const t = s / nSub;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        const idx = n + extra.length / 3;
        extra.push(x, y, sampler(x, y));
        segsOut.push(prev, idx);
        prev = idx;
      }
      segsOut.push(prev, b);
    } else {
      if (extrasHere > 0) budgetHit = true;
      segsOut.push(a, b);
    }
  }

  const extraVerts = extra.length / 3;
  const vertsOut = new Float32Array((n + extraVerts) * 3);
  vertsOut.set(out, 0);
  if (extraVerts > 0) vertsOut.set(extra, n * 3);
  // src: los interiores son SIEMPRE mdt (src=0) — un Uint8Array ya nace en 0.
  const srcOut = new Uint8Array(n + extraVerts);
  srcOut.set(src, 0);

  return {
    verts: vertsOut,
    segs: new Uint32Array(segsOut),
    src: srcOut,
    declaredCount: declared,
    mdtCount: mdt + extraVerts,
    extraVerts,
    budgetHit,
  };
}

/** ¿Está el vértice i drapeado (lleva lift de pantalla)? */
export function drapeLifted(src: Uint8Array, i: number): boolean {
  return src[i] === 0;
}
