/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * Perfil de elevación de rutas (FR-W1 honesto) — librería PURA, sin DOM.
 *
 * Contrato (coherente con DRAPE-1 y la lección «datos falsos apagan la señal»):
 *  1. FUENTE MANDA — si la capa declara z (`zSource === 'declarada'`), el
 *     perfil usa LA z de la fuente, jamás re-anclada.
 *  2. DRAPE MANDA EN SU AUSENCIA — si la capa fue drapeada al MDT
 *     (`draped === true`), la z de cada vértice ES la z del MDT que ya
 *     fijó `applyDrapeToLayers` (el visor fija, el parser jamás). El perfil
 *     NO vuelve a muestrear: consume la copia drapeada para que lo dibujado
 *     y lo perfilar sean bit a bit la misma z.
 *  3. RESPALDO HONESTO — capa sin z y sin drape (sin MDT activo): la serie
 *     se etiqueta «respaldo (sin MDT activo)» y los vértices fuera del MDT
 *     quedan CONTADOS en la ficha (meta.drapeStats.outside), nunca disfrazados.
 *  4. PRESUPUESTO — MAX_PERFIL_PTS con decimación por stride determinista
 *     (siempre conserva primero y último).
 *  5. DETERMINISMO — sin Date/random; el «tramo más largo» se elige por
 *     distancia acumulada con desempate por índice de vértice menor.
 *
 * La distancia es horizontal (metros de escena); el relieve va en z.
 */

/** Presupuesto de puntos del perfil (decimación determinista si excede). */
export const MAX_PERFIL_PTS = 2048;

/** Origen honesto de la z que dibuja el perfil. */
export type PerfilZSource =
  | 'declarada por la fuente (la fuente manda)'
  | 'drapeada al MDT (misma z que el lienzo)'
  | 'respaldo (sin MDT activo — orientativo)';

/** Entrada estructural (acepta GeomLayer drapeada sin importar su módulo). */
export interface PerfilInput {
  verts: Float32Array; // 3·n — xyz en metros de escena (z ya drapeada/declarada)
  segs: Uint32Array; // 2·m — aristas
  zSource?: 'declarada' | 'sin-z';
  draped?: boolean;
  outside?: number; // meta.drapeStats.outside — vértices con respaldo
}

export interface PerfilPt {
  /** Distancia horizontal acumulada del tramo (m). */
  d: number;
  /** Índice del vértice en verts (trazabilidad). */
  i: number;
  /** Cota (m) — ya declarada, drapeada o respaldo según la capa. */
  z: number;
}

/** Tramo contiguo de puntos (los vértices sin z honesta rompen la serie). */
export interface PerfilTramo {
  pts: PerfilPt[];
}

export interface PerfilStats {
  /** Distancia horizontal total del tramo más largo (m). */
  dTotal: number;
  zMin: number;
  zMax: number;
  /** Desnivel acumulado positivo (m) — suma de subidas. */
  gain: number;
  /** Desnivel acumulado negativo en valor absoluto (m) — suma de bajadas. */
  loss: number;
  /** Puntos de la serie (tras decimación). */
  nPts: number;
  /** Vértices de la capa fuera del MDT (respaldo) — de meta.drapeStats. */
  outside: number;
  /** Nº de tramos (cadenas conectadas) que tiene la capa. */
  nTramos: number;
}

export interface PerfilResult {
  tramos: PerfilTramo[];
  stats: PerfilStats;
  source: PerfilZSource;
  /** Índice del vértice inicial del tramo más largo (trazabilidad). */
  tramoStart: number;
}

/** Distancia horizontal entre dos vértices (xy de escena). */
function dist2D(
  verts: Float32Array,
  a: number,
  b: number
): number {
  const dx = verts[b * 3] - verts[a * 3];
  const dy = verts[b * 3 + 1] - verts[a * 3 + 1];
  return Math.hypot(dx, dy);
}

/**
 * Extrae TODAS las cadenas conectadas del grafo de segmentos (O(V+E)).
 * Devuelve listas de índices de vértice en orden de caminata. Los ciclos
 * se caminan desde el índice menor. Determinista.
 */
function extractChains(verts: Float32Array, segs: Uint32Array): number[][] {
  const n = verts.length / 3;
  const m = segs.length / 2;
  if (n === 0 || m === 0) return [];

  // Adyacencia + grado
  const adj: Array<number[]> = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = [];
  const degree = new Uint32Array(n);
  for (let s = 0; s < m; s++) {
    const a = segs[s * 2];
    const b = segs[s * 2 + 1];
    if (a === b || a >= n || b >= n) continue; // hostil: degenerada ⇒ fuera
    adj[a].push(b);
    adj[b].push(a);
    degree[a]++;
    degree[b]++;
  }
  // Canon: vecinos por índice ascendente ⇒ caminata independiente del orden
  // de llegada de los segs (determinismo bit a bit).
  for (let i = 0; i < n; i++) if (adj[i].length > 1) adj[i].sort((x, y) => x - y);

  const visitedEdge = new Set<string>();
  const visitedNode = new Uint8Array(n);
  const chains: number[][] = [];

  const key = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

  /** Camina desde un vértice inicial hasta un callejón sin salida. */
  const walk = (start: number): number[] => {
    const chain: number[] = [start];
    visitedNode[start] = 1;
    let cur = start;
    for (;;) {
      const nexts = adj[cur];
      let next = -1;
      // Determinista: primer vecino (índice ascendente) con arista libre.
      for (const cand of nexts) {
        if (visitedEdge.has(key(cur, cand))) continue;
        next = cand;
        break;
      }
      if (next === -1) break;
      visitedEdge.add(key(cur, next));
      visitedNode[next] = 1;
      chain.push(next);
      cur = next;
    }
    return chain;
  };

  // 1ª pasada: cadenas que nacen en extremos (grado ≠ 2), índice menor primero.
  const endpoints: number[] = [];
  for (let i = 0; i < n; i++) {
    if (degree[i] > 0 && degree[i] !== 2) endpoints.push(i);
  }
  for (const e of endpoints) {
    if (visitedNode[e]) continue;
    // En nodos de grado >2 la caminata arrastra una sola rama; las ramas
    // restantes quedan como cadenas nuevas desde sus extremos.
    const chain = walk(e);
    if (chain.length >= 2) chains.push(chain);
  }
  // 2ª pasada: ciclos puros (todo grado 2) y restos no visitados.
  for (let i = 0; i < n; i++) {
    if (degree[i] === 0 || visitedNode[i]) continue;
    const chain = walk(i);
    if (chain.length >= 2) chains.push(chain);
  }

  return chains;
}

