/**
 * Generador de fixtures sintéticos de QA (FR-W1 — ningún dato de misión
 * real se commitea; todo lo que hay aquí es sintético de principio a fin).
 *
 * FR-2/FR-3/FR-4 QA E2E:
 *   - rutas_sinteticas.kml     → gramática D11 'ruta' (guión-punto + flechas)
 *   - mision_sintetica.zip     → golden pack (A UTM + B grados + KML; cruce MATCH)
 *   - mision_diverge.zip       → pack con DIVERGE (H-4: marcador visible)
 *   - vector_sintetico.geojson → capa 'vector' genérica
 *
 * Uso: bun scripts/gen_qa_fixtures.ts   (idempotente, determinista)
 */
import { deflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { wgs84ToUtm14n } from '../src/lib/ingest/geojson';

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let x = c ^ buf[i];
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    c = x >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

const u16a = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const u32a = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

/** Escritor ZIP mínimo (mismo formato que la suite forense FR-3). */
function buildZip(inputs: Array<{ name: string; data: Uint8Array; method?: 0 | 8 }>): Uint8Array {
  const chunks: number[][] = [];
  const central: number[][] = [];
  for (const inp of inputs) {
    const method = inp.method ?? 0;
    let data = inp.data;
    const crc = crc32(data);
    if (method === 8) data = deflateRawSync(data);
    const localOffset = chunks.reduce((s, c) => s + c.length, 0);
    const nameBytes = Array.from(new TextEncoder().encode(inp.name));
    chunks.push([
      ...u32a(0x04034b50), ...u16a(20), ...u16a(0x800), ...u16a(method),
      ...u16a(0), ...u16a(0), ...u32a(crc),
      ...u32a(data.length), ...u32a(inp.data.length),
      ...u16a(nameBytes.length), ...u16a(0),
      ...nameBytes, ...Array.from(data),
    ]);
    central.push([
      ...u32a(0x02014b50), ...u16a(20), ...u16a(20), ...u16a(0x800), ...u16a(method),
      ...u16a(0), ...u16a(0), ...u32a(crc),
      ...u32a(data.length), ...u32a(inp.data.length),
      ...u16a(nameBytes.length), ...u16a(0), ...u16a(0),
      ...u16a(0), ...u16a(0), ...u32a(0),
      ...u32a(localOffset),
      ...nameBytes,
    ]);
  }
  const localBlob = chunks.flat();
  const cdStart = localBlob.length;
  const cdBlob = central.flat();
  const eocd = [
    ...u32a(0x06054b50), ...u16a(0), ...u16a(0),
    ...u16a(inputs.length), ...u16a(inputs.length),
    ...u32a(cdBlob.length), ...u32a(cdStart), ...u16a(0),
  ];
  return new Uint8Array([...localBlob, ...cdBlob, ...eocd]);
}

/* ------------------------------------------------------------------ */
/* Contenido sintético — Cuenca de la Soledad (región piloto)         */
/* ------------------------------------------------------------------ */

const UUID_ARROYO = 'a0b1c2d3-1111-4222-8333-444455556666';
const UUID_CERRO = 'b1b2c3d4-2222-4333-8444-555566667777';
const UUID_RUTA = 'c0d1e2f3-3333-4444-8555-666677778888';

const LINEA: Array<[number, number]> = [
  [-101.352, 20.995],
  [-101.344, 21.004],
  [-101.335, 21.014],
  [-101.328, 21.021],
];
const RUTA_PTS: Array<[number, number]> = [
  [-101.348, 20.992],
  [-101.341, 21.0],
  [-101.333, 21.006],
  [-101.326, 21.012],
  [-101.319, 21.018],
];
const CERRO: Array<[number, number]> = [
  [-101.322, 21.0],
  [-101.313, 21.0],
  [-101.313, 21.009],
  [-101.322, 21.009],
  [-101.322, 21.0],
];

const degToUtm = (lon: number, lat: number): [number, number] => {
  const c = wgs84ToUtm14n(lon, lat);
  if (!c) throw new Error('fixture fuera de zona 14N');
  return [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100];
};

const A_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { uuid: UUID_ARROYO, nombre: 'Arroyo principal', cota: 2050 },
      geometry: { type: 'LineString', coordinates: LINEA.map(([lon, lat]) => degToUtm(lon, lat)) },
    },
  ],
});

