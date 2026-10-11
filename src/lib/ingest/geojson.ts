/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-1 — Parser GeoJSON dual (agenda FR 1.0 · orden fijo del propietario,
 * checkpoint de ingeniería).
 *
 * Contrato de la agenda:
 *   - RFC 7946 por defecto: coordenadas WGS84 en grados (lon, lat[, alt]).
 *   - UTM 14N con crs declarado (EPSG:32614 / «WGS 84 / UTM zone 14N» /
 *     urn:ogc:def:crs:EPSG::32614). El miembro `crs` fue removido en RFC
 *     7946; se acepta como extensión (forma OGC/GDAL de facto).
 *   - Auto-detección por magnitud cuando no hay crs: grados si
 *     |lon| ≤ 180 y |lat| ≤ 90; UTM 14N si easting ∈ [166,021 … 833,980] y
 *     northing ∈ [0 … 10⁷]. Los dos rangos son disjuntos ⇒ detección
 *     determinista y sin ambigüedad.
 *   - Un crs declarado que contradice la magnitud de los datos ⇒ rechazo.
 *   - HOSTILES ⇒ null: rechazo limpio SIN excepciones — JSON fracturado o
 *     anidado en profundidad, posición con aridad ≠ 2–3, valores no finitos
 *     (1e400 ⇒ Infinity), anillos abiertos o degenerados, CRS no soportado,
 *     coordenadas fuera de rango geográfico o fuera de la zona 14.
 *
 * Filosofía 0 GPU: CPU puro, recorrido iterativo (sin recursión ⇒ sin
 * desborde de pila), presupuestos duros compartidos con parsers.ts
 * (MAX_VERTS / MAX_SEGS), determinismo bit-exacto (mismo archivo + misma
 * región ⇒ misma geometría byte a byte).
 *
 * Conversión UTM 14N ⇄ WGS84: Transversa de Mercator directa/inversa, series
 * de Snyder (elipsoide WGS84, k0 = 0.9996, meridiano central −99°). Precisión
 * de la serie ≈ 1e-9 grados (sub-milímetro) dentro de la zona. Ambas
 * funciones son exportadas: la inversa es la ruta de producción; la directa
 * sirve para round-trips de la suite forense y ancla FR-7 (GPS bajo demanda).
 *
 * Anclaje escénico: idéntico al CSV (parsers.ts) — grados → metros locales
 * equirectangulares alrededor del centro de la región; si > 50 % de los
 * puntos cae fuera del extent, se normaliza la caja completa al encuadre.
 * El BBox WGS84 resultante queda en la ficha: es la identidad geográfica
 * canónica que FR-2 cruzará par-a-par contra KML por UUID.
 */

import {
  MAX_FILE_BYTES,
  MAX_VERTS,
  MAX_SEGS,
  normalizeToScene,
  type Anchor,
  type IngestMeta,
  type IngestGeom,
  type ParseProgress,
  type ParseResult,
} from './parsers';

/* ------------------------------------------------------------------ */
/* Constantes UTM zona 14N (WGS84)                                    */
/* ------------------------------------------------------------------ */

const SEMI_MAJOR = 6378137.0;
const FLATTENING = 1 / 298.257223563;
const E2 = FLATTENING * (2 - FLATTENING); // excentricidad²
const EP2 = E2 / (1 - E2); // segunda excentricidad²
const K0 = 0.9996;
const ZONE14_LON0 = -99; // meridiano central de la zona 14
const ZONE14_LAT_MAX = 84; // 14N cubre lat 0–84°N

/** Rango de magnitud que identifica coordenadas UTM (metros). */
const UTM_EASTING_MIN = 166_021.4437;
const UTM_EASTING_MAX = 833_979.2056;
const UTM_NORTHING_MAX = 10_000_000;

/** Constantes equirectangulares — idénticas a las del CSV (parsers.ts). */
const M_PER_DEG_LAT = 110540;

