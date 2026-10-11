/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-2 — Parser KML 2.2 XXE-safe + identidad canónica +
 * cruce par-a-par por UUID (agenda FR 1.0, orden fijo del propietario,
 * checkpoint de ingeniería; re-landing por rollback #2, entrada §9 PREVIA
 * 2026-09-27, ).
 *
 * Fija con aserciones el contrato del FR-2:
 *   - Golden: Placemarks con Point/LineString/Polygon/MultiGeometry,
 *     carpetas anidadas, namespaces, CDATA, ExtendedData (uuid/layerType),
 *     atributo id, BOM, determinismo byte-exacto.
 *   - XXE-SAFE: batería de hostilidad DTD/entidades — DOCTYPE con entidad
 *     interna (billion laughs), entidad externa SYSTEM file/http, DTD en
 *     subconjunto interno, ENTITY/ATTLIST/ELEMENT/NOTATION sueltos,
 *     entidad indefinida. SIN DTD no existe expansión: el rechazo es en
 *     la raíz.
 *   - HOSTILES ⇒ null: XML fracturado (etiqueta sin cerrar/desbalanceada,
 *     atributo duplicado/sin comillas), coordenadas con aridad ≠ 2–3,
 *     no finitas (1e400), fuera de rango geográfico, anillos abiertos o
 *     degenerados, Polygon sin outerBoundaryIs, geometría no soportada
 *     (Track/Model), profundidad extrema.
 *   - Identidad + cruce (identity.ts): MATCH (cuantización 1e-6°),
 *     CODIFICACION_DISTINTA (banda 2 m — pase con nota), DIVERGE (fallo),
 *     SIN_PAR (sin UUID). Triángulo A↔B↔K completo.
 *   - Presupuestos: truncación honesta a MAX_VERTS.
 *
 * NOTA de timeout (registro del checkpoint, nota MAX_VERTS): el valor del
 * timeout del test de presupuesto MAX_VERTS queda fijado en el propio test
 * (ver constante TIMEOUT_BUDGET_MS más abajo).
 *
 * Ledger de auditoría: tests/expects verificados contra la salida de bun
 * (aserciones incondicionales; sin ramas condicionales que alteren el conteo).
 */
import { describe, expect, test } from 'bun:test';
import { parseKml, parseKmlIdentity, MAX_ELEMENTS, MAX_DEPTH } from '../src/lib/ingest/kml';
import {
  normalizeUuid,
  quantizeBBox,
  crossPair,
  crossTriangle,
  QUANT_DEG,
  BANDA_CODIFICACION_M,
  type IdentityFeature,
} from '../src/lib/ingest/identity';
import { detectFormat, parseFile, MAX_VERTS, type Anchor } from '../src/lib/ingest/parsers';

const ANCHOR: Anchor = {
  extentM: 8000,
  zMinM: 1950,
  zMaxM: 2600,
  centerLat: 21.0,
  centerLon: -101.33,
  regionName: 'prueba-fr2',
};

/** Valor de timeout del test de presupuesto — REGISTRADO en el test por
 *  nota del checkpoint (hallazgo F-2/nota MAX_VERTS, ). */
const TIMEOUT_BUDGET_MS = 10_000;

/* ------------------------------------------------------------------ */
/* Golden fixtures                                                    */
/* ------------------------------------------------------------------ */

const GOLDEN_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" version="2.2">
  <Document>
    <name>Misión sintética Soledad</name>
    <Placemark id="{A0B1C2D3-1111-4222-8333-444455556666}">
      <name>Arroyo principal</name>
      <LineString>
        <coordinates>-101.35,21.00,2050 -101.34,21.01,2060 -101.33,21.02,2070</coordinates>
      </LineString>
    </Placemark>
    <Placemark id="b1b2c3d4-2222-4333-8444-555566667777">
      <name>Cerro testigo</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing><coordinates>-101.32,21.00 -101.31,21.00 -101.31,21.01 -101.32,21.01 -101.32,21.00</coordinates></LinearRing>
        </outerBoundaryIs>
        <innerBoundaryIs>
          <LinearRing><coordinates>-101.318,21.002 -101.315,21.002 -101.315,21.006 -101.318,21.006 -101.318,21.002</coordinates></LinearRing>
        </innerBoundaryIs>
      </Polygon>
    </Placemark>
    <Folder>
      <name>Subcarpeta</name>
      <Placemark>
        <name>Punto de control</name>
        <ExtendedData>
          <Data name="uuid"><value>c0d1e2f3-3333-4444-8555-666677778888</value></Data>
          <Data name="layerType"><value>ruta</value></Data>
        </ExtendedData>
        <Point><coordinates>-101.34,21.005,2055</coordinates></Point>
      </Placemark>
      <Placemark>
        <name>Ruta múltiple</name>
        <MultiGeometry>
          <LineString><coordinates>-101.30,21.00 -101.30,21.01</coordinates></LineString>
          <LineString><coordinates>-101.29,21.00 -101.29,21.01</coordinates></LineString>
        </MultiGeometry>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

const CDATA_KML = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark id="11111111-aaaa-4bbb-8ccc-dddddddddddd">
      <name><![CDATA[Tramo <norte> & "cajete"]]></name>
      <description><![CDATA[Nota con <etiquetas> y & símbolos]]></description>
      <LineString><coordinates>-101.35,21.00 -101.34,21.01</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;

