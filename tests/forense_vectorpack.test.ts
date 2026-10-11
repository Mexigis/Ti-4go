/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * forense_vectorpack.test.ts — EX-vectorial: canal shapefile (unidad a,
 * directiva checkpoint «Agenda §2 ACEPTADA» ).
 *
 * Contrato probado contra BYTES honestos (fixtures estructuralmente
 * íntegros, helpers_vectorpack.ts — sin mocks):
 *   V1 CLASIFICACIÓN .prj — UTM 14N (EPSG:32614 / TM −99° k0 0.9996) ⇒
 *      'utm14n'; el LCC-2SP ITRF92 REAL de la fuente INEGI (latin-1) ⇒
 *      'unsupported' con el nombre del PROJCS en la etiqueta; GEOGCS
 *      WGS84 ⇒ 'wgs84'; basura ⇒ unsupported.
 *   V2 RUTA FELIZ — ZIP patrón (.shp+.shx+.dbf+.prj+.cpg) ⇒ format
 *      'vectorpack', magicOk, geom no nula, ficha con CRS/Conversión/
 *      BBox/Drape; `.shx` tolerado como sidecar.
 *   V3 VERIFICACIÓN LONGITUD — Σ aristas geom vs Σ atributo en metros
 *      UTM (ANTES de convertir): Δ ≈ 0 con atributo exacto; Δ +25.0 %
 *      con atributo menor; la nota «recorte EX acorta» SOLO con Δ < 0.
 *   V4 CONVERSIÓN FR-1 — los vértices UTM 14N caen en el BBox WGS84
 *      declarado (round-trip del converso Snyder del repo).
 *   V5 RECHAZOS HONESTOS — .prj LCC ⇒ Error con la guía
 *      `make_roads_vectorpack` (jamás reproyección en el navegador);
 *      .prj ausente ⇒ NO es vectorpack y CAE al Mission Pack (mensaje
 *      hostil genérico — el patrón exige prj); SHP/DBF rotos ⇒ Error
 *      «malformado»; 0 vértices ⇒ Error (nada inventado).
 *   V6 DBF — codificación UTF-8 (.cpg) y latin-1 (bytes crudos 0xe9 sin
 *      .cpg); registro borrado (0x2a) contado y omitido; N vacío ⇒ null.
 *   V7 PATRÓN ESTRICTO — entrada extraña ⇒ cae al Mission Pack; shapes
 *      de tipo no soportado ⇒ nota honesta, el resto renderiza.
 *   V8 ANCLAJE — la geometría se ancla a la región activa con la MISMA
 *      convención equirectangular del canal GeoJSON (z NaN ⇒ DRAPE-1);
 *      determinismo byte a byte.
 */

import { describe, expect, test } from 'bun:test';
import { parseFile, type Anchor } from '../src/lib/ingest/parsers';
import { classifyPrj } from '../src/lib/ingest/shapefile';
import { wgs84ToUtm14n, utm14nToWgs84 } from '../src/lib/ingest/geojson';
import {
  buildVectorpackZip,
  buildShp,
  buildDbf,
  buildZip,
  catBytes,
  i32be,
  i32le,
  CAMPOS_INEGI,
  P0,
  PRJ_UTM14N,
  PRJ_LCC_INEGI_LATIN1,
  PRJ_WGS84,
} from './helpers_vectorpack';

const ANCHOR: Anchor = {
  extentM: 6400,
  zMinM: 2025,
  zMaxM: 2564,
  centerLat: 21.0518,
  centerLon: -101.3248,
  regionName: 'La Soledad',
};

function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function rowOf(meta: { rows: Array<[string, string]> }, k: string): string {
  return meta.rows.find((x) => x[0] === k)?.[1] ?? '';
}

/* ------------------------------------------------------------------ */
/* V1 — clasificación .prj                                             */
/* ------------------------------------------------------------------ */