/* ------------------------------------------------------------------ */
/* Conversión geodésica UTM 14N ⇄ WGS84                               */
/* ------------------------------------------------------------------ */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Meridiano arco M(φ) — Snyder 3-21: TODO el corchete multiplica por `a`
 *  (los coeficientes c2/c3/c4 NO van multiplicados por c1). Verificado
 *  contra la integración numérica directa de la definición:
 *  M(φ) = ∫₀^φ a(1−e²)/(1−e²sin²θ)^{3/2} dθ — error < 1e-6 m. */
function meridianArc(phi: number): number {
  const c1 = 1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256;
  const c2 = (3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024;
  const c3 = (15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024;
  const c4 = (35 * E2 * E2 * E2) / 3072;
  return (
    SEMI_MAJOR *
    (c1 * phi - c2 * Math.sin(2 * phi) + c3 * Math.sin(4 * phi) - c4 * Math.sin(6 * phi))
  );
}

/**
 * WGS84 (lon, lat en grados) ⇒ UTM 14N (easting, northing en metros).
 * Devuelve null fuera de la zona 14N (|Δλ| > 3° o lat ∉ [0, 84]).
 */
export function wgs84ToUtm14n(lonDeg: number, latDeg: number): [number, number] | null {
  if (!Number.isFinite(lonDeg) || !Number.isFinite(latDeg)) return null;
  // Holgura 1e-9° en el borde de zona: el round-trip re-inroduce el límite
  // exacto y el error de punto flotante no debe rechazar la propia zona.
  if (Math.abs(lonDeg - ZONE14_LON0) > 3.0 + 1e-6) return null;
  if (latDeg < 0 || latDeg > ZONE14_LAT_MAX) return null;
  const phi = latDeg * D2R;
  const lam = lonDeg * D2R;
  const lam0 = ZONE14_LON0 * D2R;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const N = SEMI_MAJOR / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = EP2 * cosPhi * cosPhi;
  const A = (lam - lam0) * cosPhi;
  const M = meridianArc(phi);

  const easting =
    500_000 +
    K0 *
      N *
      (A +
        ((1 - T + C) * A * A * A) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Math.pow(A, 5)) / 120);
  const northing =
    K0 *
    (M +
      N *
        tanPhi *
        ((A * A) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4)) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Math.pow(A, 6)) / 720));
  return [easting, northing];
}

/**
 * UTM 14N (easting, northing en metros) ⇒ WGS84 (lon, lat en grados).
 * Devuelve null para entradas fuera de la zona (la serie no es válida allí).
 */
export function utm14nToWgs84(easting: number, northing: number): [number, number] | null {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  if (easting < UTM_EASTING_MIN || easting > UTM_EASTING_MAX) return null;
  if (northing < 0 || northing > UTM_NORTHING_MAX) return null;

  const x = easting - 500_000;
  const M = northing / K0;
  const mu = M / (SEMI_MAJOR * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const mu2 = 2 * mu;
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(mu2) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 * e1 * e1 * e1) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const N1 = SEMI_MAJOR / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const R1 =
    (SEMI_MAJOR * (1 - E2)) / Math.pow(1 - E2 * sinPhi1 * sinPhi1, 1.5);
  const T1 = tanPhi1 * tanPhi1;
  const C1 = EP2 * cosPhi1 * cosPhi1;
  const D = x / (N1 * K0);

  const lat =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * Math.pow(D, 4)) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * Math.pow(D, 6)) /
          720);
  const lon =
    ZONE14_LON0 * D2R +
    (D -
      ((1 + 2 * T1 + C1) * Math.pow(D, 3)) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * Math.pow(D, 5)) / 120) /
      cosPhi1;

  const latDeg = lat * R2D;
  const lonDeg = lon * R2D;
  // Pertenencia estricta a la zona 14N (cota dura del contrato, holgura
  // 1e-9° para el round-trip del borde).
  if (Math.abs(lonDeg - ZONE14_LON0) > 3.0 + 1e-6) return null;
  if (latDeg < 0 || latDeg > ZONE14_LAT_MAX) return null;
  return [lonDeg, latDeg];
}

/* ------------------------------------------------------------------ */
/* CRS declarado (extensión OGC/GDAL)                                 */
/* ------------------------------------------------------------------ */