const NS_KML = `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:atom="http://www.w3.org/2005/Atom">
  <Document>
    <atom:author><atom:name>Equipo</atom:name></atom:author>
    <Placemark id="22222222-aaaa-4bbb-8ccc-dddddddddddd">
      <gx:TimeSpan><gx:begin>2026</gx:begin></gx:TimeSpan>
      <LineString><coordinates>-101.35,21.00 -101.34,21.01</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;

const docKml = (placemarkInner: string, id = '99999999-aaaa-4bbb-8ccc-dddddddddddd'): string =>
  `<?xml version="1.0"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark id="${id}">${placemarkInner}</Placemark></Document></kml>`;

const LINE_2 = '<LineString><coordinates>-101.35,21.00 -101.34,21.01</coordinates></LineString>';

/* ------------------------------------------------------------------ */
/* Golden                                                             */
/* ------------------------------------------------------------------ */

describe('FR-2 golden', () => {
  test('golden completo: placemarks, geometrías, vértices, BBox', () => {
    const r = parseKml(GOLDEN_KML, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.format).toBe('kml');
    expect(r.meta.label).toBe('KML 2.2');
    expect(r.meta.crs).toBe('WGS84 (KML)');
    const e = r.meta.entities as Record<string, number>;
    expect(e.placemarks).toBe(4);
    expect(e.geometrias).toBe(5); // línea + polígono(1) + punto + 2 líneas del multi
    expect(e.vertices).toBe(3 + 5 + 5 + 1 + 2 + 2); // outer(5) + inner(5)
    expect(e.aristas).toBe(2 + (4 + 4) + 0 + 1 + 1); // punto no genera aristas
    expect(e.puntos).toBe(1);
    const rows = r.meta.rows;
    const bboxRow = rows.find((x) => x[0] === 'BBox WGS84');
    expect(bboxRow).toBeDefined();
    expect(bboxRow?.[1]).toContain('-101.35');
    expect(bboxRow?.[1]).toContain('21.02');
  });

  test('anclaje escénico: la geometría cae en metros locales alrededor del centro', () => {
    const r = parseKml(GOLDEN_KML, ANCHOR)!;
    const v = r.geom!.verts;
    // Primer vértice: -101.35, 21.00 → Δlon=-0.02, Δlat=-0.00 vs centro (-101.33, 21.0)
    const mPerLon = 111320 * Math.cos((21.0 * Math.PI) / 180);
    const ex = (-0.02) * mPerLon;
    expect(Math.abs(v[0] - ex)).toBeLessThan(1e-3);
    expect(Math.abs(v[1] - 0)).toBeLessThan(1e-3);
    // Cota del primer vértice = 2050 (3ª coordenada)
    expect(v[2]).toBe(2050);
  });

  test('determinismo byte-exacto: mismo archivo ⇒ misma geometría', () => {
    const a = parseKml(GOLDEN_KML, ANCHOR)!;
    const b = parseKml(GOLDEN_KML, ANCHOR)!;
    expect(Buffer.from(a.geom!.verts.buffer).equals(Buffer.from(b.geom!.verts.buffer))).toBe(true);
    expect(Buffer.from(a.geom!.segs.buffer).equals(Buffer.from(b.geom!.segs.buffer))).toBe(true);
    expect(a.meta.rows).toEqual(b.meta.rows);
  });

  test('todas las geometrías soportadas: Point/LineString/Polygon/MultiGeometry', () => {
    const feats = parseKmlIdentity(GOLDEN_KML)!;
    expect(feats).not.toBeNull();
    expect(feats.length).toBe(4); // todos los placemarks con geometría producen identidad
    const byUuid = new Map(feats.map((f) => [f.uuid, f]));
    expect(byUuid.get('a0b1c2d3-1111-4222-8333-444455556666')!.kind).toBe('linea');
    expect(byUuid.get('b1b2c3d4-2222-4333-8444-555566667777')!.kind).toBe('poligono');
    expect(byUuid.get('c0d1e2f3-3333-4444-8555-666677778888')!.kind).toBe('punto');
    // Placemark sin id ni ExtendedData ⇒ uuid null (SIN_PAR honesto)
    const sin = feats.filter((f) => f.uuid === null);
    expect(sin.length).toBe(1);
    expect(sin[0].kind).toBe('linea');
  });

  test('UUID con llaves y mayúsculas se normaliza a forma canónica', () => {
    const feats = parseKmlIdentity(GOLDEN_KML)!;
    expect(feats.some((f) => f.uuid === 'a0b1c2d3-1111-4222-8333-444455556666')).toBe(true);
  });

  test('ExtendedData: uuid y layerType llegan a la identidad', () => {
    const feats = parseKmlIdentity(GOLDEN_KML)!;
    const punto = feats.find((f) => f.kind === 'punto')!;
    expect(punto.uuid).toBe('c0d1e2f3-3333-4444-8555-666677778888');
    expect((punto as IdentityFeature & { layerType?: string }).layerType).toBe('ruta');
  });

  test('CDATA: texto crudo con <, > y & se preserva sin interpretar etiquetas', () => {
    const feats = parseKmlIdentity(CDATA_KML)!;
    expect(feats.length).toBe(1);
    expect(feats[0].kind).toBe('linea');
    const r = parseKml(CDATA_KML, ANCHOR)!;
    expect(r.meta.entities!.placemarks).toBe(1);
  });

  test('namespaces: prefijos extraños no rompen; se resuelve por nombre local', () => {
    const r = parseKml(NS_KML, ANCHOR)!;
    expect(r.meta.entities!.placemarks).toBe(1);
    expect(r.meta.entities!.vertices).toBe(2);
  });

  test('BOM UTF-8 tolerado', () => {
    const r = parseKml('\uFEFF' + NS_KML, ANCHOR);
    expect(r).not.toBeNull();
  });

  test('versión no numérica ⇒ hostil; sin versión ⇒ acepta', () => {
    expect(parseKml(NS_KML.replace('<kml ', '<kml version="x.y" '), ANCHOR)).toBeNull();
    const sinVersion = NS_KML.replace(' xmlns', ' version="2.1" xmlns');
    expect(parseKml(sinVersion, ANCHOR)).not.toBeNull();
  });

  test('sin vértices ⇒ null (KML sin placemarks con geometría)', () => {
    const vacio = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>x</name></Document></kml>';
    expect(parseKml(vacio, ANCHOR)).toBeNull();
    const soloPm = docKml('<name>solo nombre</name>');
    expect(parseKml(soloPm, ANCHOR)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* XXE-safe: la batería DTD/entidades                                 */
/* ------------------------------------------------------------------ */

describe('FR-2 XXE-safe', () => {
  test('DOCTYPE con entidad interna (patrón billion laughs) ⇒ null', () => {
    const x = `<?xml version="1.0"?><!DOCTYPE kml [
      <!ENTITY a "AAAAAAAAAA">
      <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
      <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
    ]><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>${LINE_2}</Placemark></Document></kml>`;
    expect(parseKml(x, ANCHOR)).toBeNull();
  });

  test('DOCTYPE con entidad externa SYSTEM file:// ⇒ null', () => {
    const x = `<?xml version="1.0"?><!DOCTYPE kml [
      <!ENTITY xxe SYSTEM "file:///etc/passwd">
    ]><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>&xxe;</name>${LINE_2}</Placemark></Document></kml>`;
    expect(parseKml(x, ANCHOR)).toBeNull();
  });

  test('DOCTYPE con entidad externa SYSTEM http:// ⇒ null', () => {
    const x = `<?xml version="1.0"?><!DOCTYPE kml SYSTEM "http://evil.example/x.dtd"><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>${LINE_2}</Placemark></Document></kml>`;
    expect(parseKml(x, ANCHOR)).toBeNull();
  });

  test('DOCTYPE con PUBLIC ⇒ null', () => {
    const x = `<?xml version="1.0"?><!DOCTYPE kml PUBLIC "-//x//y" "http://evil.example/x.dtd"><kml xmlns="http://www.opengis.net/kml/2.2"></kml>`;
    expect(parseKml(x, ANCHOR)).toBeNull();
  });

  test('ENTITY suelto sin DOCTYPE ⇒ null', () => {
    const x = `<kml xmlns="http://www.opengis.net/kml/2.2"><!ENTITY a "x"><Document><Placemark>${LINE_2}</Placemark></Document></kml>`;
    expect(parseKml(x, ANCHOR)).toBeNull();
  });

  test('DOCTYPE con <!ATTLIST ⇒ null', () => {
    expect(parseKml('<!ATTLIST kml v CDATA #IMPLIED><kml></kml>', ANCHOR)).toBeNull();
  });

  test('DOCTYPE con <!ELEMENT ⇒ null', () => {
    expect(parseKml('<!ELEMENT kml ANY><kml></kml>', ANCHOR)).toBeNull();
  });

  test('DOCTYPE con <!NOTATION ⇒ null', () => {
    expect(parseKml('<!NOTATION png SYSTEM "image/png"><kml></kml>', ANCHOR)).toBeNull();
  });

  test('entidad indefinida en texto ⇒ null', () => {
    const x = docKml('<name>&miEntidad;</name>' + LINE_2);
    expect(parseKml(x, ANCHOR)).toBeNull();
  });

  test('entidad indefinida en atributo ⇒ null', () => {
    const x = docKml(LINE_2, '&indefinida;');
    expect(parseKml(x, ANCHOR)).toBeNull();
  });

  test('& sin cierre ⇒ null', () => {
    expect(parseKml(docKml('<name>a & b</name>' + LINE_2), ANCHOR)).toBeNull();
  });

  test('las 5 entidades predefinidas SÍ se resuelven', () => {
    const x = docKml('<name>&lt;uno&gt; &amp; &quot;dos&quot; &apos;tres&apos;</name>' + LINE_2);
    const r = parseKml(x, ANCHOR);
    expect(r).not.toBeNull();
  });

  test('referencias numéricas decimales y hexadecimales válidas se resuelven', () => {
    expect(parseKml(docKml('<name>v&#233;rtice</name>' + LINE_2), ANCHOR)).not.toBeNull();
    expect(parseKml(docKml('<name>v&#xE9;rtice</name>' + LINE_2), ANCHOR)).not.toBeNull();
  });

  test('referencia numérica fuera de rango (>&#x110000;) ⇒ null', () => {
    expect(parseKml(docKml('<name>&#x110000;</name>' + LINE_2), ANCHOR)).toBeNull();
    expect(parseKml(docKml('<name>&#99999999999;</name>' + LINE_2), ANCHOR)).toBeNull();
  });

  test('referencia numérica con control XML prohibido (>&#1;) ⇒ null', () => {
    expect(parseKml(docKml('<name>&#1;</name>' + LINE_2), ANCHOR)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Hostiles estructurales y de coordenadas                            */
/* ------------------------------------------------------------------ */

describe('FR-2 hostiles ⇒ null', () => {
  test('etiqueta sin cerrar', () => {
    expect(parseKml('<kml xmlns="u"><Document><Placemark>' + LINE_2, ANCHOR)).toBeNull();
  });
  test('etiqueta desbalanceada', () => {
    expect(
      parseKml('<kml><Document></Other><Placemark>' + LINE_2 + '</Placemark></Document></kml>', ANCHOR)
    ).toBeNull();
  });
  test('raíz no kml', () => {
    expect(parseKml('<gpx><trk></trk></gpx>', ANCHOR)).toBeNull();
  });
  test('sin raíz (solo texto)', () => {
    expect(parseKml('solo texto suelto', ANCHOR)).toBeNull();
  });
  test('atributo duplicado', () => {
    expect(parseKml('<kml a="1" a="2"><Document/></kml>', ANCHOR)).toBeNull();
  });
  test('atributo sin comillas', () => {
    expect(parseKml('<kml a=1><Document/></kml>', ANCHOR)).toBeNull();
  });
  test('comentario sin cerrar', () => {
    expect(parseKml('<kml><!-- sin cerrar', ANCHOR)).toBeNull();
  });
  test('CDATA sin cerrar', () => {
    expect(parseKml('<kml><name><![CDATA[abierto</name></kml>', ANCHOR)).toBeNull();
  });
  test('declaración XML sin cerrar', () => {
    expect(parseKml('<?xml version="1.0"><kml></kml>', ANCHOR)).toBeNull();
  });
  test('otras declaraciones <!… desconocidas ⇒ null', () => {
    expect(parseKml('<!foo><kml></kml>', ANCHOR)).toBeNull();
  });
  test('coordenadas: aridad 1 y 4 ⇒ null', () => {
    expect(parseKml(docKml('<LineString><coordinates>-101.35 -101.34</coordinates></LineString>'), ANCHOR)).toBeNull();
    expect(
      parseKml(docKml('<LineString><coordinates>-101.35,21,2050,9 -101.34,21,2060,9</coordinates></LineString>'), ANCHOR)
    ).toBeNull();
  });
  test('coordenadas: no numéricas ⇒ null', () => {
    expect(parseKml(docKml('<LineString><coordinates>oeste,norte este,norte</coordinates></LineString>'), ANCHOR)).toBeNull();
  });
  test('coordenadas: 1e400 ⇒ Infinity ⇒ null (no finito)', () => {
    expect(parseKml(docKml('<LineString><coordinates>-101.35,21.00 1e400,21.01</coordinates></LineString>'), ANCHOR)).toBeNull();
  });
  test('coordenadas: fuera de rango geográfico ⇒ null', () => {
    expect(parseKml(docKml('<LineString><coordinates>-999,21.00 -101.34,21.01</coordinates></LineString>'), ANCHOR)).toBeNull();
    expect(parseKml(docKml('<LineString><coordinates>-101.35,95.00 -101.34,21.01</coordinates></LineString>'), ANCHOR)).toBeNull();
  });
  test('coordinates vacío ⇒ null', () => {
    expect(parseKml(docKml('<LineString><coordinates>   </coordinates></LineString>'), ANCHOR)).toBeNull();
  });
  test('LineString degenerado (1 tupla) ⇒ null', () => {
    expect(parseKml(docKml('<LineString><coordinates>-101.35,21.00</coordinates></LineString>'), ANCHOR)).toBeNull();
  });
  test('LineString sin coordinates ⇒ null', () => {
    expect(parseKml(docKml('<LineString></LineString>'), ANCHOR)).toBeNull();
  });
  test('Point con 0 o 2 tuplas ⇒ null', () => {
    expect(parseKml(docKml('<Point><coordinates></coordinates></Point>'), ANCHOR)).toBeNull();
    expect(parseKml(docKml('<Point><coordinates>-101.35,21.00 -101.34,21.01</coordinates></Point>'), ANCHOR)).toBeNull();
  });
  test('anillo abierto ⇒ null', () => {
    const open =
      '<Polygon><outerBoundaryIs><LinearRing><coordinates>-101.32,21.00 -101.31,21.00 -101.31,21.01 -101.32,21.01</coordinates></LinearRing></outerBoundaryIs></Polygon>';
    expect(parseKml(docKml(open), ANCHOR)).toBeNull();
  });
  test('anillo degenerado (<4 tuplas) ⇒ null', () => {
    const deg =
      '<Polygon><outerBoundaryIs><LinearRing><coordinates>-101.32,21.00 -101.32,21.00 -101.32,21.00</coordinates></LinearRing></outerBoundaryIs></Polygon>';
    expect(parseKml(docKml(deg), ANCHOR)).toBeNull();
  });
  test('Polygon sin outerBoundaryIs ⇒ null', () => {
    expect(parseKml(docKml('<Polygon><innerBoundaryIs><LinearRing><coordinates>-101.32,21.00 -101.31,21.00 -101.31,21.01 -101.32,21.01 -101.32,21.00</coordinates></LinearRing></innerBoundaryIs></Polygon>'), ANCHOR)).toBeNull();
  });
  test('Polygon con anillo interior abierto ⇒ null', () => {
    const bad =
      '<Polygon><outerBoundaryIs><LinearRing><coordinates>-101.32,21.00 -101.31,21.00 -101.31,21.01 -101.32,21.01 -101.32,21.00</coordinates></LinearRing></outerBoundaryIs>' +
      '<innerBoundaryIs><LinearRing><coordinates>-101.318,21.002 -101.315,21.002 -101.315,21.006</coordinates></LinearRing></innerBoundaryIs></Polygon>';
    expect(parseKml(docKml(bad), ANCHOR)).toBeNull();
  });
  test('geometría no soportada: Track/Model/MultiTrack ⇒ null (rechazo honesto)', () => {
    expect(parseKml(docKml('<Track><coordinates>-101.35,21.00</coordinates></Track>'), ANCHOR)).toBeNull();
    expect(parseKml(docKml('<Model><Location><longitude>-101</longitude></Location></Model>'), ANCHOR)).toBeNull();
    expect(parseKml(docKml('<MultiTrack><Track></Track></MultiTrack>'), ANCHOR)).toBeNull();
    expect(parseKml(docKml('<MultiPolygon><Polygon></Polygon></MultiPolygon>'), ANCHOR)).toBeNull();
  });
  test('profundidad extrema ⇒ null (presupuesto MAX_DEPTH)', () => {
    let deep = '<kml>';
    for (let i = 0; i < MAX_DEPTH + 8; i++) deep += '<f>';
    deep += LINE_2;
    expect(parseKml(deep, ANCHOR)).toBeNull();
  });
  test('nombre de etiqueta vacío/malformado ⇒ null', () => {
    expect(parseKml('<kml><1mal/></kml>', ANCHOR)).toBeNull();
    expect(parseKml('<kml><a b></a></kml>', ANCHOR)).toBeNull();
  });
  test('archivo vacío ⇒ null', () => {
    expect(parseKml('', ANCHOR)).toBeNull();
    expect(parseKml('   \n  ', ANCHOR)).toBeNull();
  });
  test('extensión/firma: XML sin extensión se detecta como kml', () => {
    expect(detectFormat('sinextension', new TextEncoder().encode(NS_KML))).toBe('kml');
    expect(detectFormat('rutas.kml', new TextEncoder().encode(NS_KML))).toBe('kml');
  });
  test('parseFile: rechazo limpio con Error legible (sin null colado)', () => {
    let msg = '';
    try {
      parseFile('malo.kml', new TextEncoder().encode('<!DOCTYPE kml><kml/>').buffer as ArrayBuffer, ANCHOR);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('KML hostil');
  });
});

/* ------------------------------------------------------------------ */
/* Identidad canónica y cruce                                         */
/* ------------------------------------------------------------------ */

const FEAT_A: IdentityFeature = {
  uuid: '11111111-2222-4333-8444-555566667777',
  name: 'arroyo',
  source: 'A',
  kind: 'linea',
  bbox: { lonMin: -101.35, lonMax: -101.33, latMin: 21.0, latMax: 21.02 },
  vertexCount: 3,
};
const FEAT_B_IGUAL = { ...FEAT_A, source: 'B' as const, name: 'arroyo (B)' };
const FEAT_K_IGUAL = { ...FEAT_A, source: 'K' as const, name: 'arroyo (K)' };
const FEAT_K_CODIF: IdentityFeature = {
  ...FEAT_A,
  source: 'K',
  bbox: { lonMin: -101.3500012, lonMax: -101.3299988, latMin: 21.0000009, latMax: 21.0199991 },
};
const FEAT_DIVERGE: IdentityFeature = {
  ...FEAT_A,
  source: 'K',
  bbox: { lonMin: -101.36, lonMax: -101.32, latMin: 21.0, latMax: 21.05 },
};

describe('FR-2 identidad + cruce', () => {
  test('normalizeUuid: canónica, llaves, urn, mayúsculas; inválidos ⇒ null', () => {
    expect(normalizeUuid('11111111-2222-4333-8444-555566667777')).toBe('11111111-2222-4333-8444-555566667777');
    expect(normalizeUuid('{11111111-2222-4333-8444-555566667777}')).toBe('11111111-2222-4333-8444-555566667777');
    expect(normalizeUuid('urn:uuid:11111111-2222-4333-8444-555566667777')).toBe('11111111-2222-4333-8444-555566667777');
    expect(normalizeUuid('1111111122224333844455556666 7777'.replace(' ', ''))).toBeNull();
    expect(normalizeUuid('no-es-uuid')).toBeNull();
    expect(normalizeUuid(42)).toBeNull();
    expect(normalizeUuid(null)).toBeNull();
  });

  test('quantizeBBox: rejilla 1e-6°, determinista', () => {
    expect(QUANT_DEG).toBe(1e-6);
    const q = quantizeBBox({ lonMin: -101.350000049, lonMax: 5.000000051e1, latMin: 21.00000004, latMax: 21.00000006 });
    expect(q.lonMin).toBeCloseTo(-101.35, 10);
    expect(q.latMin).toBe(q.latMax);
  });

  test('MATCH: BBox cuantizado idéntico, nota vacía', () => {
    const p = crossPair(FEAT_A, FEAT_B_IGUAL);
    expect(p.verdict).toBe('MATCH');
    expect(p.note).toBe('');
    expect(p.uuid as string).toBe(FEAT_A.uuid as string);
  });

  test('CODIFICACION_DISTINTA: dentro de la banda de 2 m ⇒ pase con nota', () => {
    expect(BANDA_CODIFICACION_M).toBe(2.0);
    const p = crossPair(FEAT_A, FEAT_K_CODIF);
    expect(p.verdict).toBe('CODIFICACION_DISTINTA');
    expect(p.note).toContain('Pase con nota');
    expect(p.maxDeltaM).toBeGreaterThan(0);
    expect(p.maxDeltaM).toBeLessThanOrEqual(BANDA_CODIFICACION_M);
  });

  test('DIVERGE: fuera de banda ⇒ fallo con nota cuantificada', () => {
    const p = crossPair(FEAT_A, FEAT_DIVERGE);
    expect(p.verdict).toBe('DIVERGE');
    expect(p.note).toContain('fuera de la banda');
    expect(p.maxDeltaM).toBeGreaterThan(BANDA_CODIFICACION_M);
  });

  test('DIVERGE por semántica: punto vs línea con el mismo UUID', () => {
    const p = crossPair(FEAT_A, { ...FEAT_A, source: 'K', kind: 'punto' });
    expect(p.verdict).toBe('DIVERGE');
    expect(p.note).toContain('Semántica');
  });

  test('SIN_PAR: UUID ausente en una cara', () => {
    const p = crossPair({ ...FEAT_A, uuid: null }, FEAT_B_IGUAL);
    expect(p.verdict).toBe('SIN_PAR');
    expect(p.note).toContain('UUID ausente');
  });

  test('triángulo completo: 3 MATCH ⇒ ok', () => {
    const t = crossTriangle([FEAT_A], [FEAT_B_IGUAL], [FEAT_K_IGUAL]);
    expect(t.ok).toBe(true);
    expect(t.pares.length).toBe(3);
    expect(t.conteo.MATCH).toBe(3);
    expect(t.conteo.DIVERGE).toBe(0);
  });

  test('triángulo con un DIVERGE en un solo par ⇒ ok=false', () => {
    const t = crossTriangle([FEAT_A], [FEAT_B_IGUAL], [FEAT_DIVERGE]);
    expect(t.ok).toBe(false);
    expect(t.conteo.DIVERGE).toBe(2); // A↔K y B↔K divergen
  });

  test('triángulo con features sin UUID ⇒ SIN_PAR, ok=true', () => {
    const t = crossTriangle([{ ...FEAT_A, uuid: null }], [FEAT_B_IGUAL], []);
    expect(t.ok).toBe(true);
    expect(t.conteo.SIN_PAR).toBeGreaterThanOrEqual(1);
  });

  test('triángulo vacío ⇒ ok=true con 0 pares', () => {
    const t = crossTriangle([], [], []);
    expect(t.ok).toBe(true);
    expect(t.pares.length).toBe(0);
  });

  test('cruce con KML real + GeoJSON real: MATCH por UUID', () => {
    const kmlFeats = parseKmlIdentity(GOLDEN_KML)!;
    const arroyoK = kmlFeats.find((f) => f.uuid === 'a0b1c2d3-1111-4222-8333-444455556666')!;
    const geoFeats: IdentityFeature[] = [
      {
        uuid: 'a0b1c2d3-1111-4222-8333-444455556666',
        name: 'Arroyo principal',
        source: 'A',
        kind: 'linea',
        bbox: arroyoK.bbox,
        vertexCount: 3,
      },
    ];
    const p = crossPair(geoFeats[0], arroyoK);
    expect(p.verdict).toBe('MATCH');
  });

  test('MAX_ELEMENTS exportado con valor esperado (presupuesto XML visible)', () => {
    expect(MAX_ELEMENTS).toBe(200_000);
    expect(MAX_DEPTH).toBe(64);
  });

  /* ---------------------------------------------------------------- */
  /* UUID dorado y known-answers del linaje aceptado (Task 42)         */
  /* ---------------------------------------------------------------- */

  test('UUID dorado: TODAS las formas sintácticas aceptadas convergen al canónico (vector)', () => {
    const CAN = 'a0b1c2d3-1111-4222-8333-444455556666';
    expect(normalizeUuid(CAN)).toBe(CAN); // plano minúsculas
    expect(normalizeUuid('A0B1C2D3-1111-4222-8333-444455556666')).toBe(CAN); // mayúsculas
    expect(normalizeUuid('A0b1C2d3-1111-4222-8333-444455556666')).toBe(CAN); // caso mixto
    expect(normalizeUuid(`{${CAN.toUpperCase()}}`)).toBe(CAN); // llaves + mayúsculas
    expect(normalizeUuid(`{${CAN}}`)).toBe(CAN); // llaves minúsculas
    expect(normalizeUuid(`urn:uuid:${CAN.toUpperCase()}`)).toBe(CAN); // urn + mayúsculas
    expect(normalizeUuid(`URN:UUID:${CAN}`)).toBe(CAN); // prefijo urn en mayúsculas (se normaliza antes de recortar)
    expect(normalizeUuid(`urn:uuid:{${CAN.toUpperCase()}}`)).toBe(CAN); // urn + llaves combinadas
    expect(normalizeUuid(`  ${CAN}  `)).toBe(CAN); // espacios alrededor (trim)
    expect(normalizeUuid(`\t${CAN}\n`)).toBe(CAN); // tab/salto de línea (trim)
    expect(normalizeUuid(`  {${CAN}}  `)).toBe(CAN); // espacios FUERA de llaves (trim primero)
    // nil UUID: válido por FORMA (la identidad no juzga semántica de versión)
    expect(normalizeUuid('00000000-0000-0000-0000-000000000000')).toBe('00000000-0000-0000-0000-000000000000');
  });

  test('UUID inválidos ⇒ null (SIN_PAR honesto, nunca hostil) — vector', () => {
    expect(normalizeUuid('a0b1c2d3-1111-4222-8333-44445555666')).toBeNull(); // 31 hex
    expect(normalizeUuid('a0b1c2d31111422283334444555566667777')).toBeNull(); // sin guiones
    expect(normalizeUuid('a0b1c2d3_1111-4222-8333-444455556666')).toBeNull(); // guión mal puesto
    expect(normalizeUuid('g0b1c2d3-1111-4222-8333-444455556666')).toBeNull(); // dígito no hex
    expect(normalizeUuid('')).toBeNull(); // vacío
    expect(normalizeUuid(42)).toBeNull(); // número
    expect(normalizeUuid({})).toBeNull(); // objeto
    expect(normalizeUuid(true)).toBeNull(); // booleano
    expect(normalizeUuid(undefined)).toBeNull(); // undefined
    expect(normalizeUuid(`{ a0b1c2d3-1111-4222-8333-444455556666 }`)).toBeNull(); // espacios DENTRO de llaves (tras trim exterior el interior no se toca)
    expect(normalizeUuid('urn:uuid:')).toBeNull(); // solo el prefijo, vacío
  });

  test('SimpleData (SchemaData, KML 2.2 §9.3) aporta uuid en Placemark sin id', () => {
    // SimpleData vive dentro de SchemaData (no suelto en ExtendedData —
    // probado en el test siguiente: suelto se ignora, conforme al spec).
    const x = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>por SimpleData</name><ExtendedData><SchemaData schemaUrl="#s"><SimpleData name="uuid">33333333-3333-4333-8555-666677778888</SimpleData></SchemaData></ExtendedData>${LINE_2}</Placemark></Document></kml>`;
    const feats = parseKmlIdentity(x)!;
    expect({ n: feats.length, uuid: feats[0]?.uuid ?? null, kind: feats[0]?.kind ?? null }).toEqual({
      n: 1,
      uuid: '33333333-3333-4333-8555-666677778888',
      kind: 'linea',
    });
    expect(feats[0].name).toBe('por SimpleData'); // trazabilidad del nombre
  });

  test('SimpleData suelto en ExtendedData (fuera de SchemaData) se ignora — conforme al spec', () => {
    const x = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><ExtendedData><SimpleData name="uuid">33333333-3333-4333-8555-666677778888</SimpleData></ExtendedData>${LINE_2}</Placemark></Document></kml>`;
    const feats = parseKmlIdentity(x)!;
    expect({ n: feats.length, uuid: feats[0]?.uuid ?? null }).toEqual({ n: 1, uuid: null });
  });

  test('ExtendedData Data sin atributo name ⇒ sin uuid (honesto, SIN_PAR)', () => {
    const x = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><ExtendedData><Data><value>x</value></Data></ExtendedData>${LINE_2}</Placemark></Document></kml>`;
    const feats = parseKmlIdentity(x)!;
    expect(feats.length).toBe(1);
    expect(feats[0].uuid).toBeNull();
    expect(feats[0].kind).toBe('linea'); // la geometría sigue siendo válida
  });

  test('layerType known-answer via ExtendedData Data (cauce)', () => {
    const x = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark id="44444444-4444-4444-8444-444444444444"><ExtendedData><Data name="layerType"><value>cauce</value></Data></ExtendedData>${LINE_2}</Placemark></Document></kml>`;
    const feats = parseKmlIdentity(x)!;
    expect({
      uuid: feats[0]?.uuid ?? null,
      layerType: (feats[0] as IdentityFeature & { layerType?: string }).layerType ?? null,
      kind: feats[0]?.kind ?? null,
    }).toEqual({ uuid: '44444444-4444-4444-8444-444444444444', layerType: 'cauce', kind: 'linea' });
  });

  test('layerType desconocido viaja intacto (forward-compat a nivel identidad)', () => {
    const x = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark id="55555555-5555-4555-8555-555555555555"><ExtendedData><Data name="layerType"><value>capa-futura-ignis</value></Data></ExtendedData>${LINE_2}</Placemark></Document></kml>`;
    const feats = parseKmlIdentity(x)!;
    expect(feats.length).toBe(1);
    expect((feats[0] as IdentityFeature & { layerType?: string }).layerType).toBe('capa-futura-ignis');
  });

  test('quantizeBBox known-answer: las 4 esquinas caen en la rejilla 1e-6° (pin numérico)', () => {
    const q = quantizeBBox({ lonMin: -101.3500004, lonMax: -101.3400004, latMin: 21.00000004, latMax: 21.00000006 });
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
    expect([near(q.lonMin, -101.35), near(q.lonMax, -101.34), near(q.latMin, 21.0), near(q.latMax, 21.0)]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // latMin === latMax tras cuantizar (ambos caen en la misma celda)
    expect(q.latMin).toBe(q.latMax);
    // borde exacto .5: Math.round redondea hacia +∞ (pin de decisión)
    const q2 = quantizeBBox({ lonMin: -101.3500005, lonMax: -101.3400005, latMin: 21.0, latMax: 21.0 });
    expect(near(q2.lonMin, -101.35)).toBe(true);
  });

  test('Style/LineStyle del KML se ignoran por contrato (la gramática la fija D11)', () => {
    const x = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Style id="s"><LineStyle><color>ff0000ff</color><width>15</width></LineStyle></Style><Placemark id="66666666-6666-4666-8666-666666666666"><styleUrl>#s</styleUrl>${LINE_2}</Placemark></Document></kml>`;
    const r = parseKml(x, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    const feats = parseKmlIdentity(x)!;
    expect({
      vertices: r.meta.entities!.vertices,
      kind: feats[0]?.kind ?? null,
      uuid: feats[0]?.uuid ?? null,
    }).toEqual({ vertices: 2, kind: 'linea', uuid: '66666666-6666-4666-8666-666666666666' });
    // styleUrl hacia un Style inexistente también es tolerado (lectura por nombre local)
    const r2 = parseKml(x.replace('<Style id="s"><LineStyle><color>ff0000ff</color><width>15</width></LineStyle></Style>', ''), ANCHOR);
    expect(r2 !== null && r2!.meta.entities!.vertices === 2).toBe(true);
  });

  test('crossPair con UUID distintos ⇒ SIN_PAR (el cruce es POR UUID — nota documentada)', () => {
    const p = crossPair(FEAT_A, { ...FEAT_B_IGUAL, uuid: '99999999-9999-4999-8999-999999999999' });
    expect({
      verdict: p.verdict,
      nota: p.note.includes('no coinciden'),
      marca: p.uuid.includes('≠'),
      fuenteA: p.a.source,
    }).toEqual({ verdict: 'SIN_PAR', nota: true, marca: true, fuenteA: 'A' });
  });

  test('triángulo known-answer: conteo completo del golden 3-MATCH (objeto entero)', () => {
    const t = crossTriangle([FEAT_A], [FEAT_B_IGUAL], [FEAT_K_IGUAL]);
    expect(t.conteo).toEqual({ MATCH: 3, CODIFICACION_DISTINTA: 0, DIVERGE: 0, SIN_PAR: 0 });
  });

  test('triángulo known-answer: conteo con par ausente (SIN_PAR por cara)', () => {
    const t = crossTriangle([FEAT_A], [FEAT_B_IGUAL], []);
    expect(t.conteo).toEqual({ MATCH: 1, CODIFICACION_DISTINTA: 0, DIVERGE: 0, SIN_PAR: 2 });
  });

  test('namespace por defecto ausente: se resuelve por nombre local', () => {
    const x = `<?xml version="1.0"?><kml><Document><Placemark>${LINE_2}</Placemark></Document></kml>`;
    const r = parseKml(x, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect({ placemarks: r.meta.entities!.placemarks, vertices: r.meta.entities!.vertices }).toEqual({
      placemarks: 1,
      vertices: 2,
    });
    const feats = parseKmlIdentity(x)!;
    expect(feats[0].uuid).toBeNull(); // sin id ni ExtendedData ⇒ SIN_PAR honesto
  });

  test('BBox WGS84 del golden: identidad canónica known-answer (4 esquinas)', () => {
    const feats = parseKmlIdentity(GOLDEN_KML)!;
    const arroyo = feats.find((f) => f.uuid === 'a0b1c2d3-1111-4222-8333-444455556666')!;
    expect(arroyo.bbox.lonMin).toBe(-101.35);
    expect(arroyo.bbox.lonMax).toBe(-101.33);
    expect(arroyo.bbox.latMin).toBe(21.0);
    expect(arroyo.bbox.latMax).toBe(21.02);
    // el cerro (polígono) cierra su propio BBox known-answer
    const cerro = feats.find((f) => f.uuid === 'b1b2c3d4-2222-4333-8444-555566667777')!;
    expect(cerro.bbox.lonMin).toBe(-101.32);
    expect(cerro.bbox.latMax).toBe(21.01);
  });

  test('versiones menores del KML (2.0/2.1/2.2) aceptadas por el lector tolerante', () => {
    expect({
      v20: parseKml(NS_KML.replace(' xmlns', ' version="2.0" xmlns'), ANCHOR) !== null,
      v21: parseKml(NS_KML.replace(' xmlns', ' version="2.1" xmlns'), ANCHOR) !== null,
      v22: parseKml(NS_KML.replace(' xmlns', ' version="2.2" xmlns'), ANCHOR) !== null,
    }).toEqual({ v20: true, v21: true, v22: true });
  });
});

/* ------------------------------------------------------------------ */
/* Presupuestos                                                       */
/* ------------------------------------------------------------------ */

describe('FR-2 presupuestos', () => {
  test(
    'truncación honesta a MAX_VERTS con nota (anillos que no caben se omiten enteros)',
    () => {
      // Miembro pequeño (cabe) + anillo enorme (no cabe ⇒ se omite ENTERO con nota)
      const tuples: string[] = [];
      const n = MAX_VERTS + 5;
      for (let i = 0; i < n; i++) {
        const lon = -101.35 + (i % 1000) * 1e-6;
        tuples.push(`${lon.toFixed(6)},21.00`);
      }
      tuples.push(tuples[0]); // cerrado
      const big =
        `<Placemark id="00000000-0000-4000-8000-000000000001"><name>chico</name>${LINE_2}</Placemark>` +
        `<Placemark id="00000000-0000-4000-8000-000000000002"><name>enorme</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${tuples.join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
      const r = parseKml(docKml(big), ANCHOR);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.meta.truncated).toBeDefined();
      expect(r.meta.truncated).toContain('anillos');
      // Los vértices que sobreviven son SOLO los del miembro chico (2)
      expect(r.meta.entities!.vertices).toBe(2);
    },
    TIMEOUT_BUDGET_MS
  );

  test('línea larga con recorte parcial y nota honesta', () => {
    const tuples: string[] = [];
    for (let i = 0; i < MAX_VERTS + 10; i++) {
      tuples.push(`-101.3${(i % 10)},21.0${i % 10}`);
    }
    const r = parseKml(docKml(`<LineString><coordinates>${tuples.join(' ')}</coordinates></LineString>`), ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.truncated).toBeDefined();
    expect(r.meta.truncated).toContain('vértices recortados');
    expect(r.meta.entities!.vertices).toBe(MAX_VERTS);
  }, TIMEOUT_BUDGET_MS);
});

/* ------------------------------------------------------------------ */
/* FR-4 v1.1 defensiva — extracción KML de route_class/confidence +   */
/* fallback Placemark (hallazgo del inventario forense FR-4,          */
/* checkpoint ).                                */
/* ------------------------------------------------------------------ */
describe('FR-4 v1.1 defensiva — KML route_class/confidence + fallback Placemark', () => {
  const DOC_LEVEL = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <ExtendedData>
      <Data name="layerType"><value>ruta</value></Data>
      <Data name="route_class"><value>emergencia</value></Data>
      <Data name="confidence"><value>30</value></Data>
    </ExtendedData>
    <Placemark id="a0b1c2d3-1111-4222-8333-444455556666">
      <name>Eje de marcha</name>
      <LineString><coordinates>-101.35,21.00,2050 -101.34,21.01,2060 -101.33,21.02,2070</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;

  test('doc-level: layerType + route_class + confidence llegan al meta y a la ficha', () => {
    const r = parseKml(DOC_LEVEL, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.layerType).toBe('ruta');
    expect(r.meta.routeClass).toBe('emergencia');
    expect(r.meta.confidence).toBe(30);
    expect(r.meta.rows).toContainEqual(['D11 clase de ruta', 'emergencia']);
    expect(r.meta.rows).toContainEqual(['D11 confianza', '30%']);
  });

  test('HALLAZGO corregido: Placemark-level (sin doc-level) cae al meta (fallback determinista)', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark id="a0b1c2d3-1111-4222-8333-444455556666">
      <name>Ruta de ascenso</name>
      <ExtendedData>
        <Data name="layerType"><value>ruta</value></Data>
        <Data name="rutaClase"><value>secundaria</value></Data>
        <Data name="confianza"><value>40</value></Data>
      </ExtendedData>
      <LineString><coordinates>-101.35,21.00,2050 -101.34,21.01,2060 -101.33,21.02,2070</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
    const r = parseKml(kml, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.layerType).toBe('ruta'); // antes del fix: undefined ⇒ vector genérico
    expect(r.meta.routeClass).toBe('secundaria'); // alias ADR rutaClase consumido
    expect(r.meta.confidence).toBe(40); // alias ADR confianza consumido
  });

  test('confidence inválida o fuera de rango ⇒ ignorada (= ausente)', () => {
    for (const v of ['abc', '150', '-5', '']) {
      const kml = DOC_LEVEL.replace('<value>30</value>', `<value>${v}</value>`);
      const r = parseKml(kml, ANCHOR);
      expect(r).not.toBeNull();
      if (!r) return;
      expect(r.meta.confidence).toBeUndefined();
      expect(r.meta.rows.some(([k]) => k === 'D11 confianza')).toBe(false);
    }
  });

  test('mezcla de layerType entre Placemarks ⇒ fila honesta + gana el primero', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark id="a0b1c2d3-1111-4222-8333-444455556666">
      <ExtendedData><Data name="layerType"><value>cauce</value></Data></ExtendedData>
      <LineString><coordinates>-101.35,21.00,2050 -101.34,21.01,2060</coordinates></LineString>
    </Placemark>
    <Placemark id="b1b2c3d4-2222-4333-8444-555566667777">
      <ExtendedData><Data name="layerType"><value>divisoria</value></Data></ExtendedData>
      <LineString><coordinates>-101.33,21.02,2070 -101.32,21.03,2080</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
    const r = parseKml(kml, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.layerType).toBe('cauce'); // primer Placemark en orden de documento
    const mezcla = r.meta.rows.find(([k]) => k === 'D11 mezcla de tipos');
    expect(mezcla).toBeDefined();
    if (mezcla) {
      expect(mezcla[1]).toContain('cauce');
      expect(mezcla[1]).toContain('divisoria');
    }
  });

  test('sin atributos D11 ⇒ meta limpio (sin routeClass/confidence, retrocompat v1.0)', () => {
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark id="a0b1c2d3-1111-4222-8333-444455556666">
      <LineString><coordinates>-101.35,21.00,2050 -101.34,21.01,2060</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
    const r = parseKml(kml, ANCHOR);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.meta.layerType).toBeUndefined();
    expect(r.meta.routeClass).toBeUndefined();
    expect(r.meta.confidence).toBeUndefined();
  });
});