describe('V1 — classifyPrj (WKT por palabras clave, determinista)', () => {
  test('EPSG:32614 (UTM zone 14N) ⇒ utm14n', () => {
    const r = classifyPrj(PRJ_UTM14N);
    expect(r.crs).toBe('utm14n');
    expect(r.label).toContain('EPSG:32614');
  });

  test('LCC-2SP ITRF92 REAL de la fuente INEGI (latin-1) ⇒ unsupported con nombre', () => {
    const r = classifyPrj(PRJ_LCC_INEGI_LATIN1);
    expect(r.crs).toBe('unsupported');
    expect(r.label).toContain('M\xe9xico_ITRF92_CCL');
  });

  test('TM disfrazado con central_meridian ≠ −99 ⇒ unsupported', () => {
    const tramposo = PRJ_UTM14N.replace('"Central_Meridian",-99.0', '"Central_Meridian",-102.0');
    expect(classifyPrj(tramposo).crs).toBe('unsupported');
  });

  test('GEOGCS WGS84 ⇒ wgs84', () => {
    expect(classifyPrj(PRJ_WGS84).crs).toBe('wgs84');
  });

  test('basura ⇒ unsupported (sin lanzar)', () => {
    expect(classifyPrj('no es wkt').crs).toBe('unsupported');
  });
});

/* ------------------------------------------------------------------ */
/* V2 — ruta feliz                                                     */
/* ------------------------------------------------------------------ */

describe('V2 — ruta feliz: patrón topopack con shapefile UTM 14N', () => {
  test("formato 'vectorpack' + magicOk + ficha completa", () => {
    const r = parseFile('carreteras.zip', ab(buildVectorpackZip()), ANCHOR);
    expect(r.meta.format).toBe('vectorpack');
    expect(r.meta.magicOk).toBe(true);
    expect(r.meta.crs).toContain('EPSG:32614');
    expect(rowOf(r.meta, 'Origen')).toContain('Shapefile ESRI');
    expect(rowOf(r.meta, 'Conversión')).toContain('Snyder FR-1');
    expect(rowOf(r.meta, 'BBox WGS84')).toContain('lon -101.3300');
    expect(rowOf(r.meta, 'Drape')).toContain('DRAPE-1');
    expect(rowOf(r.meta, 'ADMINISTRA')).toBe('ESTATAL×1 · FEDERAL×1');
    expect(rowOf(r.meta, 'TIPOVIA')).toBe('CARRETERA×2');
    expect(r.geom).not.toBeNull();
  });

  test('geom: 4 vértices · 4 aristas (2 por línea) · z NaN (el drape manda)', () => {
    const r = parseFile('carreteras.zip', ab(buildVectorpackZip()), ANCHOR);
    const g = r.geom!;
    expect(g.verts.length).toBe(4 * 3);
    expect(g.segs.length).toBe(4);
    for (let i = 2; i < g.verts.length; i += 3) expect(Number.isNaN(g.verts[i])).toBe(true);
    expect(g.pts.length).toBe(0);
  });

  test('.shx sidecar tolerado y contado en la ficha', () => {
    const r = parseFile('carreteras.zip', ab(buildVectorpackZip({ withShx: true })), ANCHOR);
    expect(rowOf(r.meta, 'Entregable')).toContain('1 sidecar(es)');
  });
});

/* ------------------------------------------------------------------ */
/* V3 — verificación cruzada LONGITUD                                  */
/* ------------------------------------------------------------------ */