type CrsMember = 'none' | 'wgs84' | 'utm14n' | 'unsupported';

/** Acepta forma string (`"crs": "EPSG:32614"`) y forma OGC
 *  `{"type":"name","properties":{"name":"…"}}`. Cualquier otra forma ⇒
 *  unsupported ⇒ hostil. */
function readCrs(root: unknown): CrsMember {
  const crs = (root as { crs?: unknown }).crs;
  if (crs === undefined || crs === null) return 'none'; // ausente o null ⇒ RFC 7946
  let name: unknown = crs;
  if (crs && typeof crs === 'object' && !Array.isArray(crs)) {
    const o = crs as { type?: unknown; properties?: { name?: unknown } };
    if (o.type === 'name' && o.properties && typeof o.properties === 'object') {
      name = o.properties.name;
    } else if (typeof o.type === 'string' && o.type !== 'name') {
      return 'unsupported';
    } else {
      return 'unsupported';
    }
  }
  if (typeof name !== 'string') return 'unsupported';
  const n = name.trim();
  if (/32614/i.test(n)) return 'utm14n'; // EPSG::32614 = WGS 84 / UTM 14N
  if (/utm\s*zone\s*14\s*n/i.test(n)) return 'utm14n';
  if (/4326/i.test(n)) return 'wgs84'; // EPSG::4326
  if (/crs\s*84/i.test(n)) return 'wgs84'; // OGC:CRS84 (orden lon/lat)
  if (/wgs\s*84/i.test(n) && !/south/i.test(n)) return 'wgs84';
  return 'unsupported';
}

/* ------------------------------------------------------------------ */
/* Recorrido de geometrías (iterativo, presupuestos duros)            */
/* ------------------------------------------------------------------ */

interface GeomAcc {
  xs: number[];
  ys: number[];
  zs: number[];
  segs: number[];
  pts: number[];
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  features: number;
  geoms: number;
  skipped: number; // geometrías null (RFC las permite)
  truncated: string;
}

const Z_KEYS = ['cota', 'z', 'elev', 'elevation', 'altura', 'alt', 'elev_m', 'elevación'] as const;

/** Cota desde properties: primera clave finita en orden de prioridad fijo. */
function zFromProps(props: unknown): number {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return NaN;
  const o = props as Record<string, unknown>;
  for (const k of Z_KEYS) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return NaN;
}

/** Posición RFC 7946: array de 2 o 3 números finitos. Cualquier desviación
 *  (aridad 0/1/4+, no-array, no-número, no-finito) ⇒ hostil. */
