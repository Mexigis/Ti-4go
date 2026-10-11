/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-1 — Parser GeoJSON dual (agenda FR 1.0, orden fijo del
 * propietario, checkpoint de ingeniería).
 *
 * Fija con aserciones el contrato del FR-1:
 *   - Golden fixtures: RFC 7946 en grados · UTM 14N con crs declarado
 *     (string y forma OGC) · UTM 14N SIN crs (auto-detección por magnitud,
 *     geom bit-exacto igual al declarado).
 *   - HOSTILES ⇒ null: 28 entradas en 3 clases (estructurales, coordenadas,
 *     CRS/magnitud) — el parser jamás lanza, devuelve null.
 *   - Invariantes geodésicas UTM 14N ⇄ WGS84 contra ground truth
 *     independiente (integración numérica Simpson del arco de meridiano,
 *     la definición misma) + round-trip de malla + meridiano central.
 *   - Pins de EXTENSIÓN registrados hoy (misma práctica que MXP1):
 *     utm14nToWgs84(257000, 2324000) = [-101.33766408313998, 21.00067878291531]
 *     utm14nToWgs84(259000, 2326000) = [-101.3187151482358,  21.018998268137057]
 *     (caen sobre la Cuenca de la Soledad, zona piloto).
 *
 * Ledger de auditoría: tests/expects verificados contra la salida de bun
 * (aserciones incondicionales; sin ramas condicionales que alteren el conteo).
 */
import { describe, expect, test } from 'bun:test';
import {
  parseGeoJson,
  utm14nToWgs84,
  wgs84ToUtm14n,
} from '../src/lib/ingest/geojson';
import {
  MAX_VERTS,
  MAX_FILE_BYTES,
  detectFormat,
  parseFile,
  type Anchor,
} from '../src/lib/ingest/parsers';

const ANCHOR: Anchor = {
  extentM: 8000,
  zMinM: 1950,
  zMaxM: 2600,
  centerLat: 21.0,
  centerLon: -101.33,
  regionName: 'prueba-fr1',
};

const M_PER_LON = 111320 * Math.cos((21.0 * Math.PI) / 180); // constante equirect. del CSV

/* ------------------------------------------------------------------ */
/* Golden fixtures                                                    */
/* ------------------------------------------------------------------ */

const GOLDEN_FC = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { nombre: 'Arroyo principal', cota: 2050 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-101.35, 21.0],
          [-101.34, 21.01],
          [-101.33, 21.02],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { nombre: 'Cerro testigo' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-101.32, 21.0],
            [-101.31, 21.0],
            [-101.31, 21.01],
            [-101.32, 21.01],
            [-101.32, 21.0],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { nombre: 'Pozo 1' },
      geometry: { type: 'Point', coordinates: [-101.33, 21.01, 2048.5] },
    },
  ],
});

const GOLDEN_UTM_DECL = JSON.stringify({
  type: 'Feature',
  crs: { type: 'name', properties: { name: 'EPSG:32614' } },
  properties: { nombre: 'Divisoria Soledad', cota: 2300 },
  geometry: {
    type: 'LineString',
    coordinates: [
      [257000, 2324000],
      [258000, 2325000],
      [259000, 2326000],
    ],
  },
});

