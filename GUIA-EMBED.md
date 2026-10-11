# Ti-4GO Embed Kit — guía de integración
### Un visor cartográfico determinista, 0-GPU, offline — en tu página en 15 minutos.

**Quick start (EN):** serve this folder with any static server (`python3 -m http.server`),
open `demo.html`, then copy the `<script>` + `<ti4go-viewer>` pattern below. No build step,
no dependencies, no conflicts with your stack (Shadow DOM + bundled React).

---

## 1 · Qué es (2 minutos)

`<ti4go-viewer>` es un Web Component que renderiza terreno en curvas de nivel
(vista isométrica) con consumo mínimo: **0 GPU, 0 cuadros en reposo**, funciona
completo offline y es legible en pantalla E-Ink a pleno sol. Acepta tres canales
de datos: una semilla (240 caracteres), GeoJSON, o un paquete ZIP de misión con
verificación de integridad. Todo el cómputo ocurre en el navegador.

Requisitos: cualquier navegador moderno. **Solo si quieres GPS dentro del embed**,
el contexto debe ser HTTPS o localhost (requisito del navegador para geolocation,
no nuestro).

**El chrome viaja dentro del componente (desde v1.0.2):** el modo experto
(HUD, paneles, cards flotantes, tipografía) llega estilizado dentro del shadow
DOM — no necesitas cargar ninguna hoja de estilos del anfitrión ni tocar tu
CSS. Si tu página ya usa Tailwind no hay conflicto (el Shadow DOM aísla ambas
hojas). Dos notas honestas: las fuentes son las del sistema del visitante, y
los menús abren sin animación (decisión de presupuesto — el visor pesa menos
de 0.7 MB; la funcionalidad es idéntica).

## 2 · Instalación y primer embed (5 minutos)

```html
<!-- 1. Carga el componente (una sola vez) -->
<script type="module" src="ti4go-viewer.js"></script>

<!-- 2. Monta el visor donde quieras -->
<ti4go-viewer theme="day" mode="field" url-sync="false"
              style="width:100%;height:600px"></ti4go-viewer>

<!-- 3. Carga datos y encuadra -->
<script type="module">
  const v = document.querySelector('ti4go-viewer');

  // Canal A: semilla MXP1 (terreno procedural determinista, ~240 chars)
  const receipt = await v.loadMissionPack('MXP1-<semilla-del-demo>');
  console.log('cargado:', receipt);

  // Encuadra una zona
  v.flyToBBox([-101.36, 21.02, -101.29, 21.08]);
</script>
```

**Atributos:** `theme` = `dark | day | eink` · `mode` = `field | expert` (campo
oculta el chrome técnico) · `url-sync` = `false` cuando está embebido (no toca
la URL de tu página).

## 3 · Canales de datos (5 minutos)

| Canal | Qué acepta | Cuándo usar |
|---|---|---|
| **Semilla MXP1** | `string` `MXP1-…` (~240 chars) | Terreno procedural determinista — mismo string ⇒ mismo terreno, byte a byte |
| **GeoJSON** | `FeatureCollection` — WGS84 (RFC 7946) o UTM 14N con CRS declarado | Rutas, frentes, zonas — geometría sobre el terreno |
| **Mission Pack ZIP** | `File`/`ArrayBuffer` — paquete con manifiesto | Paquete completo con verificación de integridad y cadena de custodia |

```js
// GeoJSON directo:
await v.loadMissionPack({ type: 'FeatureCollection', features: [/* … */] });
// ZIP desde un input file:
input.addEventListener('change', () => v.loadMissionPack(input.files[0]));
```

El `CustodyReceipt` que devuelve `loadMissionPack` incluye el SHA-256 del
paquete, el veredicto de integridad entre canales y el datum vertical activo.

## 4 · API completa

**Métodos:**
- `loadMissionPack(source: File | ArrayBuffer | GeoJSONFeatureCollection | string): Promise<CustodyReceipt>`
- `flyToBBox(bbox: [west, south, east, north]): void`
- `setViewOpts(opts: Partial<ViewOpts>): void` — capas on/off, tema E-Ink, intervalo de curvas
- `getExportScene(): ExportScene` — escena WYSIWYG para tus propios exports

**Eventos (CustomEvent, `e.detail`):**
- `ti4go:layer-select` — `{ layerId, uuid, layerType }` (clic en capa)
- `ti4go:camera-change` — `{ az, el, zoom }`
- `ti4go:divergence` — `{ verdict, members }` (los canales de datos discrepan — información de seguridad)
- `ti4go:custody` — `{ packSha, triangles }` (cadena de custodia del paquete cargado)

```js
v.addEventListener('ti4go:layer-select', e => {
  console.log('capa:', e.detail.layerType, e.detail.uuid);
});
```

## 5 · Multi-instancia y rendimiento

Cada instancia inactiva **no consume CPU** (render bajo demanda: solo dibuja con
interacción). El costo por instancia es memoria (~10 MB). Tres visores en una
página es un caso verificado. En instancias embebidas usa siempre
`url-sync="false"`.

## 6 · Demo incluido

`demo.html` monta tres instancias (temas dark/day/eink) con semillas sintéticas
y ejercita la API completa. Sírvelo estático:

```bash
python3 -m http.server 8080   # o cualquier servidor estático
# abre http://localhost:8080/demo.html
```

## 7 · Licencia

Apache 2.0 — ver `LICENSE`. Uso comercial, modificación y redistribución
permitidos con atribución. El kit es autosuficiente: no requiere cuentas,
servidores ni conexión.

## 8 · Problemas frecuentes

| Síntoma | Causa |
|---|---|
| Visor vacío con `file://` | Los módulos ES requieren servidor estático (1 comando arriba) |
| Chip GPS deshabilitado | El contexto no es HTTPS/localhost — el resto funciona normal |
| Mis curvas no aparecen | GeoJSON en UTM sin CRS declarado — decláralo o emite WGS84 |
| Divergencia reportada | Tus dos canales de datos no coinciden — el visor te dice cuál y dónde |

— Ti-4GO v1.0.2 · KIT-MANIFEST.txt verifica cada archivo con SHA-256.
