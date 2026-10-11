# Contenido de `public/`

Activos estáticos servidos en la raíz del visor y del Web Component embebible.

## GeoTIFF sintéticos (fixtures de decodificación)

| Archivo | Codec | Tamaño |
|---|---|---|
| `deflate.tif` | Deflate (tag 259 = 8) | 27,256 B |
| `lzw.tif` | LZW (tag 259 = 5) | 62,624 B |
| `uncompressed_le.tif` | Sin compresión, little-endian (tag 259 = 1) | 181,514 B |

Los tres archivos contienen **la misma superficie sintética 301×301 px · 16-bit · 1 banda**,
empaquetada en los tres códecs de compresión TIFF que el decodificador del motor
(`src/lib/ingest/geotiff-dem.ts`) soporta. Son fixtures de prueba de decodificación
(regla FR-W1 del proyecto: **datos raster de proveniencia INEGI jamás viajan en el
árbol público** — solo parsers, documentación, URLs oficiales y fixtures sintéticos).

### Evidencia de proveniencia sintética (verificación forense)

- **Georreferencia genérica**: EPSG:4326 (GeoKey 2048=4326) — los productos INEGI
  usan EPSG:6372 (ITRF2008 / LTM) o UTM 13N/14N.
- **Dimensiones 301×301**: patrón de prueba — no corresponde a mosaico INEGI.
- **Escala de píxel 0.00035°** y tiepoint redondeado (−101.377475, 21.104475):
  valores elegidos a mano, no resolución de producto (INEGI DEM: 15/30 m proyectados).
- **Contenido raster matemático**: gradiente suave centrado en 2048 (2¹¹) con
  terminador uniforme (fila final constante) — sin varianza de terreno natural.
- **Sin metadatos de productor**: no hay tags Software/Copyright/proveedor.
- `deflate.tif` y `uncompressed_le.tif` decodifican a **la misma matriz** — la
  única diferencia entre los tres archivos es el codec, que es justo lo que se prueba.
- Gemelo explícito del mismo lote: `tests/fixtures/friction_mesh_sintetico.tif`.

### Uso

El único consumidor en el árbol es el build del artefacto air-gap
(`scripts/build_airgap.sh`), que los incluye como datos DEM de demostración del
visor embebido. Ninguna ruta del visor los descarga por defecto.

## Otros activos

- `logo.svg` — marca del proyecto (Apache 2.0, ver `../NOTICES`).
- `sw.js` — Service Worker (precache del visor embebible).
- `robots.txt` — rastreo permitido salvo rutas de utilidad.
- `wc/` — artefacto del Web Component `ti4go-viewer.js` + declaración `.d.ts`
  (misma distribución que el release `ti4go-embed-kit`).