describe('FR-1 · golden RFC 7946 (grados)', () => {
  test('FeatureCollection 3 features ⇒ estructura exacta y ficha', () => {
    const r = parseGeoJson(GOLDEN_FC, ANCHOR);
    expect(r).not.toBeNull();
    expect(r!.meta.format).toBe('geojson');
    expect(r!.meta.magicOk).toBe(true);
    expect(r!.meta.crs).toBe('geográfico WGS84 (RFC 7946)');
    expect(r!.geom).not.toBeNull();
    expect(r!.geom!.verts.length).toBe(27); // 3 + 5 + 1 posiciones ×3
    expect(r!.geom!.segs.length).toBe(12); // 2 aristas línea + 4 anillo cerrado
    expect(r!.geom!.pts.length).toBe(1); // un Point
    expect(r!.meta.entities?.features).toBe(3);
    expect(r!.meta.entities?.vertices).toBe(9);
    const modo = r!.meta.rows.find((x) => x[0] === 'CRS (modo)');
    expect(modo?.[1]).toBe('WGS84 grados — RFC 7946');
  });

  test('anclaje escénico bit-exacto (mismas constantes que CSV)', () => {
    const r = parseGeoJson(GOLDEN_FC, ANCHOR)!;
    const v = r.geom!.verts; // Float32: precisión ~7 dígitos ⇒ tolerancia 4 dec
    expect(v[0]).toBeCloseTo((-101.35 - -101.33) * M_PER_LON, 4);
    expect(v[1]).toBeCloseTo((21.0 - 21.0) * 110540, 4);
    expect(v[3]).toBeCloseTo((-101.34 - -101.33) * M_PER_LON, 4);
    expect(v[4]).toBeCloseTo((21.01 - 21.0) * 110540, 4);
  });

  test('cotas: 3ª coordenada > property > NaN preservado (DRAPE-1: drape al dibujar)', () => {
    const r = parseGeoJson(GOLDEN_FC, ANCHOR)!;
    const v = r.geom!.verts;
    expect(v[2]).toBe(2050); // línea: z de property cota
    expect(v[26]).toBe(2048.5); // punto: 3ª coordenada explícita (z en índice 26)
    // DRAPE-1 (directiva ): vértice SIN cota ⇒ NaN
    // preservado — el overlay lo drapea sobre el MDT activo (z del terreno
    // + lift 2–3 px). El zMid horneado ocultaba la señal y flotaba la
    // capa a media altura: cota falsa jamás.
    expect(Number.isNaN(v[11])).toBe(true); // polígono (vértices 9–23): sin cota
    // clamp: cota fuera de rango se recorta
    const fc = JSON.stringify({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-101.33, 21.0, 9999] },
    });
    expect(parseGeoJson(fc, ANCHOR)!.geom!.verts[2]).toBe(2600);
  });

  test('determinismo bit-exacto (mismo archivo ⇒ mismo buffer)', () => {
    const a = parseGeoJson(GOLDEN_FC, ANCHOR)!;
    const b = parseGeoJson(GOLDEN_FC, ANCHOR)!;
    expect(Buffer.from(a.geom!.verts.buffer).equals(Buffer.from(b.geom!.verts.buffer))).toBe(true);
    expect(Buffer.from(a.geom!.segs.buffer).equals(Buffer.from(b.geom!.segs.buffer))).toBe(true);
  });

  test('todos los tipos de geometría + GeometryCollection iterativo', () => {
    const gc = JSON.stringify({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [-101.33, 21.0] },
        { type: 'MultiPoint', coordinates: [[-101.32, 21.0], [-101.31, 21.01]] },
        { type: 'MultiLineString', coordinates: [[[-101.35, 21.0], [-101.34, 21.0]]] },
        {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [-101.32, 21.0],
                [-101.31, 21.0],
                [-101.31, 21.01],
                [-101.32, 21.0],
              ],
            ],
          ],
        },
      ],
    });
    const r = parseGeoJson(gc, ANCHOR);
    expect(r).not.toBeNull();
    expect(r!.geom!.verts.length).toBe(3 + 6 + 6 + 12); // 9 posiciones ×3... 1+2+2+4 = 9 → 27? no: MP 2→6, MLS 2→6, MPoly 4→12
    expect(r!.geom!.verts.length).toBe(27);
    expect(r!.geom!.pts.length).toBe(3); // Point + 2 MultiPoint
  });

  test('BOM UTF-8 tolerado (interop real)', () => {
    const r = parseGeoJson('\uFEFF' + GOLDEN_FC, ANCHOR);
    expect(r).not.toBeNull();
    expect(r!.geom!.verts.length).toBe(27);
  });

  test('Feature con geometry null se omite; solo-null ⇒ null', () => {
    const mixto = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: null },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [-101.33, 21.0] },
        },
      ],
    });
    const r = parseGeoJson(mixto, ANCHOR);
    expect(r).not.toBeNull();
    expect(r!.geom!.verts.length).toBe(3);
    expect(r!.meta.rows.find((x) => x[0] === 'Sin geometría')?.[1]).toBe('1');
    const soloNull = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: null }],
    });
    expect(parseGeoJson(soloNull, ANCHOR)).toBeNull();
  });

  test('detección de formato: extensión .geojson/.json y sniff sin extensión', () => {
    const head = new TextEncoder().encode('  {"type":"FeatureCollection"}');
    expect(detectFormat('mision.geojson', head)).toBe('geojson');
    expect(detectFormat('datos.json', head)).toBe('geojson');
    expect(detectFormat('sin_extension', head)).toBe('geojson');
    expect(detectFormat('binario.xyz', new Uint8Array([0x00, 0x01, 0x02]))).not.toBe('geojson');
  });

  test('parseFile: golden ok · hostil lanza Error legible (rechazo limpio)', () => {
    const buf = new TextEncoder().encode(GOLDEN_FC).buffer as ArrayBuffer;
    const r = parseFile('zona.geojson', buf, ANCHOR);
    expect(r.meta.format).toBe('geojson');
    const hostil = new TextEncoder().encode('{"type":"Nonsense"}').buffer as ArrayBuffer;
    expect(() => parseFile('malo.geojson', hostil, ANCHOR)).toThrow(/GeoJSON hostil o inválido/);
  });
});

