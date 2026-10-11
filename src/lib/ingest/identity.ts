/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-2 — Identidad canónica y validación cruzada par-a-par por UUID
 * (agenda FR 1.0 · orden fijo del propietario · checkpoint de ingeniería).
 *
 * La identidad geográfica canónica es el **BBox WGS84** producido por FR-1
 * (y por el parser KML, que siempre es WGS84 por especificación OGC 07-147r2).
 * El cruce par-a-par empareja features **por UUID** entre fuentes distintas
 * (A GeoJSON ↔ B GeoJSON ↔ KML) y emite un veredicto por par:
 *
 *   - MATCH                  — BBox cuantizado idéntico.
 *   - CODIFICACION_DISTINTA  — el BBox cuantizado difiere pero la discrepancia
 *                              cabe en la banda de codificación (p.ej. una
 *                              fuente venía en UTM 14N y la otra en grados
 *                              nativos): **pase con nota** (regla del
 *                              checkpoint — no es fallo).
 *   - DIVERGE                — discrepancia fuera de la banda ⇒ **fallo** de
 *                              calidad de datos (estado visible en LIENZO por
 *                              H-4, diseño registrado en FR-3).
 *   - SIN_PAR                — no hay par comparable (UUID ausente en alguna
 *                              de las dos caras) — nota honesta, no fallo.
 *
 * Determinista: mismas entradas ⇒ mismo veredicto y misma nota byte a byte.
 * 0 GPU · CPU puro · sin dependencias.
 */

/* ------------------------------------------------------------------ */
/* Tipos                                                              */
/* ------------------------------------------------------------------ */

export interface BBoxWgs84 {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

/** Cara de cruce: la ficha mínima de una feature para validar identidad. */
export interface IdentityFeature {
  /** UUID canónico (minúsculas) o null si la fuente no declara uno. */
  uuid: string | null;
  /** Nombre legible (trazabilidad en la nota). */
  name: string;
  /** Fuente declarada: 'A' | 'B' | 'K' (KML) — solo para la nota. */
  source: 'A' | 'B' | 'K';
  kind: 'punto' | 'linea' | 'poligono';
  bbox: BBoxWgs84;
  vertexCount: number;
}

export type CrossVerdict =
  | 'MATCH'
  | 'CODIFICACION_DISTINTA'
  | 'DIVERGE'
  | 'SIN_PAR';

export interface CrossReport {
  uuid: string;
  a: { source: 'A' | 'B' | 'K'; name: string };
  b: { source: 'A' | 'B' | 'K'; name: string };
  verdict: CrossVerdict;
  /** Nota honesta: vacía para MATCH; describe la discrepancia en las demás. */
  note: string;
  /** Desviación máxima en metros (equirect local, banda de codificación). */
  maxDeltaM: number;
}

/* ------------------------------------------------------------------ */
/* Cuantización y bandas                                              */
/* ------------------------------------------------------------------ */

/**
 * Cuantización de identidad: 1e-6 grados ≈ 0.11 m en latitud 21° — órden
 * de la precisión de representación decimal (6 decimales) y muy por debajo
 * de la banda de codificación. Dos fuentes que describen el MISMO trazo
 * cuantizan igual salvo artefactos de codificación.
 */
export const QUANT_DEG = 1e-6;

/**
 * Banda de CODIFICACION_DISTINTA: 2.0 m. Justificación registrada: el
 * round-trip UTM⇄WGS84 de FR-1 cota ≤ 0.17 mm; las diferencias de
 * digitalización entre fuentes del mismo pack (origen UTM vs grados,
 * distinto número de decimales) se observan en el orden de décimas a
 * unidades de metro. > 2 m ya no es codificación: es geometría distinta.
 */
export const BANDA_CODIFICACION_M = 2.0;

/** Metros por grado — constantes equirectangulares (idénticas al FR-1). */
const M_PER_DEG_LAT = 110540;

function mPerDegLon(latDeg: number): number {
  const c = Math.cos((Math.max(-89.5, Math.min(89.5, latDeg)) * Math.PI) / 180);
  return Math.max(1, 111320 * c);
}

/** Cuantiza un BBox a la rejilla de identidad (redondeo al múltiplo). */
export function quantizeBBox(b: BBoxWgs84, q: number = QUANT_DEG): BBoxWgs84 {
  const r = (v: number): number => Math.round(v / q) * q;
  return {
    lonMin: r(b.lonMin),
    lonMax: r(b.lonMax),
    latMin: r(b.latMin),
    latMax: r(b.latMax),
  };
}

/* ------------------------------------------------------------------ */
/* UUID canónico                                                      */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Normaliza un UUID declarado a su forma canónica (minúsculas, sin llaves
 * ni urn:). Devuelve null si no es reconocible — **no** es hostilidad del
 * archivo: es una feature sin par comparable (SIN_PAR, nota honesta).
 * Acepta: forma canónica, {con-llaves}, urn:uuid:, mayúsculas.
 */
export function normalizeUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (s.startsWith('urn:uuid:')) s = s.slice(9);
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  if (!UUID_RE.test(s)) return null;
  return s;
}