describe('V3 — verificación cruzada LONGITUD (metros UTM, antes de convertir)', () => {
  test('Δ +0.0 % con atributo exacto (100 m geom vs 100 m atributo)', () => {
    const r = parseFile(
      'carreteras.zip',
      ab(buildVectorpackZip({ features: [{ pts: [P0, [P0[0] + 100, P0[1]]] }] })),
      ANCHOR
    );
    const row = rowOf(r.meta, 'Verificación LONGITUD');
    expect(row).toContain('0.100 km');
    expect(row).toContain('Δ +0.0 %');
    expect(row).not.toContain('recorte EX acorta');
  });

  test('Δ +25.0 % con atributo menor (500 m geom vs 400 m atributo)', () => {
    const r = parseFile('carreteras.zip', ab(buildVectorpackZip()), ANCHOR);
    const row = rowOf(r.meta, 'Verificación LONGITUD');
    expect(row).toContain('0.500 km');
    expect(row).toContain('0.400 km');
    expect(row).toContain('Δ +25.0 %');
    expect(row).toContain('2 segmentos');
  });

  test('Δ < 0 declara la nota honesta del recorte EX', () => {
    // geom 100 m vs atributo 150 m (segmento fuente completo recortado)
    const r = parseFile(
      'carreteras.zip',
      ab(
        buildVectorpackZip({
          features: [{ pts: [P0, [P0[0] + 100, P0[1]]] }],
          dbfRecords: [{ values: ['N/A', 'CARRETERA', 'EN OPERACION', 'ESTATAL', 2, 150] }],
        })
      ),
      ANCHOR
    );
    const row = rowOf(r.meta, 'Verificación LONGITUD');
    expect(row).toContain('Δ -33.3 %');
    expect(row).toContain('recorte EX acorta');
  });

  test('sin campo LONGITUD ⇒ fila ausente (sin verificación inventada)', () => {
    const fields = CAMPOS_INEGI.filter((f) => f.name !== 'LONGITUD');
    const zip = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      {
        name: 'x.dbf',
        data: buildDbf(fields, [{ values: ['N/A', 'CARRETERA', 'EN OPERACION', 'ESTATAL', 2] }]),
      },
      { name: 'x.shp', data: buildShp([{ pts: [P0, [P0[0] + 100, P0[1]]] }]) },
    ]);
    const r = parseFile('x.zip', ab(zip), ANCHOR);
    expect(r.meta.rows.find((x) => x[0] === 'Verificación LONGITUD')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* V4 — conversión UTM 14N ⇒ WGS84                                     */
/* ------------------------------------------------------------------ */

describe('V4 — conversión UTM 14N ⇒ WGS84 (converso Snyder FR-1)', () => {
  test('los vértices convertidos caen en el BBox geográfico esperado', () => {
    const p = wgs84ToUtm14n(-101.33, 21.05)!;
    const r = parseFile(
      'carreteras.zip',
      ab(buildVectorpackZip({ features: [{ pts: [p, [p[0] + 100, p[1]]] }] })),
      ANCHOR
    );
    const row = rowOf(r.meta, 'BBox WGS84');
    expect(row).toContain('-101.3300');
    expect(row).toContain('21.0500');
    const back = utm14nToWgs84(p[0], p[1])!;
    expect(Math.abs(back[0] - -101.33)).toBeLessThan(1e-6);
    expect(Math.abs(back[1] - 21.05)).toBeLessThan(1e-6);
  });

  test('vértice fuera de zona 14N ⇒ rechazo honesto', () => {
    const fuera = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      { name: 'x.dbf', data: buildDbf(CAMPOS_INEGI, [{ values: ['N/A', 'C', 'OP', 'EST', 2, 100] }]) },
      { name: 'x.shp', data: buildShp([{ pts: [[100_000, 100_000], [100_100, 100_000]] }]) },
    ]);
    expect(() => parseFile('x.zip', ab(fuera), ANCHOR)).toThrow(/fuera de la zona 14N/);
  });
});

/* ------------------------------------------------------------------ */
/* V5 — rechazos honestos                                              */
/* ------------------------------------------------------------------ */

describe('V5 — rechazos honestos (nada disfrazado)', () => {
  test('.prj LCC (fuente INEGI cruda) ⇒ Error con la guía EX-vectorial', () => {
    expect(() =>
      parseFile('carreteras.zip', ab(buildVectorpackZip({ prj: PRJ_LCC_INEGI_LATIN1 })), ANCHOR)
    ).toThrow(/make_roads_vectorpack/);
  });

  test('.prj ausente ⇒ NO es vectorpack: cae al Mission Pack (patrón exige prj)', () => {
    expect(() =>
      parseFile('carreteras.zip', ab(buildVectorpackZip({ omit: ['prj'] })), ANCHOR)
    ).toThrow(/Mission Pack hostil/);
  });

  test('SHP roto (patrón presente, binario ilegible) ⇒ Error «malformado»', () => {
    const zip = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      { name: 'x.dbf', data: buildDbf(CAMPOS_INEGI, [{ values: ['N/A', 'C', 'OP', 'EST', 2, 100] }]) },
      { name: 'x.shp', data: new Uint8Array(64) }, // < 100 B de cabecera
    ]);
    expect(() => parseFile('x.zip', ab(zip), ANCHOR)).toThrow(/malformado/);
  });

  test('DBF incoherente (recordLen ≠ Σ campos+1) ⇒ Error «malformado»', () => {
    const dbf = buildDbf(CAMPOS_INEGI, [{ values: ['N/A', 'C', 'OP', 'EST', 2, 100] }]);
    // Corrompe recordLen (offset 10, uint16 LE) a un valor imposible
    dbf[10] = 0xff;
    dbf[11] = 0xff;
    const zip = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      { name: 'x.dbf', data: dbf },
      { name: 'x.shp', data: buildShp([{ pts: [P0, [P0[0] + 100, P0[1]]] }]) },
    ]);
    expect(() => parseFile('x.zip', ab(zip), ANCHOR)).toThrow(/malformado/);
  });

  test('entrada extraña (manifest.json) ⇒ NO es vectorpack ⇒ Mission Pack', () => {
    expect(() =>
      parseFile(
        'carreteras.zip',
        ab(
          buildVectorpackZip({
            extraEntries: [{ name: 'manifest.json', data: new TextEncoder().encode('{}') }],
          })
        ),
        ANCHOR
      )
    ).toThrow(/Mission Pack hostil/);
  });

  test('shapefile sin vértices ⇒ Error (nada inventado)', () => {
    const zip = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      { name: 'x.dbf', data: buildDbf(CAMPOS_INEGI, []) },
      { name: 'x.shp', data: buildShp([]) },
    ]);
    expect(() => parseFile('x.zip', ab(zip), ANCHOR)).toThrow(/sin vértices/);
  });
});