function isPosition(p: unknown): p is number[] {
  if (!Array.isArray(p)) return false;
  if (p.length !== 2 && p.length !== 3) return false;
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

/** Empuja una posición ya validada. Devuelve false si el presupuesto de
 *  vértices se alcanzó (la posición NO se agrega; se anota el recorte). */
function pushPos(acc: GeomAcc, p: number[], zProp: number): boolean {
  if (acc.xs.length >= MAX_VERTS) {
    if (!acc.truncated)
      acc.truncated = `Datos truncados por límite de rendimiento: vértices recortados a ${MAX_VERTS.toLocaleString('es-MX')}`;
    return false;
  }
  const z = p.length === 3 ? p[2] : zProp;
  acc.xs.push(p[0]);
  acc.ys.push(p[1]);
  acc.zs.push(z);
  if (p[0] < acc.lonMin) acc.lonMin = p[0];
  if (p[0] > acc.lonMax) acc.lonMax = p[0];
  if (p[1] < acc.latMin) acc.latMin = p[1];
  if (p[1] > acc.latMax) acc.latMax = p[1];
  return true;
}

function segBudgetOk(acc: GeomAcc): boolean {
  if (acc.segs.length >= MAX_SEGS) {
    if (!acc.truncated)
      acc.truncated = `Datos truncados por límite de rendimiento: aristas recortadas a ${Math.floor(MAX_SEGS / 2).toLocaleString('es-MX')}`;
    return false;
  }
  return true;
}

/** Añade posiciones consecutivas y emite aristas entre pares. */
function addLine(acc: GeomAcc, positions: unknown, zProp: number): boolean {
  if (!Array.isArray(positions)) return false;
  const start = acc.xs.length;
  for (const p of positions) {
    if (!isPosition(p)) return false;
    pushPos(acc, p, zProp);
  }
  for (let i = start + 1; i < acc.xs.length; i++) {
    if (!segBudgetOk(acc)) break;
    acc.segs.push(i - 1, i);
  }
  return true;
}

/** Anillo de polígono RFC 7946 §3.1.9: ≥ 4 posiciones y cerrado
 *  (primera == última). Estricto: anillo abierto o degenerado ⇒ hostil.
 *  Si el presupuesto de vértices no alcanza para el anillo COMPLETO, el
 *  anillo se omite entero (un anillo truncado no se puede verificar) con
 *  nota de recorte — la truncación nunca se disfraza de hostilidad. */
function addRing(acc: GeomAcc, ring: unknown, zProp: number): boolean {
  if (!Array.isArray(ring)) return false;
  const start = acc.xs.length;
  if (ring.length < 4) return false;
  if (start + ring.length > MAX_VERTS) {
    if (!acc.truncated)
      acc.truncated = `Datos truncados por límite de rendimiento: anillos que no caben completamente se omiten (tope ${MAX_VERTS.toLocaleString('es-MX')} vértices)`;
    return true;
  }
  for (const p of ring) {
    if (!isPosition(p)) return false;
    pushPos(acc, p, zProp);
  }
  const end = acc.xs.length;
  const first = start;
  const last = end - 1;
  if (acc.xs[first] !== acc.xs[last] || acc.ys[first] !== acc.ys[last]) return false;
  for (let i = start + 1; i < end; i++) {
    if (!segBudgetOk(acc)) break;
    acc.segs.push(i - 1, i);
  }
  return true;
}

/** Procesa un objeto geometría (y GeometryCollection de forma iterativa).
 *  Devuelve false ante cualquier hostilidad estructural. */
function addGeometry(acc: GeomAcc, geom: unknown, zProp: number): boolean {
  if (!geom || typeof geom !== 'object' || Array.isArray(geom)) return false;
  const stack: unknown[] = [geom];
  while (stack.length > 0) {
    const g = stack.pop();
    if (!g || typeof g !== 'object' || Array.isArray(g)) return false;
    const o = g as { type?: unknown; coordinates?: unknown; geometries?: unknown };
    switch (o.type) {
      case 'Point': {
        if (!isPosition(o.coordinates)) return false;
        const before = acc.xs.length;
        if (pushPos(acc, o.coordinates, zProp) && acc.pts.length < MAX_VERTS)
          acc.pts.push(before); // índice real del punto recién agregado
        acc.geoms++;
        break;
      }
      case 'MultiPoint': {
        if (!Array.isArray(o.coordinates)) return false;
        for (const p of o.coordinates) {
          if (!isPosition(p)) return false;
          const before = acc.xs.length;
          if (pushPos(acc, p, zProp) && acc.pts.length < MAX_VERTS) acc.pts.push(before);
        }
        acc.geoms++;
        break;
      }
      case 'LineString':
        if (!Array.isArray(o.coordinates) || o.coordinates.length < 2) return false;
        if (!addLine(acc, o.coordinates, zProp)) return false;
        acc.geoms++;
        break;
      case 'MultiLineString': {
        if (!Array.isArray(o.coordinates)) return false;
        for (const part of o.coordinates) {
          if (!Array.isArray(part) || part.length < 2) return false;
          if (!addLine(acc, part, zProp)) return false;
        }
        acc.geoms++;
        break;
      }
      case 'Polygon': {
        if (!Array.isArray(o.coordinates)) return false;
        for (const ring of o.coordinates) if (!addRing(acc, ring, zProp)) return false;
        acc.geoms++;
        break;
      }
      case 'MultiPolygon': {
        if (!Array.isArray(o.coordinates)) return false;
        for (const poly of o.coordinates) {
          if (!Array.isArray(poly)) return false;
          for (const ring of poly) if (!addRing(acc, ring, zProp)) return false;
        }
        acc.geoms++;
        break;
      }
      case 'GeometryCollection': {
        if (!Array.isArray(o.geometries)) return false;
        for (let i = o.geometries.length - 1; i >= 0; i--) stack.push(o.geometries[i]);
        break;
      }
      default:
        return false; // tipo de geometría desconocido ⇒ hostil
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Parser principal                                                   */
/* ------------------------------------------------------------------ */

/**
 * Punto de entrada FR-1. Parsea el TEXTO de un archivo GeoJSON y devuelve
 * `ParseResult` (misma forma que el resto de los parsers) o **null** si la
 * entrada es hostil/inválida — sin lanzar excepciones jamás.
 */
export function parseGeoJson(
  text: string,
  anchor: Anchor,
  progress: ParseProgress = () => {}
): ParseResult | null {
  if (typeof text !== 'string') return null;
  // BOM UTF-8 tolerado (interop real); 0xFEFF como primer char.
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (t.length === 0 || t.length > MAX_FILE_BYTES) return null;

  progress('Decodificando JSON', 12);
  let root: unknown;
  try {
    root = JSON.parse(t);
  } catch {
    return null; // JSON fracturado o profundidad extrema (RangeError) ⇒ null
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;

  const crsMode = readCrs(root);
  if (crsMode === 'unsupported') return null; // CRS declarado no soportado ⇒ hostil

  const rootObj = root as {
    type?: unknown;
    features?: unknown;
    geometry?: unknown;
    properties?: unknown;
    coordinates?: unknown;
  };

  const acc: GeomAcc = {
    xs: [],
    ys: [],
    zs: [],
    segs: [],
    pts: [],
    lonMin: Infinity,
    lonMax: -Infinity,
    latMin: Infinity,
    latMax: -Infinity,
    features: 0,
    geoms: 0,
    skipped: 0,
    truncated: '',
  };

  /* --- v1.1 defensiva (FR-4): route_class/confidence de properties ---
   * Primera feature que los declare gana (misma convención determinista
   * que el fallback KML). Granularidad por-feature es parte de la
   * implementación v1.1 del consorcio (REQ-10); la lectura defensiva
   * aplica a nivel capa. Inválidos ⇒ ignorados (= ausente, defaults). */
  let d11RouteClass: string | undefined;
  let d11Confidence: number | undefined;
  const readD11Attrs = (properties: unknown): void => {
    if (d11RouteClass !== undefined && d11Confidence !== undefined) return;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return;
    const p = properties as Record<string, unknown>;
    if (d11RouteClass === undefined) {
      const rc = p.route_class ?? p.rutaClase ?? p.routeClass;
      if (typeof rc === 'string' && rc.trim() !== '') d11RouteClass = rc.trim().slice(0, 64);
    }
    if (d11Confidence === undefined) {
      const cf = p.confidence ?? p.confianza;
      const cfNum = typeof cf === 'number' ? cf : typeof cf === 'string' ? Number(cf) : NaN;
      if (Number.isFinite(cfNum) && cfNum >= 0 && cfNum <= 100) d11Confidence = cfNum;
    }
  };

  /* --- recolección de posiciones (unidades fuente) ----------------- */
  progress('Recorriendo geometrías', 30);
  if (rootObj.type === 'FeatureCollection') {
    if (!Array.isArray(rootObj.features)) return null;
    for (const f of rootObj.features) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
      const fo = f as { type?: unknown; geometry?: unknown; properties?: unknown };
      if (fo.type !== 'Feature') return null;
      acc.features++;
      readD11Attrs(fo.properties);
      if (fo.geometry === null) {
        acc.skipped++; // RFC lo permite: feature sin geometría
        continue;
      }
      if (!('geometry' in (f as object))) return null; // miembro ausente ⇒ hostil
      if (!addGeometry(acc, fo.geometry, zFromProps(fo.properties))) return null;
      if (acc.xs.length >= MAX_VERTS) break; // presupuesto: corta el barrido
    }
  } else if (rootObj.type === 'Feature') {
    if (!('geometry' in (root as object))) return null; // miembro ausente ⇒ hostil
    acc.features++;
    readD11Attrs(rootObj.properties);
    if (rootObj.geometry === null) acc.skipped++;
    else if (!addGeometry(acc, rootObj.geometry, zFromProps(rootObj.properties))) return null;
  } else if (
    rootObj.type === 'Point' ||
    rootObj.type === 'MultiPoint' ||
    rootObj.type === 'LineString' ||
    rootObj.type === 'MultiLineString' ||
    rootObj.type === 'Polygon' ||
    rootObj.type === 'MultiPolygon' ||
    rootObj.type === 'GeometryCollection'
  ) {
    acc.features++; // geometría suelta: cuenta como una «feature» en ficha
    if (!addGeometry(acc, root, NaN)) return null;
  } else {
    return null; // tipo raíz desconocido ⇒ hostil
  }

  if (acc.xs.length === 0) return null; // sin vértices ⇒ nada que renderizar ⇒ null

  /* --- modo de coordenadas (crs declarado ∨ magnitud) -------------- */
  progress('Detectando modo de coordenadas', 55);
  let allDeg = true;
  let allUtm = true;
  for (let i = 0; i < acc.xs.length; i++) {
    const x = acc.xs[i];
    const y = acc.ys[i];
    if (!(Math.abs(x) <= 180 && Math.abs(y) <= 90)) allDeg = false;
    if (!(x >= UTM_EASTING_MIN && x <= UTM_EASTING_MAX && y >= 0 && y <= UTM_NORTHING_MAX))
      allUtm = false;
    if (!allDeg && !allUtm) break; // ni grados ni UTM ⇒ hostil temprano
  }
  if (!allDeg && !allUtm) return null;

  let mode: 'rfc7946' | 'utm14n-declarado' | 'utm14n-inferido';
  if (crsMode === 'utm14n') {
    if (!allUtm) return null; // crs declara UTM pero los datos son grados ⇒ hostil
    mode = 'utm14n-declarado';
  } else if (crsMode === 'wgs84') {
    if (!allDeg) return null; // crs declara WGS84 pero los datos son UTM ⇒ hostil
    mode = 'rfc7946';
  } else {
    mode = allUtm ? 'utm14n-inferido' : 'rfc7946'; // auto-detección por magnitud
  }

  /* --- UTM 14N ⇒ WGS84 (conversión canónica, zona estricta) -------- */
  if (mode !== 'rfc7946') {
    progress('Convirtiendo UTM 14N → WGS84', 65);
    for (let i = 0; i < acc.xs.length; i++) {
      const c = utm14nToWgs84(acc.xs[i], acc.ys[i]);
      if (!c) return null; // fuera de zona ⇒ hostil (todo el archivo)
      acc.xs[i] = c[0];
      acc.ys[i] = c[1];
    }
    // El BBox se recalcula en las unidades CONVERTIDAS (identidad WGS84
    // canónica que FR-2 cruzará contra KML) — no en las UTM de origen.
    acc.lonMin = Infinity;
    acc.lonMax = -Infinity;
    acc.latMin = Infinity;
    acc.latMax = -Infinity;
    for (let i = 0; i < acc.xs.length; i++) {
      if (acc.xs[i] < acc.lonMin) acc.lonMin = acc.xs[i];
      if (acc.xs[i] > acc.lonMax) acc.lonMax = acc.xs[i];
      if (acc.ys[i] < acc.latMin) acc.latMin = acc.ys[i];
      if (acc.ys[i] > acc.latMax) acc.latMax = acc.ys[i];
    }
  } else {
    // Validación de rango geográfico estricta en modo grados.
    if (acc.lonMin < -180 || acc.lonMax > 180 || acc.latMin < -90 || acc.latMax > 90)
      return null;
  }

  /* --- anclaje escénico (idéntico al CSV) --------------------------- */
  progress('Anclando al encuadre', 80);
  const n = acc.xs.length;
  const mPerLon = 111320 * Math.cos(anchor.centerLat * D2R);
  const maxR = 0.49 * anchor.extentM;
  let outOfExtent = 0;
  for (let i = 0; i < n; i++) {
    acc.xs[i] = (acc.xs[i] - anchor.centerLon) * mPerLon;
    acc.ys[i] = (acc.ys[i] - anchor.centerLat) * M_PER_DEG_LAT;
    // DRAPE-1: sin cota ⇒ NaN preservado (el overlay lo drapea sobre el MDT
    // activo: z del terreno + lift 2–3 px). zMid horneado jamás — el dato
    // que no existe no se inventa.
    acc.zs[i] = Number.isFinite(acc.zs[i])
      ? Math.min(Math.max(acc.zs[i], anchor.zMinM), anchor.zMaxM)
      : NaN;
    if (Math.abs(acc.xs[i]) > maxR || Math.abs(acc.ys[i]) > maxR) outOfExtent++;
  }
  const rescaled = outOfExtent > n * 0.5;
  let verts: Float32Array;
  if (rescaled) {
    verts = normalizeToScene(acc.xs, acc.ys, acc.zs, anchor);
  } else {
    verts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      verts[i * 3] = acc.xs[i];
      verts[i * 3 + 1] = acc.ys[i];
      verts[i * 3 + 2] = acc.zs[i];
    }
  }

  /* --- ficha de auditoría ------------------------------------------- */
  const crsLabel =
    mode === 'rfc7946'
      ? 'geográfico WGS84 (RFC 7946)'
      : 'EPSG:32614 (UTM 14N)';
  const modeLabel =
    mode === 'rfc7946'
      ? 'WGS84 grados — RFC 7946'
      : mode === 'utm14n-declarado'
        ? 'UTM 14N — crs declarado'
        : 'UTM 14N — inferido por magnitud';

  const rows: Array<[string, string]> = [
    ['Formato', 'GeoJSON (RFC 7946 + crs UTM 14N)'],
    ['CRS (modo)', modeLabel],
    ['Features', acc.features.toLocaleString('es-MX')],
    ['Geometrías', acc.geoms.toLocaleString('es-MX')],
  ];
  if (acc.skipped > 0) rows.push(['Sin geometría', acc.skipped.toLocaleString('es-MX')]);
  rows.push(
    ['Vértices', n.toLocaleString('es-MX')],
    ['Aristas', (acc.segs.length / 2).toLocaleString('es-MX')],
    ['Puntos', acc.pts.length.toLocaleString('es-MX')],
    [
      'BBox WGS84',
      `lon ${acc.lonMin.toFixed(4)}…${acc.lonMax.toFixed(4)} · lat ${acc.latMin.toFixed(4)}…${acc.latMax.toFixed(4)}`,
    ],
    ['Anclado a', rescaled ? `${anchor.regionName} (encuadrado)` : anchor.regionName]
  );
  if (acc.truncated) rows.push(['Recorte', acc.truncated]);
  if (d11RouteClass !== undefined) rows.push(['D11 clase de ruta', d11RouteClass]);
  if (d11Confidence !== undefined) rows.push(['D11 confianza', `${d11Confidence}%`]);

  const meta: IngestMeta = {
    format: 'geojson',
    label: 'GeoJSON',
    magicOk: true,
    rows,
    entities: {
      features: acc.features,
      geometrias: acc.geoms,
      vertices: n,
      aristas: acc.segs.length / 2,
      puntos: acc.pts.length,
    },
    truncated: acc.truncated || undefined,
    crs: crsLabel,
    ...(d11RouteClass !== undefined ? { routeClass: d11RouteClass } : {}),
    ...(d11Confidence !== undefined ? { confidence: d11Confidence } : {}),
  };

  const geom: IngestGeom | null = acc.segs.length > 0 || acc.pts.length > 0
    ? { verts, segs: new Uint32Array(acc.segs), pts: new Uint32Array(acc.pts) }
    : { verts, segs: new Uint32Array(0), pts: new Uint32Array(0) };

  progress('GeoJSON listo', 100);
  return { meta, geom };
}
