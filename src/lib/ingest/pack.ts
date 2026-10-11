/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FR-3 — Mission Pack ZIP: manifest → dispatch por rol · cruce triangular
 * A↔B↔KML · SHA-256 del pack completo en custodia (agenda FR 1.0, orden
 * fijo del propietario · checkpoint de ingeniería).
 *
 * Contrato de la agenda:
 *   - manifest.json con parseo TOLERANTE + validación MÍNIMA: debe ser un
 *     objeto con `miembros` array; cada miembro {role, path} strings.
 *     Miembros desconocidos o ausentes del pack ⇒ entrada honesta «no
 *     procesado» — NO son hostilidad.
 *   - Dispatch por rol: A → FR-1 (GeoJSON) · B → FR-1 · KML → FR-2 ·
 *     friction.tif → campo de fricción D12 (FR-5: decodificación SYNC,
 *     None/LZW/PackBits) · schema/datum → ficha. Desconocido ⇒ «no
 *     procesado» honesto.
 *   - Cruce triangular por UUID (identity.ts): A↔B, A↔K, B↔K. Reglas
 *     cross-CRS del checkpoint: CODIFICACION_DISTINTA = pase con nota;
 *     DIVERGE = fallo (visible en LIENZO por H-4).
 *   - H-1: el digest del manifest es DETERMINISTA — se normaliza el JSON
 *     (claves ordenadas, campos volátiles como `generado`/`timestamp`
 *     eliminados) antes de hashear ⇒ regenerate-and-compare posible.
 *   - Custodia: SHA-256 del PACK COMPLETO viaja en `meta.custody` y la
 *     bitácora lo registra (H-3: el fallo de bitácora NO puede ser
 *     silencioso — ver ingest.ts).
 *   - Hostil ⇒ null sin excepciones: el lector ZIP ya rechaza toda la
 *     catálogo hostil; aquí se añade manifest ausente/fracturado.
 *
 * FR-W1: los fixtures de la suite son sintéticos — ningún dato de misión
 * real se commitea.
 */

import {
  MAX_FILE_BYTES,
  normalizeToScene,
  type Anchor,
  type IngestMeta,
  type IngestGeom,
  type ParseProgress,
  type ParseResult,
} from './parsers';
import { parseGeoJson, utm14nToWgs84 } from './geojson';
import { parseKml, parseKmlIdentity } from './kml';
import { readZip } from './zip';
import {
  crossTriangle,
  normalizeUuid,
  type IdentityFeature,
  type TriangleReport,
} from './identity';
import { sha256Hex, sha256HexBytes } from '../terrain/sha256';
import { decodeGeoTiffFieldSync } from './geotiff-dem';
import { buildFrictionField, frictionRows, type FrictionField } from './friction';
import { parseBilGeoid, geoidFichaRows, type GeoidModel } from './geoid';

/** Base de nombre (sin ruta ni extensión) para emparejar HDR/BIL del pack. */
function baseOfPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base);
}

/* ------------------------------------------------------------------ */
/* Manifest                                                           */
/* ------------------------------------------------------------------ */

interface Member {
  role: string;
  path: string;
  layerType?: string;
  /** v1.1 defensiva (FR-4): clase de ruta propuesta; tolerante a alias. */
  routeClass?: string;
  /** v1.1 defensiva: confianza 0-100; inválida ⇒ ignorada (= ausente). */
  confidence?: number;
}

interface Manifest {
  version: string | null;
  mision: string | null;
  miembros: Member[];
}

/**
 * Parseo tolerante del manifest: acepta campos extra, roles en cualquier
 * caso, `miembros` ausente (⇒ vacío). Validación MÍNIMA: objeto raíz y
 * miembros con role/path strings ⇒ si no, null (hostil).
 */
