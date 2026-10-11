/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-2 — Parser KML 2.2 (OGC 07-147r2) · 0 dependencias · XXE-safe
 * (agenda FR 1.0 · orden fijo del propietario · checkpoint de ingeniería).
 *
 * Contrato de la agenda:
 *   - KML es SIEMPRE WGS84 en grados (lon, lat[, alt]) — no hay negociación
 *     de CRS: coordenadas fuera de rango geográfico ⇒ hostil.
 *   - XXE-SAFE POR CONSTRUCCIÓN: el archivo **no puede declarar DTD**. Todo
 *     `<!DOCTYPE`, `<!ENTITY`, `<!ATTLIST`, `<!ELEMENT`, `<!NOTATION` ⇒
 *     rechazo limpio (null) — sin DTD no existe expansión de entidades:
 *     Billion Laughs, entity externa (file://, http://) y quadractic blowup
 *     quedan imposibilitados en la raíz. Solo se resuelven las 5 entidades
 *     predefinidas XML (&lt; &gt; &amp; &quot; &apos;) y referencias
 *     numéricas (&#NN; / &#xHH;) con rango validado.
 *   - HOSTILES ⇒ null SIN excepciones: XML fracturado (etiqueta sin cerrar,
 *     desbalanceada, atributo duplicado o sin comillas), entidad indefinida,
 *     coordenadas con aridad ≠ 2–3, no finitas o fuera de rango, anillos
 *     abiertos o degenerados, Polygon sin outerBoundaryIs, geometría
 *     desconocida (Track/Model/MultiTrack ⇒ no soportado, honesto),
 *     profundidad/extensión extrema (presupuestos duros).
 *   - Determinismo bit-exacto: mismo archivo ⇒ misma geometría byte a byte.
 *
 * Filosofía 0 GPU: CPU puro, construcción de árbol con PILA EXPLÍCITA (sin
 * recursión ⇒ sin desborde de pila ante anidado hostil), presupuestos
 * compartidos con parsers.ts (MAX_VERTS / MAX_SEGS) + presupuestos XML
 * propios (MAX_ELEMENTS / MAX_DEPTH / tope de texto).
 *
 * Presentación: los estilos del autor (Style/styleUrl) se IGNORAN por
 * contrato — la presentación es semántica (gramática de línea D11, FR-4),
 * no por autor. La identidad de cada Placemark (UUID canónico + BBox
 * WGS84) se expone para el cruce par-a-par (identity.ts).
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
import {
  normalizeUuid,
  type BBoxWgs84,
  type IdentityFeature,
} from './identity';

/* ------------------------------------------------------------------ */
/* Presupuestos XML                                                   */
/* ------------------------------------------------------------------ */

/** Máximo de elementos XML por archivo (defensa de expansión estructural). */
export const MAX_ELEMENTS = 200_000;
/** Profundidad máxima de anidado (KML real nunca pasa ~10). */
export const MAX_DEPTH = 64;
/** Tope acumulado de texto (cuerpo + atributos) — el archivo ya está acotado
 *  a MAX_FILE_BYTES; este tope impide duplicación por decodificación. */
const MAX_TEXT_CHARS = 50 * 1024 * 1024;
/** Longitud máxima de un nombre de elemento/atributo. */
const MAX_NAME_CHARS = 256;
/** Máximo de atributos por elemento. */
const MAX_ATTRS = 64;
/** Máximo de elementos por Placemark (subárbol de interpretación). */
const MAX_PLACEMARK_ELEMENTS = 10_000;

/* ------------------------------------------------------------------ */
/* Árbol XML mínimo (nodos interpretativos)                           */
/* ------------------------------------------------------------------ */

interface XmlNode {
  /** Nombre local (sin prefijo de namespace). */
  name: string;
  /** Nombre crudo (con prefijo) — para verificación de cierre. */
  raw: string;
  attrs: Map<string, string>;
  kids: XmlNode[];
  /** Texto acumulado de los hijos de texto directos (entidades resueltas). */
  text: string;
}

/* ------------------------------------------------------------------ */
/* Entidades — la superficie XXE completa                             */
/* ------------------------------------------------------------------ */

const PREDEFINED: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/**
 * Decodifica referencias de entidad en un fragmento de texto/atributo.
 * Solo predefinidas + numéricas. Cualquier otra forma ⇒ null (hostil):
 * `&miEntidad;` (indefinida), `&x;&x;&x;…` (sin DTD no puede expandirse,
 * pero tampoco se tolera su presencia).
 */
function decodeEntities(s: string): string | null {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c !== '&') {
      out += c;
      i++;
      continue;
    }
    const semi = s.indexOf(';', i + 1);
    if (semi < 0) return null; // & sin cierre ⇒ hostil
    const body = s.slice(i + 1, semi);
    if (body.length === 0 || body.length > 10) return null;
    if (body[0] === '#') {
      // Numérica: &#NN; o &#xHH;
      const hex = body.length > 1 && (body[1] === 'x' || body[1] === 'X');
      const digits = hex ? body.slice(2) : body.slice(1);
      if (digits.length === 0 || digits.length > 8) return null;
      const re = hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;
      if (!re.test(digits)) return null;
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff) return null;
      // XML bien formado: sin controles salvo tab/lf/cr
      if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return null;
      out += String.fromCodePoint(cp);
    } else {
      const v = PREDEFINED[body];
      if (v === undefined) return null; // entidad no predefinida ⇒ hostil
      out += v;
    }
    i = semi + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tokenizador XML → árbol (iterativo, con presupuestos)              */
/* ------------------------------------------------------------------ */

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

function readName(s: string, i: number): { name: string; end: number } | null {
  const n = s.length;
  if (i >= n || !NAME_START.test(s[i])) return null;
  let j = i + 1;
  while (j < n && NAME_CHAR.test(s[j])) j++;
  if (j - i > MAX_NAME_CHARS) return null;
  return { name: s.slice(i, j), end: j };
}

interface BuildOk {
  root: XmlNode;
  elements: number;
}
type BuildRes = BuildOk | null; // null ⇒ hostil

/**
 * Construye el árbol COMPLETO del documento con pila explícita.
 * Devuelve null ante cualquier hostilidad estructural o presupuestaria —
 * nunca lanza.
 */
function buildXmlTree(src: string): BuildRes {
  const n = src.length;
  let i = 0;
  let elements = 0;
  let textBudget = 0;
  let root: XmlNode | null = null;

  // Pila explícita de abiertos
  const stack: XmlNode[] = [];

  const appendText = (t: string): boolean => {
    if (t.length === 0) return true;
    textBudget += t.length;
    if (textBudget > MAX_TEXT_CHARS) return false;
    const top = stack[stack.length - 1];
    if (top) top.text += t;
    return true;
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      // Texto de cola tras el elemento raíz (solo whitespace permitido)
      const tail = src.slice(i);
      if (tail.trim() !== '') return null;
      break;
    }
    if (lt > i) {
      const chunk = src.slice(i, lt);
      const dec = decodeEntities(chunk);
      if (dec === null || !appendText(dec)) return null;
    }
    // Construcciones '<'…
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) return null; // comentario sin cerrar
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) return null;
      if (!appendText(src.slice(lt + 9, end))) return null; // CDATA: crudo
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) return null; // declaración/PI sin cerrar
      i = end + 2;
      continue;
    }
    // XXE-SAFE: la familia de declaraciones DTD ⇒ rechazo en la raíz.
    if (
      src.startsWith('<!DOCTYPE', lt) ||
      src.startsWith('<!doctype', lt) ||
      src.startsWith('<!ENTITY', lt) ||
      src.startsWith('<!ATTLIST', lt) ||
      src.startsWith('<!ELEMENT', lt) ||
      src.startsWith('<!NOTATION', lt)
    ) {
      return null;
    }
    if (src.startsWith('<!', lt)) return null; // cualquier otra declaración

    // Cierre </nombre>
    if (src.startsWith('</', lt)) {
      const nm = readName(src, lt + 2);
      if (!nm) return null;
      let j = nm.end;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      if (src[j] !== '>') return null;
      const top = stack.pop();
      if (!top || top.raw !== nm.name) return null; // desbalanceado ⇒ hostil
      i = j + 1;
      continue;
    }

    // Apertura <nombre …>
    const nm = readName(src, lt + 1);
    if (!nm) return null;
    let j = nm.end;
    const attrs = new Map<string, string>();
    let selfClose = false;
    // Atributos
    for (;;) {
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      if (j >= n) return null;
      if (src[j] === '>') {
        j++;
        break;
      }
      if (src[j] === '/' && src[j + 1] === '>') {
        selfClose = true;
        j += 2;
        break;
      }
      const an = readName(src, j);
      if (!an) return null; // atributo malformado
      j = an.end;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      if (src[j] !== '=') return null;
      j++;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") return null; // sin comillas ⇒ hostil
      const closeQ = src.indexOf(q, j + 1);
      if (closeQ < 0) return null; // comilla sin cerrar
      const rawVal = src.slice(j + 1, closeQ);
      const val = decodeEntities(rawVal);
      if (val === null) return null;
      if (attrs.has(an.name)) return null; // atributo duplicado ⇒ hostil
      if (attrs.size >= MAX_ATTRS) return null;
      attrs.set(an.name, val);
      j = closeQ + 1;
    }

    elements++;
    if (elements > MAX_ELEMENTS) return null;
    if (stack.length + 1 > MAX_DEPTH) return null; // profundidad extrema

    const localIdx = nm.name.indexOf(':');
    const node: XmlNode = {
      name: localIdx >= 0 ? nm.name.slice(localIdx + 1) : nm.name,
      raw: nm.name,
      attrs,
      kids: [],
      text: '',
    };
    if (!root) root = node;
    const parent = stack[stack.length - 1];
    if (parent) parent.kids.push(node);
    if (!selfClose) stack.push(node);
    i = j;
  }

  if (stack.length > 0) return null; // elementos sin cerrar
  if (!root) return null; // sin elemento raíz
  return { root, elements };
}