/* ------------------------------------------------------------------ */
/* V6 — DBF: codificación + registros borrados                         */
/* ------------------------------------------------------------------ */

describe('V6 — DBF: UTF-8 (.cpg), latin-1 (sin .cpg) y borrados (0x2a)', () => {
  test('latin-1 sin .cpg: bytes crudos 0xe9 ⇒ «México» determinista', () => {
    // Celda ADMINISTRA = "México" en latin-1 (0xe9), sin .cpg — el parser
    // decodifica latin-1 manual y el recuento del atributo lo demuestra.
    const mexicoLatin1 = new Uint8Array([0x4d, 0xe9, 0x78, 0x69, 0x63, 0x6f]);
    const zip = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      {
        name: 'x.dbf',
        data: buildDbf([{ name: 'ADMINISTRA', type: 'C', len: 8 }], [{ values: [mexicoLatin1] }]),
      },
      { name: 'x.shp', data: buildShp([{ pts: [P0, [P0[0] + 100, P0[1]]] }]) },
    ]);
    const r = parseFile('x.zip', ab(zip), ANCHOR);
    expect(rowOf(r.meta, 'ADMINISTRA')).toBe('México×1');
  });

  test('UTF-8 con .cpg: «México» viaja en 2 bytes y decodifica igual', () => {
    const zip = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      { name: 'x.cpg', data: new TextEncoder().encode('UTF-8') },
      {
        name: 'x.dbf',
        data: buildDbf([{ name: 'ADMINISTRA', type: 'C', len: 8 }], [{ values: ['México'] }]),
      },
      { name: 'x.shp', data: buildShp([{ pts: [P0, [P0[0] + 100, P0[1]]] }]) },
    ]);
    const r = parseFile('x.zip', ab(zip), ANCHOR);
    expect(rowOf(r.meta, 'ADMINISTRA')).toBe('México×1');
  });

  test('registro borrado: contado (+1 borrados, omitidos) y fuera de los recuentos', () => {
    const r = parseFile(
      'carreteras.zip',
      ab(
        buildVectorpackZip({
          dbfDeleted: [{ values: ['N/A', 'CAMINO', 'CERRADA', 'MUNICIPAL', 1, 999] }],
        })
      ),
      ANCHOR
    );
    expect(rowOf(r.meta, 'Registros DBF')).toContain('+1 borrados, omitidos');
    expect(rowOf(r.meta, 'TIPOVIA')).toBe('CARRETERA×2'); // CAMINO borrado NO cuenta
  });

  test('N vacío ⇒ null (sin inventar cero): LONGITUD sigue sumando', () => {
    const r = parseFile(
      'carreteras.zip',
      ab(
        buildVectorpackZip({
          dbfRecords: [
            { values: ['N/A', 'CARRETERA', 'EN OPERACION', 'ESTATAL', null, 100] },
            { values: ['N/A', 'CARRETERA', 'EN OPERACION', 'FEDERAL', null, 400] },
          ],
          features: [
            { pts: [P0, [P0[0] + 100, P0[1]]] },
            { pts: [[P0[0], P0[1] + 50], [P0[0] + 400, P0[1] + 50]] },
          ],
        })
      ),
      ANCHOR
    );
    const row = rowOf(r.meta, 'Verificación LONGITUD');
    expect(row).toContain('0.500 km'); // Σ geom = Σ atributo = 500 m
    expect(row).toContain('Δ +0.0 %');
  });
});