const B_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { uuid: UUID_ARROYO, nombre: 'Arroyo principal (B)' },
      geometry: { type: 'LineString', coordinates: LINEA },
    },
  ],
});

const KML_MIEMBRO = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Miembro KML sintético</name>
    <Placemark id="${UUID_ARROYO}"><name>Arroyo principal (K)</name>
      <LineString><coordinates>${LINEA.map(([a, b]) => `${a},${b},2050`).join(' ')}</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;

const TIFF_STUB = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0]);
const DATUM = new TextEncoder().encode(
  'PROJCS["WGS 84 / UTM zone 14N",GEOGCS["WGS 84",DATUM["WGS_1984"]],PROJECTION["Transverse_Mercator"]]'
);

const makeManifest = (miembros: Array<object>): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      version: '1.0.0',
      mision: 'soledad-sintetica-fr-w1',
      generado: '2026-09-27T00:00:00Z',
      miembros,
    })
  );

/* --- fixtures ------------------------------------------------------- */

const RUTAS_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Rutas sintéticas de brigada (FR-W1)</name>
    <Placemark id="${UUID_RUTA}"><name>Ruta de ascenso</name>
      <ExtendedData><Data name="layerType"><value>ruta</value></Data></ExtendedData>
      <LineString><coordinates>${RUTA_PTS.map(([a, b]) => `${a},${b},2100`).join(' ')}</coordinates></LineString>
    </Placemark>
    <Placemark id="${UUID_CERRO}"><name>Perímetro de interés</name>
      <ExtendedData><Data name="layerType"><value>ruta</value></Data></ExtendedData>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${CERRO.map(([a, b]) => `${a},${b},2080`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
  </Document>
</kml>`;

const VECTOR_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { nombre: 'Línea eléctrica sintética' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-101.34, 20.99],
          [-101.332, 20.998],
          [-101.324, 21.004],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { nombre: 'Punto de muestreo' },
      geometry: { type: 'Point', coordinates: [-101.336, 21.002] },
    },
  ],
});

const GOLDEN_PACK = buildZip([
  { name: 'manifest.json', data: makeManifest([
    { role: 'A', path: 'a.geojson', layerType: 'vector' },
    { role: 'B', path: 'b.geojson' },
    { role: 'KML', path: 'miembro.kml' },
    { role: 'friction.tif', path: 'friction.tif' },
    { role: 'datum', path: 'datum.prj' },
  ]) },
  { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON), method: 8 },
  { name: 'b.geojson', data: new TextEncoder().encode(B_GEOJSON) },
  { name: 'miembro.kml', data: new TextEncoder().encode(KML_MIEMBRO) },
  { name: 'friction.tif', data: TIFF_STUB },
  { name: 'datum.prj', data: DATUM },
]);

// DIVERGE: el B trae el perímetro desplazado ~1.1 km ⇒ cruce DIVERGE con K
const B_DIVERGE = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { uuid: UUID_ARROYO, nombre: 'Arroyo principal (B)' },
      geometry: { type: 'LineString', coordinates: LINEA },
    },
    {
      type: 'Feature',
      properties: { uuid: UUID_CERRO, nombre: 'Perímetro DISCREPANTE' },
      geometry: {
        type: 'Polygon',
        coordinates: [CERRO.map(([lon, lat]) => [lon + 0.012, lat + 0.008] as [number, number])],
      },
    },
  ],
});

const DIVERGE_PACK = buildZip([
  { name: 'manifest.json', data: makeManifest([
    { role: 'A', path: 'a.geojson' },
    { role: 'B', path: 'b.geojson' },
    { role: 'KML', path: 'miembro.kml' },
  ]) },
  { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON), method: 8 },
  { name: 'b.geojson', data: new TextEncoder().encode(B_DIVERGE) },
  { name: 'miembro.kml', data: new TextEncoder().encode(KML_MIEMBRO.replace(UUID_ARROYO, UUID_CERRO).replace('Arroyo principal (K)', 'Perímetro (K)')) },
]);

/* --- capas D11: 7 tipos (FR-4 contrato 2h) ---------------------------
 * Un KML por tipo con layerType a nivel DOCUMENTO (canal que el parser
 * consume para el meta). Geometría sintética desplazada por capa para
 * que las 7 coexistan visiblemente en el lienzo (A/B 7 capas).
 * EMISIÓN v1.0: NO se emiten route_class/confidence (REQ-10 en vigor;
 * el consumo defensivo se prueba con entradas sintéticas de suite). */
// Público: fixtures sintéticos junto a los tests (W1 — jamás binarios INEGI)
const OUT = process.env.FIXTURE_OUT ?? 'tests/fixtures';
const D11_TIPOS = [
  'curva-maestra',
  'curva-intermedia',
  'cauce',
  'divisoria',
  'hachura',
  'vector',
  'ruta',
] as const;

const capasD11: Array<{ name: string; data: Uint8Array }> = [];
D11_TIPOS.forEach((tipo, i) => {
  // Ruta sintética determinista que CRUZA la subcuenca (visibilidad E2E),
  // desplazada al sur por capa para coexistencia visual sin solaparse.
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < 6; k++) {
    pts.push([
      Math.round((-101.362 + k * 0.0142) * 1e6) / 1e6,
      Math.round((21.044 - i * 0.0042 - k * 0.0018) * 1e6) / 1e6,
    ]);
  }
  const cota = 2050 + i * 15;
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Capa D11 sintética: ${tipo} (FR-W1)</name>
    <ExtendedData>
      <Data name="layerType"><value>${tipo}</value></Data>
    </ExtendedData>
    <Placemark>
      <name>${tipo} sintético</name>
      <LineString><coordinates>${pts.map(([a, b]) => `${a},${b},${cota}`).join(' ')}</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
  capasD11.push({ name: `${String(i + 1).padStart(2, '0')}_${tipo}.kml`, data: new TextEncoder().encode(kml) });
});
mkdirSync(`${OUT}/capas_d11`, { recursive: true });
for (const c of capasD11) writeFileSync(`${OUT}/capas_d11/${c.name}`, c.data);

/* --- FR-5 contrato g: malla de fricción sintética (GeoTIFF REAL) ------
 * 96×96 · 10 m/px · geográfico WGS84 anclado a La Soledad · Float32 sin
 * comprimir · franja NODATA −9999 · muro de alto costo. La FÓRMULA es la
 * MISMA que tests/forense_lehmann.test.ts usa (refCost) — fixture y suite
 * describen el MISMO campo D12. 0 datos de misión real (FR-W1). */
const FR_N = 96;
const FR_NODATA = -9999;
const frictionField = new Float32Array(FR_N * FR_N);
for (let j = 0; j < FR_N; j++)
  for (let i = 0; i < FR_N; i++) {
    let v: number;
    if (j >= 10 && j <= 13) v = FR_NODATA;
    else {
      const base = 2 + 9 * (i / 95);
      const wall = i >= 30 && i <= 70 && j >= 40 && j <= 58 ? 9 : 0;
      v = base + wall;
    }
    frictionField[j * FR_N + i] = v;
  }

const f64le = (v: number): number[] => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v, true);
  return Array.from(new Uint8Array(b.buffer));
};
const f32le = (arr: Float32Array): number[] => {
  const b = new DataView(new ArrayBuffer(arr.length * 4));
  for (let i = 0; i < arr.length; i++) b.setFloat32(i * 4, arr[i]!, true);
  return Array.from(new Uint8Array(b.buffer));
};

function buildFrictionTiff(): Uint8Array {
  const entries: Array<[number, number, number, number]> = [];
  const LONG = 4;
  const SHORT = 3;
  const DOUBLE = 12;
  const ASCII = 2;
  const ifdOff = 8;
  const ifdSize = 2 + 14 * 12 + 4;
  const scaleOff = ifdOff + ifdSize; // 3 doubles
  const tieOff = scaleOff + 24; // 6 doubles
  const keysOff = tieOff + 48; // 12 shorts
  const nodOff = keysOff + 24; // "-9999\0" = 6 B
  const stripOff = nodOff + 6;
  const stripBytes = FR_N * FR_N * 4;
  entries.push(
    [256, LONG, 1, FR_N], // ImageWidth
    [257, LONG, 1, FR_N], // ImageLength
    [258, SHORT, 1, 32], // BitsPerSample
    [259, SHORT, 1, 1], // Compression: sin comprimir
    [273, LONG, 1, stripOff], // StripOffsets
    [277, SHORT, 1, 1], // SamplesPerPixel
    [278, LONG, 1, FR_N], // RowsPerStrip
    [279, LONG, 1, stripBytes], // StripByteCounts
    [284, SHORT, 1, 1], // PlanarConfiguration
    [339, SHORT, 1, 3], // SampleFormat: IEEE float
    [33550, DOUBLE, 3, scaleOff], // ModelPixelScale
    [33922, DOUBLE, 6, tieOff], // ModelTiepoint
    [34735, SHORT, 12, keysOff], // GeoKeyDirectory
    [42113, ASCII, 6, nodOff], // GDAL_NODATA
  );
  const bytes: number[] = [0x49, 0x49, 0x2a, 0x00, ...u32a(ifdOff)];
  const ifd: number[] = [...u16a(entries.length)];
  for (const [tag, type, count, val] of entries) {
    ifd.push(...u16a(tag), ...u16a(type), ...u32a(count));
    if (type === SHORT && count === 1) ifd.push(...u16a(val), ...u16a(0));
    else ifd.push(...u32a(val));
  }
  ifd.push(...u32a(0)); // next IFD
  bytes.push(...ifd);
  // ModelPixelScale: 10 m/px en grados (convención equirectangular local)
  const mPerLat = 111320;
  const rad = (21.0 * Math.PI) / 180;
  bytes.push(...f64le(10 / (mPerLat * Math.cos(rad))), ...f64le(10 / mPerLat), ...f64le(0));
  // ModelTiepoint: esquina NO de la malla anclada a La Soledad
  bytes.push(
    ...f64le(0), ...f64le(0), ...f64le(0),
    ...f64le(-101.362), ...f64le(21.044), ...f64le(0)
  );
  // GeoKeys: header + GTModelType=2 (geográfico) + GeographicType=4326
  bytes.push(...u16a(1), ...u16a(1), ...u16a(0), ...u16a(2));
  bytes.push(...u16a(1024), ...u16a(0), ...u16a(1), ...u16a(2));
  bytes.push(...u16a(2048), ...u16a(0), ...u16a(1), ...u16a(4326));
  for (const ch of new TextEncoder().encode('-9999')) bytes.push(ch);
  bytes.push(0);
  bytes.push(...f32le(frictionField));
  return new Uint8Array(bytes);
}

const FRICTION_TIF = buildFrictionTiff();

/* --- FR-5 contrato g: Mission Pack COMPLETO (malla + 7 capas D11) ----- */
const FR5_PACK = buildZip([
  {
    name: 'manifest.json',
    data: makeManifest([
      { role: 'A', path: 'a.geojson', layerType: 'vector' },
      { role: 'B', path: 'b.geojson' },
      { role: 'KML', path: 'miembro.kml' },
      ...capasD11.map((c) => ({ role: 'KML', path: c.name })),
      { role: 'FRICTION.TIF', path: 'friction_mesh.tif' },
      { role: 'datum', path: 'datum.prj' },
    ]),
  },
  { name: 'a.geojson', data: new TextEncoder().encode(A_GEOJSON), method: 8 },
  { name: 'b.geojson', data: new TextEncoder().encode(B_GEOJSON) },
  { name: 'miembro.kml', data: new TextEncoder().encode(KML_MIEMBRO) },
  ...capasD11,
  { name: 'friction_mesh.tif', data: FRICTION_TIF },
  { name: 'datum.prj', data: DATUM },
]);

/* --- escritura ------------------------------------------------------ */

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/rutas_sinteticas.kml`, RUTAS_KML);
writeFileSync(`${OUT}/vector_sintetico.geojson`, VECTOR_GEOJSON);
writeFileSync(`${OUT}/mision_sintetica.zip`, GOLDEN_PACK);
writeFileSync(`${OUT}/mision_diverge.zip`, DIVERGE_PACK);
writeFileSync(`${OUT}/friction_mesh_sintetico.tif`, FRICTION_TIF);
writeFileSync(`${OUT}/mision_fr5_completa.zip`, FR5_PACK);
console.log(`[fixtures] 6 fixtures sintéticos FR-W1 → ${OUT}/`);
console.log(`[fixtures] 7 capas D11 (v1.0, sin attrs v1.1 — REQ-10) → ${OUT}/capas_d11/`);
console.log(
  `[fixtures] FR-5: friction_mesh_sintetico.tif (${FRICTION_TIF.length} B · ${FR_N}×${FR_N} Float32) + mision_fr5_completa.zip (${FR5_PACK.length} B · 12 miembros)`
);