describe('FR-1 · golden UTM 14N (dual + auto-detección)', () => {
  test('crs declarado (forma OGC) ⇒ modo declarado + crs EPSG:32614', () => {
    const r = parseGeoJson(GOLDEN_UTM_DECL, ANCHOR);
    expect(r).not.toBeNull();
    expect(r!.meta.crs).toBe('EPSG:32614 (UTM 14N)');
    expect(r!.meta.rows.find((x) => x[0] === 'CRS (modo)')?.[1]).toBe('UTM 14N — crs declarado');
  });

  test('crs declarado (forma string "EPSG:32614") ⇒ mismo resultado', () => {
    const str = JSON.stringify(JSON.parse(GOLDEN_UTM_DECL), (k, v) =>
      k === 'crs' ? 'EPSG:32614' : v
    );
    const a = parseGeoJson(GOLDEN_UTM_DECL, ANCHOR)!;
    const b = parseGeoJson(str, ANCHOR)!;
    expect(b.meta.rows.find((x) => x[0] === 'CRS (modo)')?.[1]).toBe('UTM 14N — crs declarado');
    expect(Buffer.from(a.geom!.verts.buffer).equals(Buffer.from(b.geom!.verts.buffer))).toBe(true);
  });

  test('SIN crs ⇒ inferido por magnitud, geom bit-exacto al declarado', () => {
    const sinCrs = JSON.stringify(JSON.parse(GOLDEN_UTM_DECL), (k, v) =>
      k === 'crs' ? undefined : v
    );
    const a = parseGeoJson(GOLDEN_UTM_DECL, ANCHOR)!;
    const b = parseGeoJson(sinCrs, ANCHOR)!;
    expect(b.meta.rows.find((x) => x[0] === 'CRS (modo)')?.[1]).toBe(
      'UTM 14N — inferido por magnitud'
    );
    expect(Buffer.from(a.geom!.verts.buffer).equals(Buffer.from(b.geom!.verts.buffer))).toBe(true);
  });

  test('el fixture cae sobre la Soledad y ancla SIN re-encuadre', () => {
    const r = parseGeoJson(GOLDEN_UTM_DECL, ANCHOR)!;
    // Local meters: primera posición UTM → WGS84 → equirect alrededor del centro
    const [lon0, lat0] = utm14nToWgs84(257000, 2324000)!;
    const v = r.geom!.verts; // Float32: tolerancia 4 decimales
    expect(v[0]).toBeCloseTo((lon0 - -101.33) * M_PER_LON, 4);
    expect(v[1]).toBeCloseTo((lat0 - 21.0) * 110540, 4);
    // dentro del extent (sin normalización de caja): |x|,|y| < 0.49·extent
    expect(Math.abs(v[0])).toBeLessThan(0.49 * ANCHOR.extentM);
    expect(Math.abs(v[1])).toBeLessThan(0.49 * ANCHOR.extentM);
    // BBox en WGS84 (unidades convertidas, no UTM de origen)
    const bbox = r.meta.rows.find((x) => x[0] === 'BBox WGS84')?.[1] ?? '';
    expect(bbox.startsWith('lon -101.33')).toBe(true);
  });

  test('round-trip UTM⇄WGS84 de las posiciones del fixture ≤ 1e-4 m (0.1 mm)', () => {
    const coords = [
      [257000, 2324000],
      [258000, 2325000],
      [259000, 2326000],
    ];
    for (const [e, n] of coords) {
      const [lon, lat] = utm14nToWgs84(e, n)!;
      const [e2, n2] = wgs84ToUtm14n(lon, lat)!;
      expect(Math.abs(e2 - e)).toBeLessThan(1e-4);
      expect(Math.abs(n2 - n)).toBeLessThan(1e-4);
    }
  });
});

