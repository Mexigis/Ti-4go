/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simplificación de polilíneas Douglas–Peucker (iterativa, sin recursión).
 *
 * Objetivo (F2 del roadmap 0 GPU): reducir puntos por polilínea sin pérdida
 * visual perceptible en la vista isométrica. Menos vértices ⇒ menos coste de
 * proyección y de trazo por cuadro, y más margen para mantener el intervalo
 * de 1 m dentro del presupuesto de segmentos del LOD.
 *
 * - Tolerancia en metros (unidades del mundo, independientes del zoom).
 * - Los extremos siempre se conservan (las curvas cerradas siguen cerradas).
 * - Iterativo con pila explícita: sin riesgo de desbordar la pila de llamadas.
 * - Caso promedio O(n log n); no asigna objetos en el bucle interno.
 */

/** Tolerancia por defecto del proyecto: 1 m ≈ 0.025 celdas del MDT (40 m). */
export const DEFAULT_SIMPLIFY_TOL = 1;

/**
 * Simplifica una polilína empaquetada [x0,y0,x1,y1,…].
 * Devuelve el mismo Float32Array si nada se recorta (sin copia).
 */
export function simplifyPolyline(pts: Float32Array, tol: number): Float32Array {
  const n = pts.length / 2;
  if (!(tol > 0) || n <= 3) return pts;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const tol2 = tol * tol;
  const stack: number[] = [0, n - 1]; // pares (inicio, fin) — índices de punto

  while (stack.length > 0) {
    const end = stack.pop() as number;
    const start = stack.pop() as number;
    if (end - start < 2) continue;

    const ax = pts[start * 2];
    const ay = pts[start * 2 + 1];
    const bx = pts[end * 2];
    const by = pts[end * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let bestI = -1;
    let bestD2 = tol2;
    for (let i = start + 1; i < end; i++) {
      const px = pts[i * 2];
      const py = pts[i * 2 + 1];
      let d2: number;
      if (len2 === 0) {
        // extremos coincidentes (anillo cerrado): distancia directa
        const ex = px - ax;
        const ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ex = px - (ax + t * dx);
        const ey = py - (ay + t * dy);
        d2 = ex * ex + ey * ey;
      }
      if (d2 > bestD2) {
        bestD2 = d2;
        bestI = i;
      }
    }

    if (bestI > 0) {
      keep[bestI] = 1;
      stack.push(start, bestI, bestI, end);
    }
  }

  let kept = 0;
  for (let i = 0; i < n; i++) if (keep[i]) kept++;
  if (kept === n) return pts; // nada se recortó: evitar copia

  const out = new Float32Array(kept * 2);
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      out[w++] = pts[i * 2];
      out[w++] = pts[i * 2 + 1];
    }
  }
  return out;
}