function readManifest(text: string): Manifest | null {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (t.trim() === '') return null;
  let root: unknown;
  try {
    root = JSON.parse(t);
  } catch {
    return null; // JSON fracturado ⇒ hostil
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const o = root as Record<string, unknown>;
  const miembrosRaw = o.miembros ?? o.members; // tolerante al nombre
  if (miembrosRaw !== undefined && !Array.isArray(miembrosRaw)) return null;
  const miembros: Member[] = [];
  for (const m of Array.isArray(miembrosRaw) ? miembrosRaw : []) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const mo = m as Record<string, unknown>;
    if (typeof mo.role !== 'string' || typeof mo.path !== 'string') return null;
    const member: Member = { role: mo.role, path: mo.path };
    if (typeof mo.layerType === 'string') member.layerType = mo.layerType.slice(0, 64);
    // v1.1 defensiva: alias ADR (rutaClase) + checkpoint (route_class) —
    // consumidos si presentes, default si ausentes (REQ-10 en la emisión).
    const rc = mo.routeClass ?? mo.route_class ?? mo.rutaClase;
    if (typeof rc === 'string' && rc.trim() !== '') member.routeClass = rc.trim().slice(0, 64);
    const cf = mo.confidence ?? mo.confianza;
    const cfNum = typeof cf === 'number' ? cf : typeof cf === 'string' ? Number(cf) : NaN;
    if (Number.isFinite(cfNum) && cfNum >= 0 && cfNum <= 100) member.confidence = cfNum;
    miembros.push(member);
  }
  const version = typeof o.version === 'string' ? o.version.slice(0, 32) : null;
  const mision = typeof o.mision === 'string' ? o.mision.slice(0, 200) : null;
  return { version, mision, miembros };
}

/**
 * H-1 — Digest determinista del manifest: claves ordenadas, sin campos
 * volátiles (generado/timestamp/fecha/createdAt/updatedAt/fechaGeneracion).
 * Dos regeneraciones del mismo pack con distinta marca de tiempo producen
 * el MISMO digest ⇒ regenerate-and-compare.
 */
const VOLATILE_KEYS = new Set([
  'generado',
  'timestamp',
  'fecha',
  'createdAt',
  'updatedAt',
  'fechaGeneracion',
  'generated',
  'date',
]);