describe('FR-1 · invariantes geodésicas (ground truth independiente)', () => {
  /** Integración Simpson del arco de meridiano — LA definición. */
  function M_numeric(phiDeg: number, n = 200_000): number {
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);
    const phi = (phiDeg * Math.PI) / 180;
    const h = phi / n;
    const g = (t: number) => a * (1 - e2) / Math.pow(1 - e2 * Math.sin(t) ** 2, 1.5);
    let s = g(0) + g(phi);
    for (let i = 1; i < n; i++) s += g(i * h) * (i % 2 === 1 ? 4 : 2);
    return (s * h) / 3;
  }

  test('meridiano central: easting EXACTO 500000 · northing = k0·M contra Simpson', () => {
    const p = wgs84ToUtm14n(-99, 21.0)!;
    expect(p[0]).toBe(500000); // sobre el MC el easting es exacto por construcción
    const M = M_numeric(21.0);
    expect(Math.abs(p[1] - 0.9996 * M)).toBeLessThan(1e-3); // < 1 mm
  });

  test('round-trip malla 15×15 de la zona de interés ≤ 1e-3 m', () => {
    let maxD = 0;
    for (let lon = -102 + 0.25; lon <= -96 - 0.25; lon += (6 - 0.5) / 14) {
      for (let lat = 0.5; lat <= 21.5; lat += 1.5) {
        const p = wgs84ToUtm14n(lon, lat)!;
        const b = utm14nToWgs84(p[0], p[1])!;
        const dLat = Math.abs(b[1] - lat) * 110_946;
        const dLon = Math.abs(b[0] - lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
        maxD = Math.max(maxD, dLat, dLon);
      }
    }
    expect(maxD).toBeLessThan(1e-3);
  });

  test('pins de EXTENSIÓN registrados hoy (respuesta conocida 1e-9 deg)', () => {
    const a = utm14nToWgs84(257000, 2324000)!;
    expect(a[0]).toBeCloseTo(-101.33766408313998, 9);
    expect(a[1]).toBeCloseTo(21.00067878291531, 9);
    const b = utm14nToWgs84(259000, 2326000)!;
    expect(b[0]).toBeCloseTo(-101.3187151482358, 9);
    expect(b[1]).toBeCloseTo(21.018998268137057, 9);
  });

  test('fuera de la zona 14N ⇒ null (las 4 direcciones)', () => {
    expect(wgs84ToUtm14n(-95.0, 21.0)).toBeNull(); // este
    expect(wgs84ToUtm14n(-103.0, 21.0)).toBeNull(); // oeste
    expect(wgs84ToUtm14n(-99.0, -0.5)).toBeNull(); // sur del hemisferio N
    expect(wgs84ToUtm14n(-99.0, 84.5)).toBeNull(); // más allá de 84°N
  });
});

describe('FR-1 · hostiles ⇒ null (28 entradas, rechazo sin excepción)', () => {
  test('estructurales (12)', () => {
    const hostiles: string[] = [
      '', // vacío
      'no-json', // texto
      '[1,2,3]', // array raíz
      '{}', // sin type
      '{"type":"FeatureCollection"}', // sin features
      '{"type":"FeatureCollection","features":{}}', // features no-array
      '{"type":"FeatureCollection","features":[5]}', // feature no-objeto
      '{"type":"FeatureCollection","features":[{"type":"Wrong"}]}', // type≠Feature
      '{"type":"Feature","properties":{}}', // sin miembro geometry
      '{"type":"Wkt","coordinates":[1,2]}', // tipo raíz desconocido
      '{"type":"Feature","geometry":{"type":"Nonsense","coordinates":[1,2]}}', // geom desconocida
      '['.repeat(100000) + ']'.repeat(100000), // profundidad extrema ⇒ RangeError
    ];
    for (const h of hostiles) expect(parseGeoJson(h, ANCHOR)).toBeNull();
  });

  test('coordenadas (9)', () => {
    const hostiles: string[] = [
      '{"type":"Point","coordinates":[[1,2]]}', // anidado de más
      '{"type":"Point","coordinates":["a","b"]}', // no números
      '{"type":"Point","coordinates":[1]}', // aridad 1
      '{"type":"Point","coordinates":[1,2,3,4]}', // aridad 4
      '{"type":"Point","coordinates":[-101.33,21.01,1e400]}', // no finito ⇒ Infinity
      '{"type":"LineString","coordinates":[]}', // sin posiciones
      '{"type":"LineString","coordinates":[[-101.33,21.0]]}', // 1 posición (<2)
      '{"type":"Polygon","coordinates":[[[-101,21],[-100.9,21],[-100.9,21.1]]]}', // anillo abierto
      '{"type":"Polygon","coordinates":[[[-101,21],[-100.9,21]]]}', // anillo <4
    ];
    for (const h of hostiles) expect(parseGeoJson(h, ANCHOR)).toBeNull();
  });

  test('CRS y magnitud (7)', () => {
    const hostiles: string[] = [
      '{"type":"Feature","crs":"EPSG:4269","geometry":{"type":"Point","coordinates":[-101,21]}}', // CRS no soportado
      '{"type":"Feature","crs":{"type":"other"},"geometry":{"type":"Point","coordinates":[-101,21]}}', // forma desconocida
      '{"type":"Feature","crs":"EPSG:32614","geometry":{"type":"Point","coordinates":[-101,21]}}', // declara UTM, datos grados
      '{"type":"Feature","crs":"EPSG:4326","geometry":{"type":"Point","coordinates":[400000,2320000]}}', // declara WGS84, datos UTM
      '{"type":"Point","coordinates":[999999999,50]}', // sin crs: ni grados ni UTM
      '{"type":"Point","coordinates":[500000,9990000]}', // UTM-magnitud pero lat≈90 ⇒ fuera de zona
      '{"type":"Point","coordinates":[-101,91]}', // grados fuera de rango lat
    ];
    for (const h of hostiles) expect(parseGeoJson(h, ANCHOR)).toBeNull();
  });

  test('FC vacía (0 features) ⇒ null', () => {
    expect(parseGeoJson('{"type":"FeatureCollection","features":[]}', ANCHOR)).toBeNull();
  });
});