/* ------------------------------------------------------------------ */
/* Coordenadas KML                                                    */
/* ------------------------------------------------------------------ */

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function parseNum(t: string): number | null {
  if (!NUM_RE.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** Parsea el texto de un elemento <coordinates>: tuplas lon[,lat[,alt]]
 *  separadas por whitespace. Aridad 2–3 estricta; rango geográfico
 *  estricto. Devuelve null ante hostilidad. */
function parseCoordinates(text: string): Array<[number, number, number]> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null; // coordinates vacío ⇒ hostil
  const tuples = trimmed.split(/\s+/);
  const out: Array<[number, number, number]> = [];
  for (const t of tuples) {
    const parts = t.split(',');
    if (parts.length < 2 || parts.length > 3) return null; // aridad ≠ 2–3
    const lon = parseNum(parts[0]);
    const lat = parseNum(parts[1]);
    if (lon === null || lat === null) return null;
    // DRAPE-1: KML sin altitud ⇒ NaN (señal preservada — el overlay drapea
    // el vértice sobre el MDT activo). El 0 horneado era una cota falsa.
    let alt = NaN;
    if (parts.length === 3) {
      const a = parseNum(parts[2]);
      if (a === null) return null; // '1e400' ⇒ Infinity ⇒ hostil
      alt = a;
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    out.push([lon, lat, alt]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Acumulación de geometría (idéntico patrón a FR-1)                  */
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
  geoms: number;
  truncated: string;
  /** índice de inicio por placemark (para bbox por feature) */
  marks: Array<{ start: number; end: number }>;
}

function newAcc(): GeomAcc {
  return {
    xs: [],
    ys: [],
    zs: [],
    segs: [],
    pts: [],
    lonMin: Infinity,
    lonMax: -Infinity,
    latMin: Infinity,
    latMax: -Infinity,
    geoms: 0,
    truncated: '',
    marks: [],
  };
}

function pushPos(acc: GeomAcc, lon: number, lat: number, alt: number): boolean {
  if (acc.xs.length >= MAX_VERTS) {
    if (!acc.truncated)
      acc.truncated = `Datos truncados por límite de rendimiento: vértices recortados a ${MAX_VERTS.toLocaleString('es-MX')}`;
    return false;
  }
  acc.xs.push(lon);
  acc.ys.push(lat);
  acc.zs.push(alt);
  if (lon < acc.lonMin) acc.lonMin = lon;
  if (lon > acc.lonMax) acc.lonMax = lon;
  if (lat < acc.latMin) acc.latMin = lat;
  if (lat > acc.latMax) acc.latMax = lat;
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

function addLineTuples(acc: GeomAcc, tuples: Array<[number, number, number]>): boolean {
  const start = acc.xs.length;
  for (const t of tuples) if (!pushPos(acc, t[0], t[1], t[2])) break;
  for (let i = start + 1; i < acc.xs.length; i++) {
    if (!segBudgetOk(acc)) break;
    acc.segs.push(i - 1, i);
  }
  return true;
}

/** Anillo KML: ≥ 4 tuplas y cerrado (primera == última en lon/lat).
 *  Si no cabe completo en el presupuesto, se omite ENTERO (un anillo
 *  truncado no se puede verificar) con nota — nunca disfrazado. */
function addRingTuples(acc: GeomAcc, tuples: Array<[number, number, number]>): boolean {
  if (tuples.length < 4) return false;
  const start = acc.xs.length;
  if (start + tuples.length > MAX_VERTS) {
    if (!acc.truncated)
      acc.truncated = `Datos truncados por límite de rendimiento: anillos que no caben completamente se omiten (tope ${MAX_VERTS.toLocaleString('es-MX')} vértices)`;
    return true;
  }
  for (const t of tuples) pushPos(acc, t[0], t[1], t[2]);
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

/* ------------------------------------------------------------------ */
/* Interpretación de geometrías KML                                   */
/* ------------------------------------------------------------------ */

const GEOM_POINT = 'Point';
const GEOM_LINE = 'LineString';
const GEOM_POLY = 'Polygon';
const GEOM_MULTI = 'MultiGeometry';
/** Geometrías KML NO soportadas — rechazo limpio y honesto. */
const GEOM_UNSUPPORTED = new Set(['Track', 'Model', 'MultiTrack', 'MultiPolygon']);

function childByName(node: XmlNode, name: string): XmlNode | null {
  for (const k of node.kids) if (k.name === name) return k;
  return null;
}

function childrenByName(node: XmlNode, name: string): XmlNode[] {
  return node.kids.filter((k) => k.name === name);
}

/** Tuplas de un elemento <coordinates> hijo directo de `node`. */
function coordTuplesOf(node: XmlNode): Array<[number, number, number]> | null {
  const c = childByName(node, 'coordinates');
  if (!c) return null; // elemento geométrico sin coordinates ⇒ hostil
  return parseCoordinates(c.text);
}

type GeomKind = 'punto' | 'linea' | 'poligono';

interface GeomSpec {
  kind: GeomKind;
}

/**
 * Interpreta las geometrías de un subárbol (Placemark o MultiGeometry
 * anidado) de forma ITERATIVA. Devuelve null ante hostilidad.
 */
function collectGeoms(root: XmlNode, acc: GeomAcc): GeomSpec[] | null {
  const specs: GeomSpec[] = [];
  let visited = 0;
  const stack: XmlNode[] = [];
  for (let i = root.kids.length - 1; i >= 0; i--) stack.push(root.kids[i]);
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    if (++visited > MAX_PLACEMARK_ELEMENTS) return null;
    switch (node.name) {
      case GEOM_MULTI: {
        for (let i = node.kids.length - 1; i >= 0; i--) stack.push(node.kids[i]);
        break;
      }
      case GEOM_POINT: {
        const t = coordTuplesOf(node);
        if (!t || t.length !== 1) return null; // 0 o >1 tuplas ⇒ hostil
        const before = acc.xs.length;
        pushPos(acc, t[0][0], t[0][1], t[0][2]);
        if (acc.pts.length < MAX_VERTS) acc.pts.push(before);
        specs.push({ kind: 'punto' });
        acc.geoms++;
        break;
      }
      case GEOM_LINE: {
        const t = coordTuplesOf(node);
        if (!t || t.length < 2) return null; // línea degenerada ⇒ hostil
        addLineTuples(acc, t);
        specs.push({ kind: 'linea' });
        acc.geoms++;
        break;
      }
      case GEOM_POLY: {
        const outer = childByName(node, 'outerBoundaryIs');
        if (!outer) return null; // sin frontera exterior ⇒ hostil
        const outerRing = childByName(outer, 'LinearRing');
        if (!outerRing) return null;
        const tOuter = coordTuplesOf(outerRing);
        if (!tOuter) return null;
        if (!addRingTuples(acc, tOuter)) return null; // abierto/degenerado
        for (const inner of childrenByName(node, 'innerBoundaryIs')) {
          const ring = childByName(inner, 'LinearRing');
          if (!ring) return null;
          const t = coordTuplesOf(ring);
          if (!t) return null;
          if (!addRingTuples(acc, t)) return null;
        }
        specs.push({ kind: 'poligono' });
        acc.geoms++;
        break;
      }
      default: {
        if (GEOM_UNSUPPORTED.has(node.name)) return null; // no soportado ⇒ hostil
        // Elemento no geométrico (Style, LookAt, TimeStamp…): se ignora su
        // semántica pero SUS HIJOS se siguen explorando para encontrar
        // geometrías envueltas; los nombres no soportados siguen detectándose.
        for (let i = node.kids.length - 1; i >= 0; i--) stack.push(node.kids[i]);
      }
    }
  }
  return specs;
}

/* ------------------------------------------------------------------ */
/* Interpretación del documento                                       */
/* ------------------------------------------------------------------ */

export interface KmlIdentity {
  features: IdentityFeature[];
  placemarks: number;
  skipped: number; // placemarks sin geometría
  version: string | null;
  docLayerType: string | null;
  /** v1.1 defensiva (FR-4): route_class/confidence a nivel documento. */
  docRouteClass: string | null;
  docConfidence: number | null;
  acc: GeomAcc;
}

/** Kind agregado de un placemark: prioridad determinista
 *  poligono > linea > punto (la geometría «más pesada» define la ficha). */
function aggregateKind(specs: GeomSpec[]): GeomKind {
  let poly = false;
  let line = false;
  for (const s of specs) {
    if (s.kind === 'poligono') poly = true;
    else if (s.kind === 'linea') line = true;
  }
  return poly ? 'poligono' : line ? 'linea' : 'punto';
}

/**
 * Núcleo común: parsea KML y produce la ficha de identidad por Placemark
 * + la geometría acumulada. Devuelve null ante hostilidad — nunca lanza.
 */
function kmlCore(src: string, progress: ParseProgress): KmlIdentity | null {
  if (typeof src !== 'string') return null;
  const t = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src; // BOM tolerado
  if (t.length === 0 || t.length > MAX_FILE_BYTES) return null;

  progress('Analizando XML', 12);
  const built = buildXmlTree(t);
  if (!built) return null;
  const root = built.root;
  if (root.name !== 'kml') return null; // raíz KML obligatoria
  const version = root.attrs.get('version') ?? null;
  if (version !== null && !/^\d+\.\d+(\.\d+)?$/.test(version)) return null;

  // Datos de documento (fuera de placemarks): ExtendedData/Data y Data
  // directos bajo Document/kml/Folder — usado por layerType semántico y
  // por la lectura defensiva v1.1 (route_class/confidence, FR-4).
  let docLayerType: string | null = null;
  let docRouteClass: string | null = null;
  let docConfidence: number | null = null;
  let insidePlacemarkRoot = false;

  const acc = newAcc();
  const features: IdentityFeature[] = [];
  let placemarks = 0;
  let skipped = 0;

  // Pase 1: datos de documento + conteo de placemarks (recorrido iterativo)
  progress('Recorriendo el documento', 25);
  {
    const stack: Array<{ node: XmlNode; inPlacemark: boolean }> = [];
    for (let i = root.kids.length - 1; i >= 0; i--)
      stack.push({ node: root.kids[i], inPlacemark: false });
    let visited = 0;
    while (stack.length > 0) {
      const fr = stack.pop() as { node: XmlNode; inPlacemark: boolean };
      if (++visited > MAX_ELEMENTS) return null;
      if (fr.node.name === 'Placemark') insidePlacemarkRoot = true;
      if (!fr.inPlacemark && fr.node.name === 'Data' && fr.node !== root) {
        const k = fr.node.attrs.get('name');
        if (k === 'layerType') {
          const v = childByName(fr.node, 'value');
          if (v && typeof v.text === 'string' && v.text.trim() !== '')
            docLayerType = v.text.trim().slice(0, 64);
        } else if (k === 'route_class' || k === 'rutaClase' || k === 'routeClass') {
          // v1.1 defensiva: alias ADR (rutaClase) + checkpoint (route_class)
          const v = childByName(fr.node, 'value');
          if (v && typeof v.text === 'string' && v.text.trim() !== '')
            docRouteClass = v.text.trim().slice(0, 64);
        } else if (k === 'confidence' || k === 'confianza') {
          // v1.1 defensiva: 0-100; inválido ⇒ ignorado (= ausente, default 100).
          // NOTA: texto vacío NO es 0 — Number('') === 0 engaña; se ignora.
          const v = childByName(fr.node, 'value');
          if (v && typeof v.text === 'string' && v.text.trim() !== '') {
            const n = Number(v.text.trim());
            if (Number.isFinite(n) && n >= 0 && n <= 100) docConfidence = n;
          }
        }
      }
      for (let i = fr.node.kids.length - 1; i >= 0; i--)
        stack.push({ node: fr.node.kids[i], inPlacemark: fr.inPlacemark || fr.node.name === 'Placemark' });
    }
  }
  void insidePlacemarkRoot;

  // Pase 2: placemarks → geometría + identidad
  progress('Interpretando placemarks', 45);
  {
    const stack: Array<{ node: XmlNode; inPlacemark: boolean }> = [];
    for (let i = root.kids.length - 1; i >= 0; i--)
      stack.push({ node: root.kids[i], inPlacemark: false });
    while (stack.length > 0) {
      const fr = stack.pop() as { node: XmlNode; inPlacemark: boolean };
      const isPlacemark = fr.node.name === 'Placemark' && !fr.inPlacemark;
      if (isPlacemark) {
        placemarks++;
        if (placemarks > MAX_ELEMENTS) return null;
        const startIdx = acc.xs.length;
        // Identidad: id / nombre / ExtendedData
        let uuid = normalizeUuid(fr.node.attrs.get('id'));
        let name = '';
        const ext = new Map<string, string>();
        for (const kid of fr.node.kids) {
          if (kid.name === 'name') name = kid.text.trim().slice(0, 200);
        }
        const extNode = childByName(fr.node, 'ExtendedData');
        if (extNode) {
          for (const d of extNode.kids) {
            if (d.name === 'Data') {
              const k = d.attrs.get('name');
              const v = childByName(d, 'value');
              if (k && v) ext.set(k, v.text.trim());
            } else if (d.name === 'SchemaData') {
              for (const sd of d.kids) {
                if (sd.name === 'SimpleData') {
                  const k = sd.attrs.get('name');
                  if (k) ext.set(k, sd.text.trim());
                }
              }
            }
          }
        }
        if (!uuid) uuid = normalizeUuid(ext.get('uuid') ?? ext.get('UUID') ?? null);
        const layerTypeRaw = ext.get('layerType') ?? ext.get('LayerType') ?? null;
        // v1.1 defensiva a nivel Placemark (fallback del meta si el doc no declara)
        const routeClassRaw =
          ext.get('route_class') ?? ext.get('rutaClase') ?? ext.get('routeClass') ?? null;
        const confidenceRaw = ext.get('confidence') ?? ext.get('confianza') ?? null;
        let confidenceNum: number | null = null;
        if (confidenceRaw !== null && confidenceRaw !== '') {
          const n = Number(confidenceRaw);
          if (Number.isFinite(n) && n >= 0 && n <= 100) confidenceNum = n;
        }

        const specs = collectGeoms(fr.node, acc);
        if (specs === null) return null; // geometría hostil ⇒ archivo hostil
        if (specs.length === 0) {
          skipped++; // placemark sin geometría: omitido con honestidad
        } else {
          const endIdx = acc.xs.length;
          // BBox por feature sobre SUS vértices (grados crudos WGS84)
          let f: BBoxWgs84 = {
            lonMin: Infinity,
            lonMax: -Infinity,
            latMin: Infinity,
            latMax: -Infinity,
          };
          for (let i = startIdx; i < endIdx; i++) {
            if (acc.xs[i] < f.lonMin) f.lonMin = acc.xs[i];
            if (acc.xs[i] > f.lonMax) f.lonMax = acc.xs[i];
            if (acc.ys[i] < f.latMin) f.latMin = acc.ys[i];
            if (acc.ys[i] > f.latMax) f.latMax = acc.ys[i];
          }
          features.push({
            uuid,
            name,
            source: 'K',
            kind: aggregateKind(specs),
            bbox: f,
            vertexCount: endIdx - startIdx,
            ...(layerTypeRaw ? { layerType: layerTypeRaw.slice(0, 64) } : {}),
            ...(routeClassRaw ? { routeClass: routeClassRaw.slice(0, 64) } : {}),
            ...(confidenceNum !== null ? { confidence: confidenceNum } : {}),
          } as IdentityFeature & { layerType?: string; routeClass?: string; confidence?: number });
        }
        continue; // los placemarks no se anidan
      }
      for (let i = fr.node.kids.length - 1; i >= 0; i--)
        stack.push({ node: fr.node.kids[i], inPlacemark: fr.inPlacemark });
    }
  }

  progress('KML interpretado', 60);
  return { features, placemarks, skipped, version, docLayerType, docRouteClass, docConfidence, acc };
}

/* ------------------------------------------------------------------ */
/* API pública                                                        */
/* ------------------------------------------------------------------ */

/**
 * Identidad de las features KML (para el cruce par-a-par del pack, FR-3).
 * Null si el archivo es hostil. Las features conservan `layerType`
 * declarado en ExtendedData si existe (gramática D11, FR-4).
 */
export function parseKmlIdentity(
  src: string,
  progress: ParseProgress = () => {}
): IdentityFeature[] | null {
  const core = kmlCore(src, progress);
  if (!core) return null;
  return core.features;
}

/**
 * Punto de entrada FR-2. Parsea el TEXTO de un archivo KML 2.2 y devuelve
 * `ParseResult` o **null** si la entrada es hostil/inválida — sin lanzar
 * excepciones jamás.
 */
export function parseKml(
  text: string,
  anchor: Anchor,
  progress: ParseProgress = () => {}
): ParseResult | null {
  const core = kmlCore(text, progress);
  if (!core) return null;
  const acc = core.acc;
  if (acc.xs.length === 0) return null; // sin vértices ⇒ nada que renderizar

  /* --- anclaje escénico (idéntico al CSV / FR-1) -------------------- */
  progress('Anclando al encuadre', 80);
  const n = acc.xs.length;
  const D2R = Math.PI / 180;
  const mPerLon = 111320 * Math.cos(anchor.centerLat * D2R);
  const M_PER_DEG_LAT = 110540;
  // DRAPE-1: sin zMid horneado — la ausencia de cota se preserva como NaN
  // y el overlay drapea el vértice sobre el MDT activo. Cota falsa jamás.
  const maxR = 0.49 * anchor.extentM;
  let outOfExtent = 0;
  for (let i = 0; i < n; i++) {
    acc.xs[i] = (acc.xs[i] - anchor.centerLon) * mPerLon;
    acc.ys[i] = (acc.ys[i] - anchor.centerLat) * M_PER_DEG_LAT;
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
  const versionLabel = core.version ? `KML ${core.version}` : 'KML 2.2';
  const rows: Array<[string, string]> = [
    ['Formato', `${versionLabel} (OGC 07-147r2)`],
    ['CRS (modo)', 'WGS84 grados — KML por especificación'],
    ['Placemarks', core.placemarks.toLocaleString('es-MX')],
    ['Geometrías', acc.geoms.toLocaleString('es-MX')],
  ];
  if (core.skipped > 0) rows.push(['Sin geometría', core.skipped.toLocaleString('es-MX')]);
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

  /* --- D11: resolución del tipo/attrs de capa (FR-4) ----------------- */
  // Hallazgo del inventario forense FR-4 (re-verificado in situ): el tipo
  // a nivel Placemark (como declara rutas_sinteticas.kml) NO llegaba al
  // meta — solo el doc-level ⇒ la capa renderizaba como vector genérico.
  // Fallback determinista: doc-level gana; si no, PRIMER Placemark en
  // orden de documento; mezcla de tipos ⇒ fila honesta en la ficha.
  const firstOf = <K extends 'layerType' | 'routeClass' | 'confidence'>(
    key: K
  ): IngestMeta[K] => {
    for (const f of core.features) {
      const v = (f as unknown as Record<string, unknown>)[key];
      if (v !== undefined) return v as IngestMeta[K];
    }
    return undefined;
  };
  const tiposDeclarados = new Set<string>();
  for (const f of core.features) {
    const lt = (f as unknown as Record<string, unknown>)['layerType'];
    if (typeof lt === 'string') tiposDeclarados.add(lt);
  }
  if (tiposDeclarados.size > 1)
    rows.push([
      'D11 mezcla de tipos',
      `${[...tiposDeclarados].join(' · ')} — se aplica «${core.docLayerType ?? [...tiposDeclarados][0]}» (primero del documento)`,
    ]);
  const metaLayerType = core.docLayerType ?? firstOf('layerType');
  const metaRouteClass = core.docRouteClass ?? firstOf('routeClass');
  const metaConfidence = core.docConfidence ?? firstOf('confidence');
  if (metaRouteClass) rows.push(['D11 clase de ruta', metaRouteClass]);
  if (metaConfidence !== undefined) rows.push(['D11 confianza', `${metaConfidence}%`]);

  const meta: IngestMeta = {
    format: 'kml',
    label: versionLabel,
    magicOk: true,
    rows,
    entities: {
      placemarks: core.placemarks,
      geometrias: acc.geoms,
      vertices: n,
      aristas: acc.segs.length / 2,
      puntos: acc.pts.length,
    },
    truncated: acc.truncated || undefined,
    crs: 'WGS84 (KML)',
    layerType: metaLayerType,
    ...(metaRouteClass ? { routeClass: metaRouteClass } : {}),
    ...(metaConfidence !== undefined ? { confidence: metaConfidence } : {}),
  };

  const geom: IngestGeom = {
    verts,
    segs: new Uint32Array(acc.segs),
    pts: new Uint32Array(acc.pts),
  };

  progress('KML listo', 100);
  return { meta, geom };
}