/* ------------------------------------------------------------------ */
/* Cruce par-a-par                                                    */
/* ------------------------------------------------------------------ */

/** Máxima desviación entre dos BBox en metros (equirect local al centro). */
function bboxDeltaM(p: BBoxWgs84, q: BBoxWgs84): number {
  const latMid = (Math.max(p.latMin, q.latMin) + Math.min(p.latMax, q.latMax)) / 2;
  const mLon = mPerDegLon(latMid);
  const dLon = Math.max(
    Math.abs(p.lonMin - q.lonMin) * mLon,
    Math.abs(p.lonMax - q.lonMax) * mLon
  );
  const dLat = Math.max(
    Math.abs(p.latMin - q.latMin) * M_PER_DEG_LAT,
    Math.abs(p.latMax - q.latMax) * M_PER_DEG_LAT
  );
  return Math.max(dLon, dLat);
}

const fmt = (v: number): string =>
  v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

/**
 * Veredicto de una pareja (misma feature declarada en dos fuentes).
 * Regla del checkpoint (contrato FR-2/FR-3):
 *   - Cuantización igual ⇒ MATCH.
 *   - Dentro de la banda de codificación ⇒ CODIFICACION_DISTINTA (pase con
 *     nota) — el cruce cross-CRS por diseño produce esta clase.
 *   - Fuera de la banda, o semántica de geometría distinta ⇒ DIVERGE.
 */
export function crossPair(a: IdentityFeature, b: IdentityFeature): CrossReport {
  const headA = { source: a.source, name: a.name };
  const headB = { source: b.source, name: b.name };
  if (!a.uuid || !b.uuid) {
    return {
      uuid: a.uuid ?? b.uuid ?? '',
      a: headA,
      b: headB,
      verdict: 'SIN_PAR',
      note: 'UUID ausente en una de las fuentes — cruce no aplicable a esta feature',
      maxDeltaM: NaN,
    };
  }
  if (a.uuid !== b.uuid) {
    // Llamada indebida: el cruce es POR UUID; se reporta SIN_PAR con nota.
    return {
      uuid: `${a.uuid}≠${b.uuid}`,
      a: headA,
      b: headB,
      verdict: 'SIN_PAR',
      note: 'Los UUID no coinciden — el cruce par-a-par es por UUID',
      maxDeltaM: NaN,
    };
  }
  if (a.kind !== b.kind) {
    return {
      uuid: a.uuid,
      a: headA,
      b: headB,
      verdict: 'DIVERGE',
      note: `Semántica de geometría distinta: ${a.kind} vs ${b.kind}`,
      maxDeltaM: NaN,
    };
  }
  const qa = quantizeBBox(a.bbox);
  const qb = quantizeBBox(b.bbox);
  if (
    qa.lonMin === qb.lonMin &&
    qa.lonMax === qb.lonMax &&
    qa.latMin === qb.latMin &&
    qa.latMax === qb.latMax
  ) {
    return {
      uuid: a.uuid,
      a: headA,
      b: headB,
      verdict: 'MATCH',
      note: '',
      maxDeltaM: bboxDeltaM(a.bbox, b.bbox),
    };
  }
  const d = bboxDeltaM(a.bbox, b.bbox);
  if (Number.isFinite(d) && d <= BANDA_CODIFICACION_M) {
    return {
      uuid: a.uuid,
      a: headA,
      b: headB,
      verdict: 'CODIFICACION_DISTINTA',
      note: `Pase con nota: desviación ${fmt(d)} m dentro de la banda de codificación (${fmt(BANDA_CODIFICACION_M)} m) — codificación distinta, geometría equivalente`,
      maxDeltaM: d,
    };
  }
  return {
    uuid: a.uuid,
    a: headA,
    b: headB,
    verdict: 'DIVERGE',
    note: Number.isFinite(d)
      ? `Desviación ${fmt(d)} m fuera de la banda (${fmt(BANDA_CODIFICACION_M)} m) — geometrías distintas para el mismo UUID`
      : 'Desviación no finita — coordenadas corruptas en alguna fuente',
    maxDeltaM: d,
  };
}