describe('FR-1 · presupuestos y truncación', () => {
  test('FC > MAX_VERTS ⇒ truncado con nota, nunca hostil', () => {
    const n = MAX_VERTS + 10_000;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const lon = -101.35 + (i % 1000) * 1e-5;
      const lat = 21.0 + Math.floor(i / 1000) * 1e-5;
      pts.push(`[${lon.toFixed(6)},${lat.toFixed(6)}]`);
    }
    const fc = `{"type":"Feature","geometry":{"type":"MultiPoint","coordinates":[${pts.join(',')}]}}`;
    const r = parseGeoJson(fc, ANCHOR);
    expect(r).not.toBeNull();
    expect(r!.geom!.verts.length).toBe(MAX_VERTS * 3);
    expect(r!.meta.truncated).toBeTruthy();
    expect(r!.meta.rows.some((x) => x[0] === 'Recorte')).toBe(true);
  });

  test('texto > MAX_FILE_BYTES ⇒ null (defensa en profundidad)', () => {
    const huge = ' '.repeat(MAX_FILE_BYTES + 1);
    expect(parseGeoJson(huge, ANCHOR)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* FR-4 v1.1 defensiva — GeoJSON properties (route_class/confidence): */
/* primera feature que declara gana; inválidos ⇒ ignorados (= ausente, */
/* defaults v1.0). Emisión v1.0 del consorcio respeta REQ-10.         */
/* ------------------------------------------------------------------ */
describe('FR-4 v1.1 defensiva — GeoJSON properties (route_class/confidence)', () => {
  test('properties del primer feature que declara ⇒ meta + filas de ficha', () => {
    const fc = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { nombre: 'sin attrs' },
          geometry: { type: 'LineString', coordinates: [[-101.35, 21.0], [-101.34, 21.01]] },
        },
        {
          type: 'Feature',
          properties: { route_class: 'emergencia', confianza: 30 },
          geometry: { type: 'LineString', coordinates: [[-101.33, 21.02], [-101.32, 21.03]] },
        },
      ],
    });
    const r = parseGeoJson(fc, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.routeClass).toBe('emergencia');
    expect(r.meta.confidence).toBe(30);
    expect(r.meta.rows).toContainEqual(['D11 clase de ruta', 'emergencia']);
    expect(r.meta.rows).toContainEqual(['D11 confianza', '30%']);
  });

  test('alias rutaClase; confidence inválida ⇒ ignorada; sin attrs ⇒ meta limpio', () => {
    const alias = JSON.stringify({
      type: 'Feature',
      properties: { rutaClase: 'secundaria', confidence: 'alto' },
      geometry: { type: 'LineString', coordinates: [[-101.35, 21.0], [-101.34, 21.01]] },
    });
    const r = parseGeoJson(alias, ANCHOR);
    expect(r?.meta.routeClass).toBe('secundaria');
    expect(r?.meta.confidence).toBeUndefined();
    const limpio = parseGeoJson(GOLDEN_FC, ANCHOR)!;
    expect(limpio.meta.routeClass).toBeUndefined();
    expect(limpio.meta.confidence).toBeUndefined();
  });
});