function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => canonicalJson(x));
    parts.sort(); // orden canónico también para arrays (identidad, no semántica)
    return `[${parts.join(',')}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => !VOLATILE_KEYS.has(k))
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/* ------------------------------------------------------------------ */
/* Identidad GeoJSON (cara A/B del triángulo)                         */
/* ------------------------------------------------------------------ */

interface RawPos {
  lon: number;
  lat: number;
  utm: boolean;
}

/** Extrae la identidad de un GeoJSON para el cruce (tolerante: las
 *  features inválidas se omiten — el parseo estricto ya corrió aparte). */
export function geojsonIdentity(text: string): IdentityFeature[] | null {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (t.trim() === '') return null;
  let root: unknown;
  try {
    root = JSON.parse(t);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object') return null;
  const o = root as { type?: unknown; features?: unknown; geometry?: unknown; properties?: unknown };
  let featuresRaw: unknown[];
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) featuresRaw = o.features;
  else if (o.type === 'Feature') featuresRaw = [root];
  else return null;

  const out: IdentityFeature[] = [];
  for (const f of featuresRaw) {
    if (!f || typeof f !== 'object') continue;
    const fo = f as { properties?: unknown; geometry?: unknown };
    const props = (fo.properties && typeof fo.properties === 'object' ? fo.properties : {}) as Record<string, unknown>;
    const uuid = normalizeUuid(props.uuid ?? props.UUID ?? props.id);
    const name = typeof props.nombre === 'string' ? props.nombre.slice(0, 200) : typeof props.name === 'string' ? props.name.slice(0, 200) : '';
    const positions: RawPos[] = [];
    let kind: IdentityFeature['kind'] | null = null;
    const walk = (g: unknown): void => {
      if (!g || typeof g !== 'object') return;
      const go = g as { type?: unknown; coordinates?: unknown; geometries?: unknown };
      switch (go.type) {
        case 'Point':
          kind = kind === 'poligono' ? kind : 'punto';
          collect(go.coordinates, false);
          break;
        case 'MultiPoint':
          kind = kind === 'poligono' ? kind : 'punto';
          if (Array.isArray(go.coordinates)) for (const p of go.coordinates) collect(p, false);
          break;
        case 'LineString':
        case 'MultiLineString':
          kind = kind === 'poligono' ? kind : 'linea';
          if (go.type === 'LineString') collect(go.coordinates, true);
          else if (Array.isArray(go.coordinates))
            for (const part of go.coordinates as unknown[]) collect(part, true);
          break;
        case 'Polygon':
        case 'MultiPolygon':
          kind = 'poligono';
          if (go.type === 'Polygon') {
            if (Array.isArray(go.coordinates))
              for (const ring of go.coordinates as unknown[]) collect(ring, true);
          } else if (Array.isArray(go.coordinates)) {
            for (const poly of go.coordinates as unknown[])
              if (Array.isArray(poly))
                for (const ring of poly as unknown[]) collect(ring, true);
          }
          break;
        case 'GeometryCollection':
          if (Array.isArray(go.geometries)) for (const g2 of go.geometries) walk(g2);
          break;
        default:
          break; // desconocido: se omite (honesto para el cruce)
      }
    };
    const collect = (c: unknown, line: boolean): void => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === 'number') {
        const lon = c[0] as number;
        const lat = c[1] as number;
        if (typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat)) {
          positions.push({ lon, lat, utm: Math.abs(lon) > 180 || Math.abs(lat) > 90 });
        }
        return;
      }
      for (const sub of c) collect(sub, line);
    };
    walk(fo.geometry);
    if (!kind || positions.length === 0) continue;
    // UTM ⇒ WGS84 (conversión canónica de FR-1) para el BBox de identidad
    let lonMin = Infinity,
      lonMax = -Infinity,
      latMin = Infinity,
      latMax = -Infinity;
    let anyUtm = false;
    let ok = true;
    for (const p of positions) {
      let lon = p.lon;
      let lat = p.lat;
      if (p.utm) {
        anyUtm = true;
        const c = utm14nToWgs84(lon, lat);
        if (!c) {
          ok = false;
          break;
        }
        lon = c[0];
        lat = c[1];
      }
      if (lon < lonMin) lonMin = lon;
      if (lon > lonMax) lonMax = lon;
      if (lat < latMin) latMin = lat;
      if (lat > latMax) latMax = lat;
    }
    if (!ok) continue;
    out.push({
      uuid,
      name,
      source: 'A',
      kind,
      bbox: { lonMin, lonMax, latMin, latMax },
      vertexCount: positions.length,
    });
    void anyUtm;
  }
  // La fuente real (A o B) se corrige en parseMissionPack antes del cruce.
  return out;
}

function reSource(list: IdentityFeature[], source: 'A' | 'B'): IdentityFeature[] {
  return list.map((f) => ({ ...f, source }));
}

/* ------------------------------------------------------------------ */
/* Parser principal                                                   */
/* ------------------------------------------------------------------ */

interface MemberResult {
  role: string;
  path: string;
  status: 'ok' | 'error' | 'auditado' | 'no-procesado';
  note: string;
  vertices: number;
  aristas: number;
  puntos: number;
}

/**
 * Punto de entrada FR-3. Parsea el BUFFER de un Mission Pack ZIP y
 * devuelve `ParseResult` (geometría combinada de los miembros con
 * geometría) o **null** si el pack es hostil — sin lanzar excepciones.
 */
export function parseMissionPack(
  buf: ArrayBuffer,
  anchor: Anchor,
  progress: ParseProgress = () => {}
): ParseResult | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0 || buf.byteLength > MAX_FILE_BYTES)
    return null;
  const bytes = new Uint8Array(buf);

  progress('Hasheando el pack (custodia)', 5);
  const packSha = sha256HexBytes(bytes);

  progress('Leyendo el archivo ZIP', 10);
  const zip = readZip(bytes);
  if (!zip.ok) return null; // catálogo hostil completo del lector

  const byName = new Map<string, (typeof zip.entries)[number]>();
  for (const e of zip.entries) {
    if (!byName.has(e.name)) byName.set(e.name, e); // duplicados ya rechazados arriba
  }

  const manifestEntry =
    byName.get('manifest.json') ?? byName.get('MANIFEST.JSON') ?? byName.get('Manifest.json');
  if (!manifestEntry) return null; // sin manifest ⇒ no es un Mission Pack

  progress('Validando el manifest', 18);
  const manifestText = new TextDecoder('utf-8', { fatal: false }).decode(manifestEntry.data);
  const manifest = readManifest(manifestText);
  if (!manifest) return null; // manifest fracturado ⇒ hostil
  const manifestDigest = sha256Hex(canonicalJson(JSON.parse(manifestText) as unknown)); // determinista (H-1)

  /* --- dispatch por rol -------------------------------------------- */
  progress('Dispatch por rol', 30);
  const results: MemberResult[] = [];
  const identA: IdentityFeature[] = [];
  const identB: IdentityFeature[] = [];
  const identK: IdentityFeature[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const segs: number[] = [];
  const pts: number[] = [];
  /* FR-5 · D12: campo de fricción del pack (rol FRICTION*) — vía al LIENZO */
  let frictionField: FrictionField | undefined;
  /* FR-7 · GGM25: miembros del geoides (par HDR+BIL + PRJ opcional). */
  let geoidHdr: Uint8Array | undefined;
  let geoidBil: Uint8Array | undefined;
  let geoidPrj: Uint8Array | undefined;
  let geoidName = 'geoid';
  let firstLayerType: string | undefined = undefined;
  let firstRouteClass: string | undefined = undefined;
  let firstConfidence: number | undefined = undefined;
  let ver = 0;

  const pushGeom = (geom: IngestGeom): void => {
    const off = xs.length / 3;
    for (let i = 0; i < geom.verts.length; i += 3) {
      xs.push(geom.verts[i]);
      ys.push(geom.verts[i + 1]);
      zs.push(geom.verts[i + 2]);
    }
    for (let i = 0; i < geom.segs.length; i++) segs.push(geom.segs[i] + off);
    for (let i = 0; i < geom.pts.length; i++) pts.push(geom.pts[i] + off);
  };

  for (const m of manifest.miembros) {
    const entry = byName.get(m.path);
    if (!entry) {
      results.push({
        role: m.role,
        path: m.path,
        status: 'no-procesado',
        note: 'declarado en el manifest pero ausente del pack',
        vertices: 0,
        aristas: 0,
        puntos: 0,
      });
      continue;
    }
    const role = m.role.toUpperCase();
    if (role === 'A' || role === 'B') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
      const r = parseGeoJson(text, anchor, progress);
      const ident = geojsonIdentity(text);
      if (!r || !ident) {
        results.push({
          role: m.role,
          path: m.path,
          status: 'error',
          note: 'GeoJSON hostil o inválido — rechazo limpio del miembro',
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
        continue;
      }
      (role === 'A' ? identA : identB).push(...reSource(ident, role === 'A' ? 'A' : 'B'));
      pushGeom(r.geom as IngestGeom);
      ver += (r.geom as IngestGeom).verts.length / 3;
      if (!firstLayerType && m.layerType) firstLayerType = m.layerType;
      if (!firstRouteClass && m.routeClass) firstRouteClass = m.routeClass;
      if (firstConfidence === undefined && m.confidence !== undefined) firstConfidence = m.confidence;
      results.push({
        role: m.role,
        path: m.path,
        status: 'ok',
        note: `GeoJSON — ${r.meta.entities?.vertices ?? 0} vértices`,
        vertices: r.meta.entities?.vertices ?? 0,
        aristas: r.meta.entities?.aristas ?? 0,
        puntos: r.meta.entities?.puntos ?? 0,
      });
    } else if (role === 'KML') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
      const r = parseKml(text, anchor, progress);
      const ident = parseKmlIdentity(text, progress);
      if (!r || !ident) {
        results.push({
          role: m.role,
          path: m.path,
          status: 'error',
          note: 'KML hostil o inválido — rechazo limpio del miembro',
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
        continue;
      }
      identK.push(...ident);
      pushGeom(r.geom as IngestGeom);
      ver += (r.geom as IngestGeom).verts.length / 3;
      if (!firstLayerType && m.layerType) firstLayerType = m.layerType;
      if (!firstRouteClass && m.routeClass) firstRouteClass = m.routeClass;
      if (firstConfidence === undefined && m.confidence !== undefined) firstConfidence = m.confidence;
      results.push({
        role: m.role,
        path: m.path,
        status: 'ok',
        note: `${r.meta.label} — ${r.meta.entities?.placemarks ?? 0} placemarks`,
        vertices: r.meta.entities?.vertices ?? 0,
        aristas: r.meta.entities?.aristas ?? 0,
        puntos: r.meta.entities?.puntos ?? 0,
      });
    } else if (role === 'FRICTION.TIF' || role === 'FRICTION' || role === 'FRICTION_TIF') {
      /* FR-5 · D12: el rol ya no es solo auditoría — el miembro se DECODIFICA
         como campo de fricción (costo) y viaja al LIENZO como capa de tramas.
         Fallo de decodificación ⇒ fila honesta (el pack sigue siendo válido:
         la geometría A/B/KML manda). */
      const isTiff =
        entry.data.length > 8 &&
        ((entry.data[0] === 0x49 && entry.data[1] === 0x49 && entry.data[2] === 0x2a && entry.data[3] === 0) ||
          (entry.data[0] === 0x4d && entry.data[1] === 0x4d && entry.data[2] === 0 && entry.data[3] === 0x2a));
      if (!isTiff) {
        results.push({
          role: m.role,
          path: m.path,
          status: 'error',
          note: 'cabecera TIFF no reconocida — campo de fricción no decodificado',
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
        continue;
      }
      try {
        // copia propia (slice) ⇒ ArrayBuffer propio, sin vistas compartidas
        const fieldBuf = entry.data.slice().buffer as ArrayBuffer;
        const dem = decodeGeoTiffFieldSync(fieldBuf);
        frictionField = buildFrictionField(dem);
        results.push({
          role: m.role,
          path: m.path,
          status: 'ok',
          note: `campo de fricción decodificado (D12) — clases ${frictionField.classCounts.join('/')}`,
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
      } catch (err) {
        results.push({
          role: m.role,
          path: m.path,
          status: 'error',
          note: `campo no decodificado — ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
      }
    } else if (role === 'SCHEMA' || role === 'DATUM' || role === 'PRJ' || role === 'WKT') {
      results.push({
        role: m.role,
        path: m.path,
        status: 'auditado',
        note: `ficha: ${entry.data.length.toLocaleString('es-MX')} B · CRC32 verificado`,
        vertices: 0,
        aristas: 0,
        puntos: 0,
      });
    } else if (role.startsWith('GEOID')) {
      /* FR-7 · GGM25: sub-grid regional como miembro OPCIONAL del pack
         (par GEOID-HDR + GEOID-BIL, PRJ opcional). CAVEAT V-3: el sub-grid
         es un DERIVADO de INEGI — su elaboración y redistribución son
         decisión del instituto (pendiente); este canal solo INGIERE el
         miembro que un pack ya trae. */
      const kind = role.replace(/^GEOID[-_.]/, '');
      if (kind === 'BIL') {
        geoidBil = entry.data;
        results.push({
          role: m.role,
          path: m.path,
          status: 'auditado',
          note: `miembro geoid (BIL) — ${entry.data.length.toLocaleString('es-MX')} B · CRC32 verificado`,
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
      } else if (kind === 'HDR') {
        geoidHdr = entry.data;
        geoidName = baseOfPath(m.path);
        results.push({
          role: m.role,
          path: m.path,
          status: 'auditado',
          note: `miembro geoid (HDR) — ${entry.data.length.toLocaleString('es-MX')} B · CRC32 verificado`,
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
      } else if (kind === 'PRJ') {
        geoidPrj = entry.data;
        results.push({
          role: m.role,
          path: m.path,
          status: 'auditado',
          note: `miembro geoid (PRJ) — ${entry.data.length.toLocaleString('es-MX')} B · CRC32 verificado`,
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
      } else {
        results.push({
          role: m.role,
          path: m.path,
          status: 'error',
          note: `rol GEOID-* con variante desconocida «${kind}» — se esperaba BIL/HDR/PRJ`,
          vertices: 0,
          aristas: 0,
          puntos: 0,
        });
      }
    } else {
      // Rol desconocido ⇒ honesto, nunca hostil
      results.push({
        role: m.role,
        path: m.path,
        status: 'no-procesado',
        note: 'rol desconocido — el pack no lo interpreta (honesto)',
        vertices: 0,
        aristas: 0,
        puntos: 0,
      });
    }
  }
  // Miembros del ZIP no declarados en el manifest: honestos
  for (const e of zip.entries) {
    if (e.name === 'manifest.json') continue;
    if (!manifest.miembros.some((m) => m.path === e.name)) {
      results.push({
        role: '—',
        path: e.name,
        status: 'no-procesado',
        note: 'presente en el pack pero no declarado en el manifest',
        vertices: 0,
        aristas: 0,
        puntos: 0,
      });
    }
  }

  /* --- cruce triangular --------------------------------------------- */
  progress('Cruce triangular A↔B↔KML', 60);
  const triangle: TriangleReport = crossTriangle(identA, identB, identK);

  /* --- geoides del pack (FR-7 · GGM25) ------------------------------- */
  const rowsGeoid: Array<[string, string]> = [];
  let geoid: GeoidModel | undefined;
  if (geoidBil || geoidHdr) {
    if (!geoidBil || !geoidHdr) {
      rowsGeoid.push(['Geoid', 'par HDR+BIL incompleto — modelo no cargado (honesto)']);
    } else {
      const g = parseBilGeoid(geoidHdr, geoidBil, geoidPrj ?? null, geoidName);
      if (g.ok) {
        geoid = g.model;
        rowsGeoid.push(...geoidFichaRows(g.model));
      } else {
        rowsGeoid.push(['Geoid', `rechazado — ${g.reason}`]);
      }
    }
  }

  /* --- geometría combinada ------------------------------------------ */
  if (xs.length === 0) return null; // ningún miembro aportó geometría

  progress('Anclando al encuadre', 80);
  const n = xs.length;
  let verts: Float32Array;
  // Los miembros ya vienen anclados por sus parsers (mismo anchor ⇒ misma
  // proyección) — la geometría combinada conserva esas coordenadas.
  verts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    verts[i * 3] = xs[i];
    verts[i * 3 + 1] = ys[i];
    verts[i * 3 + 2] = zs[i];
  }
  void normalizeToScene; // (anclaje por miembro; el pack no re-encuadra)

  /* --- ficha --------------------------------------------------------- */
  const okCount = results.filter((r) => r.status === 'ok').length;
  const errCount = results.filter((r) => r.status === 'error').length;
  const npCount = results.filter((r) => r.status === 'no-procesado').length;
  const audCount = results.filter((r) => r.status === 'auditado').length;

  const rows: Array<[string, string]> = [
    ['Formato', 'Mission Pack ZIP (PKZIP 2.0, 0-dep)'],
    ['Misión', manifest.mision ?? '—'],
    ['Versión del manifest', manifest.version ?? '—'],
    ['Miembros', `${results.length.toLocaleString('es-MX')} · ok ${okCount} · error ${errCount} · auditados ${audCount} · no procesados ${npCount}`],
    ['SHA-256 del pack', packSha],
    ['Manifest digest (H-1)', manifestDigest],
    ['Cruce triangular', `${triangle.conteo.MATCH} MATCH · ${triangle.conteo.CODIFICACION_DISTINTA} codificación distinta · ${triangle.conteo.DIVERGE} DIVERGE · ${triangle.conteo.SIN_PAR} sin par`],
    ['Vértices', n.toLocaleString('es-MX')],
    ['Aristas', (segs.length / 2).toLocaleString('es-MX')],
    ['Puntos', pts.length.toLocaleString('es-MX')],
    ['Anclado a', anchor.regionName],
  ];
  for (const r of results) {
    rows.push([`${r.role}:${r.path}`, `${r.status} — ${r.note}`]);
  }
  rows.push(...rowsGeoid);
  if (frictionField) rows.push(...frictionRows(frictionField));
  for (const p of triangle.pares) {
    if (p.verdict !== 'MATCH')
      rows.push([`Cruce ${p.a.source}↔${p.b.source} · ${p.uuid.slice(0, 13)}…`, `${p.verdict} — ${p.note}`]);
  }

  /* B-D1 · U4: detalle de los pares NO MATCH para la señal ti4go:divergence
     (H-4 como señal — el activo único del contrato WC). */
  const cruceDetalle = triangle.pares
    .filter((p) => p.verdict !== 'MATCH')
    .map((p) => ({ uuid: p.uuid, verdict: p.verdict as string, note: p.note, par: `${p.a.source}↔${p.b.source}` }));

  const meta: IngestMeta = {
    format: 'pack',
    label: 'Mission Pack',
    magicOk: true,
    rows,
    entities: {
      entradas: zip.entries.length,
      miembros: results.length,
      procesados: okCount,
      errores: errCount,
      auditados: audCount,
      noProcesados: npCount,
      vertices: n,
      aristas: segs.length / 2,
      puntos: pts.length,
      crucesMATCH: triangle.conteo.MATCH,
      crucesCodificacion: triangle.conteo.CODIFICACION_DISTINTA,
      crucesDIVERGE: triangle.conteo.DIVERGE,
      crucesSinPar: triangle.conteo.SIN_PAR,
    },
    truncated: undefined,
    crs: 'por miembro (A/B GeoJSON · KML WGS84)',
    layerType: firstLayerType,
    ...(firstRouteClass ? { routeClass: firstRouteClass } : {}),
    ...(firstConfidence !== undefined ? { confidence: firstConfidence } : {}),
    ...(cruceDetalle.length > 0 ? { cruceDetalle } : {}),
    diverge: !triangle.ok,
    custody: `pack sha256:${packSha} · manifest:${manifestDigest}`,
  };

  const geom: IngestGeom = {
    verts,
    segs: new Uint32Array(segs),
    pts: new Uint32Array(pts),
  };

  progress('Mission Pack listo', 100);
  if (frictionField && geoid) return { meta, geom, field: frictionField, geoid };
  if (frictionField) return { meta, geom, field: frictionField };
  if (geoid) return { meta, geom, geoid };
  return { meta, geom };
}