/* ------------------------------------------------------------------ */
/* Cruce triangular A ↔ B ↔ K                                         */
/* ------------------------------------------------------------------ */

export interface TriangleReport {
  pares: CrossReport[];
  /** Resumen determinista: conteo por veredicto. */
  conteo: { MATCH: number; CODIFICACION_DISTINTA: number; DIVERGE: number; SIN_PAR: number };
  /** false si existe al menos un DIVERGE. */
  ok: boolean;
}

/**
 * Empareja por UUID las features de las tres fuentes y evalúa los tres
 * pares del triángulo (A↔B, A↔K, B↔K). Las features sin UUID se listan
 * como SIN_PAR una sola vez por fuente (nota honesta, no fallo).
 */
export function crossTriangle(
  a: IdentityFeature[],
  b: IdentityFeature[],
  k: IdentityFeature[]
): TriangleReport {
  const byUuid = (
    list: IdentityFeature[]
  ): Map<string, IdentityFeature> => {
    const m = new Map<string, IdentityFeature>();
    for (const f of list) if (f.uuid) m.set(f.uuid, f);
    return m;
  };
  const ma = byUuid(a);
  const mb = byUuid(b);
  const mk = byUuid(k);

  const pares: CrossReport[] = [];
  const evalPair = (
    x: IdentityFeature[],
    y: IdentityFeature[],
    mx: Map<string, IdentityFeature>,
    my: Map<string, IdentityFeature>
  ): void => {
    const seen = new Set<string>();
    for (const f of x) {
      if (!f.uuid || seen.has(f.uuid)) continue;
      seen.add(f.uuid);
      const g = my.get(f.uuid);
      if (g) pares.push(crossPair(f, g));
      else
        pares.push({
          uuid: f.uuid,
          a: { source: f.source, name: f.name },
          b: { source: y[0]?.source ?? 'B', name: '—' },
          verdict: 'SIN_PAR',
          note: `UUID sin contraparte en la fuente ${y[0]?.source ?? 'B'} — nota honesta`,
          maxDeltaM: NaN,
        });
    }
    for (const f of y) {
      if (!f.uuid || seen.has(f.uuid)) continue;
      seen.add(f.uuid);
      if (!mx.has(f.uuid))
        pares.push({
          uuid: f.uuid,
          a: { source: x[0]?.source ?? 'A', name: '—' },
          b: { source: f.source, name: f.name },
          verdict: 'SIN_PAR',
          note: `UUID sin contraparte en la fuente ${x[0]?.source ?? 'A'} — nota honesta`,
          maxDeltaM: NaN,
        });
    }
  };
  // mx/my pasan sin uso directo (por construcción my===porUuid(y)); el
  // parámetro documenta la intención simétrica del triángulo.
  void ma;
  void mb;
  void mk;

  evalPair(a, b, ma, mb);
  evalPair(a, k, ma, mk);
  evalPair(b, k, mb, mk);

  const conteo = { MATCH: 0, CODIFICACION_DISTINTA: 0, DIVERGE: 0, SIN_PAR: 0 };
  for (const p of pares) conteo[p.verdict]++;
  return { pares, conteo, ok: conteo.DIVERGE === 0 };
}