/** Distancia horizontal acumulada de una cadena. */
function chainLength(verts: Float32Array, chain: number[]): number {
  let d = 0;
  for (let k = 1; k < chain.length; k++) d += dist2D(verts, chain[k - 1], chain[k]);
  return d;
}

/** Decimación determinista por stride (conserva primero y último). */
function decimate(chain: number[]): number[] {
  if (chain.length <= MAX_PERFIL_PTS) return chain;
  const stride = Math.ceil(chain.length / MAX_PERFIL_PTS);
  const out: number[] = [];
  for (let k = 0; k < chain.length; k += stride) out.push(chain[k]);
  const last = chain[chain.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** z honesta por vértice según la capa (contrato 1–3 del encabezado). */
function perfilZSource(zSource?: 'declarada' | 'sin-z', draped?: boolean): PerfilZSource {
  if (zSource === 'declarada') return 'declarada por la fuente (la fuente manda)';
  if (draped) return 'drapeada al MDT (misma z que el lienzo)';
  return 'respaldo (sin MDT activo — orientativo)';
}

/**
 * Construye el perfil del TRAMO MÁS LARGO de la capa (por distancia
 * horizontal). Serie vacía ⇒ stats en 0 y tramos [] (honesto, no lanza).
 */
export function buildPerfil(layer: PerfilInput): PerfilResult {
  const { verts, segs } = layer;
  const source = perfilZSource(layer.zSource, layer.draped);
  const outside = layer.outside ?? 0;
  const empty: PerfilResult = {
    tramos: [],
    stats: { dTotal: 0, zMin: 0, zMax: 0, gain: 0, loss: 0, nPts: 0, outside, nTramos: 0 },
    source,
    tramoStart: -1,
  };
  if (verts.length < 6 || segs.length < 4) return empty; // <2 vértices con 1 arista

  const chains = extractChains(verts, segs);
  if (chains.length === 0) return { ...empty, stats: { ...empty.stats, outside } };

  // Tramo más largo: distancia acumulada; desempate por primer índice menor.
  let best = chains[0];
  let bestD = chainLength(verts, best);
  for (let c = 1; c < chains.length; c++) {
    const d = chainLength(verts, chains[c]);
    if (d > bestD || (d === bestD && chains[c][0] < best[0])) {
      best = chains[c];
      bestD = d;
    }
  }

  const picked = decimate(best);
  const pts: PerfilPt[] = [];
  let d = 0;
  pts.push({ d: 0, i: picked[0], z: verts[picked[0] * 3 + 2] });
  for (let k = 1; k < picked.length; k++) {
    d += dist2D(verts, picked[k - 1], picked[k]);
    pts.push({ d, i: picked[k], z: verts[picked[k] * 3 + 2] });
  }
  const tramos: PerfilTramo[] = [{ pts }];

  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  let gain = 0;
  let loss = 0;
  for (let k = 0; k < pts.length; k++) {
    const z = pts[k].z;
    if (Number.isFinite(z)) {
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    if (k > 0) {
      const dz = pts[k].z - pts[k - 1].z;
      if (dz > 0) gain += dz;
      else loss += -dz;
    }
  }
  if (!Number.isFinite(zMin)) zMin = 0;
  if (!Number.isFinite(zMax)) zMax = 0;

  return {
    tramos,
    stats: {
      dTotal: d,
      zMin,
      zMax,
      gain,
      loss,
      nPts: pts.length,
      outside,
      nTramos: chains.length,
    },
    source,
    tramoStart: picked[0],
  };
}

/** Etiqueta de fuente para la ficha (misma voz que la fila «Z» del cajetín). */
export function perfilSourceLabel(source: PerfilZSource): string {
  return source;
}

/** Resumen textual accesible (aria-label del lienzo del perfil). */
export function perfilAriaLabel(res: PerfilResult | null): string {
  if (!res || res.stats.nPts < 2) return 'Perfil de elevación: sin rutas ingestadas todavía';
  const s = res.stats;
  const fmt = (n: number, d = 0) =>
    n.toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d });
  return (
    `Perfil de elevación: ${fmt(s.dTotal / 1000, 2)} km, ` +
    `cota ${fmt(s.zMin)} a ${fmt(s.zMax)} m, ` +
    `subida ${fmt(s.gain)} m, bajada ${fmt(s.loss)} m. ` +
    `Cota ${res.source}.` +
    (s.outside > 0 ? ` ${s.outside} vértices fuera del MDT conservaron respaldo.` : '')
  );
}