/* ------------------------------------------------------------------ */
/* V7/V8 — patrón estricto, presupuesto y anclaje escénico             */
/* ------------------------------------------------------------------ */

describe('V7/V8 — patrón estricto, presupuesto y anclaje', () => {
  test('shapes de tipo no soportado: contados como nota, el resto renderiza', () => {
    // Record tipo 7 (no soportado) pegado tras el válido — el parser lo
    // cuenta y omite SIN morir (nota honesta en la ficha).
    const shp = buildShp([{ pts: [P0, [P0[0] + 100, P0[1]]] }]);
    const contenido = catBytes([i32le(7), new Uint8Array(8)]); // tipo + relleno
    const shpConFantasma = catBytes([shp, i32be(2), i32be(contenido.length / 2), contenido]);
    const zip = buildZip([
      { name: 'x.prj', data: new TextEncoder().encode(PRJ_UTM14N) },
      { name: 'x.dbf', data: buildDbf(CAMPOS_INEGI, [{ values: ['N/A', 'C', 'OP', 'EST', 2, 100] }]) },
      { name: 'x.shp', data: shpConFantasma },
    ]);
    const r = parseFile('x.zip', ab(zip), ANCHOR);
    expect(r.meta.format).toBe('vectorpack');
    expect(rowOf(r.meta, 'Nota')).toContain('1 shape(s) de tipo no soportado omitidos');
    expect(rowOf(r.meta, 'Aristas')).toBe('1'); // solo el PolyLine válido
  });

  test('anclaje escénico: vértices dentro del extent ⇒ sin re-encuadre (región activa)', () => {
    const p = wgs84ToUtm14n(ANCHOR.centerLon, ANCHOR.centerLat)!;
    const r = parseFile(
      'carreteras.zip',
      ab(buildVectorpackZip({ features: [{ pts: [p, [p[0] + 50, p[1]]] }] })),
      ANCHOR
    );
    expect(rowOf(r.meta, 'Anclado a')).toBe('La Soledad'); // sin «(encuadrado)»
  });

  test('geometría fuera del extent ⇒ fallback de encuadre honesto («(encuadrado)»)', () => {
    const p = wgs84ToUtm14n(-99.0, 21.05)!; // ~230 km al este: fuera del extent
    const r = parseFile(
      'carreteras.zip',
      ab(buildVectorpackZip({ features: [{ pts: [p, [p[0] + 50, p[1]]] }] })),
      ANCHOR
    );
    expect(rowOf(r.meta, 'Anclado a')).toContain('(encuadrado)');
  });

  test('determinismo: mismo ZIP + misma región ⇒ ficha byte a byte', () => {
    const zip = buildVectorpackZip();
    const a = parseFile('carreteras.zip', ab(zip), ANCHOR);
    const b = parseFile('carreteras.zip', ab(zip), ANCHOR);
    expect(JSON.stringify(a.meta.rows)).toBe(JSON.stringify(b.meta.rows));
    expect(Buffer.from(a.geom!.verts.buffer).equals(Buffer.from(b.geom!.verts.buffer))).toBe(true);
  });
});
