/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B-D1 · CSS BASELINE del Web Component `ti4go-viewer` — cura del hallazgo
 * clase-nueva «estilos-WC-nunca-inyectados» (Task 59 → RCA Task 61).
 *
 * Causa raíz (probada, no adivinada):
 *  - `Ti4goViewerElement.styles` era `null` y NADIE lo asignaba: el bundle
 *    llevaba el inyector (`data-ti4go-styles`) pero cero CSS.
 *  - El Shadow DOM AÍSLA por definición las hojas del documento anfitrión —
 *    las clases Tailwind del subtree eran inertes en todo contexto bundle.
 *  - Sin CSS, el canvas (`absolute inset-0 h-full w-full`) cae en flujo
 *    normal: su atributo height (escrito por engine.resize()) infla al padre
 *    ⇒ ResizeObserver ⇒ resize() ⇒ ×dpr ⇒ crecimiento ~exponencial hasta el
 *    clamp del navegador (buffer 1118×33,554,368 = 2^25) ⇒ TERRENO EN BLANCO.
 *
 * Este baseline es el MÍNIMO GEOMÉTRICO para que el elemento sea autosuficiente:
 *   1. tokens de tema (dark default + day override) copiados VERBATIM de
 *      src/app/globals.css — scoping: [data-ti4go-root] / [data-ti4go-root].day
 *      (la clase `day`|`dark` la pone el elemento en el div raíz, DENTRO del
 *      shadow tree — el `.dark` en <html> del anfitrión jamás cruza la frontera).
 *   2. la cadena de montaje del lienzo (root flex → main relative → canvas
 *      absolute) con los NOMBRES DE CLASE reales de TerrainViewer.tsx.
 *   3. `:host` — el default de un custom element es display:inline; sin esta
 *      regla la cadena height:100% colapsa.
 *   4. Override del app-shell `h-[100dvh]` → 100% del ELEMENTO (semántica
 *      embed: el visor llena su host, no el viewport del anfitrión).
 *
 * Alcance deliberado: el chrome cosmético completo (paneles/HUD/drawer con
 * variantes responsive y portales Radix) sigue viniendo de hojas ADOPTADAS
 * por el consumidor (wc-host demuestra el patrón post-fix) — el baseline
 * garantiza que SIN ellas el terreno se vea y el elemento sea estable.
 *
 * PROVENANCE: valores de tokens espejo de globals.css (design-tokens.json).
 * Detector de deriva: el gate visual E2E (píxeles, no solo señal) — la
 * lección del Task 59 manda: «la señal no es el píxel — la caminata visual».
 */

export const WC_BASELINE_CSS = String.raw`
/* —— 1 · tokens DARK (default del sistema: :root,.dark comparten bloque) —— */
[data-ti4go-root] {
  color-scheme: dark;
  --dt-canvas: #181c20; --dt-surface: #22272e; --dt-raised: #2c333b; --dt-overlay: #363d45;
  --dt-fg: #e6edf3; --dt-fg-secondary: #b1bac4; --dt-fg-tertiary: #b1bac4;
  --dt-vector: #8b949e; --dt-grid: #30363d; --dt-border-subtle: #30363d; --dt-border-strong: #3d444d;
  --dt-o300: #fdba74; --dt-o400: #fb923c;
  --dt-elev-1: 0 1px 2px rgba(0,0,0,.35); --dt-elev-2: 0 4px 8px rgba(0,0,0,.45);
  --dt-elev-3: 0 8px 16px rgba(0,0,0,.55); --dt-elev-4: 0 16px 32px rgba(0,0,0,.65);
  --dt-elev-5: 0 24px 48px rgba(0,0,0,.75);
  --cv-bg: #18181b; --cv-minor: #7a7a85; --cv-major: #f97316;
  --cv-stream: rgba(161,161,170,.5); --cv-divide: #fb923c; --cv-node: rgba(249,115,22,.6);
  --radius: 8px;
  --background: var(--dt-canvas); --foreground: var(--dt-fg);
  --card: var(--dt-surface); --card-foreground: var(--dt-fg);
  --popover: var(--dt-raised); --popover-foreground: var(--dt-fg);
  --primary: var(--dt-fg); --primary-foreground: var(--dt-canvas);
  --secondary: var(--dt-raised); --secondary-foreground: var(--dt-fg);
  --muted: var(--dt-raised); --muted-foreground: var(--dt-fg-secondary);
  --accent: var(--dt-overlay); --accent-foreground: var(--dt-fg);
  --destructive: oklch(0.704 0.191 22.216);
  --border: var(--dt-border-subtle); --input: var(--dt-border-strong); --ring: #f97316;
  --chart-1: #f97316; --chart-2: var(--dt-vector); --chart-3: var(--dt-fg-secondary);
  --chart-4: var(--dt-fg-tertiary); --chart-5: var(--dt-grid);
  --sidebar: var(--dt-surface); --sidebar-foreground: var(--dt-fg);
  --sidebar-primary: var(--dt-fg); --sidebar-primary-foreground: var(--dt-canvas);
  --sidebar-accent: var(--dt-overlay); --sidebar-accent-foreground: var(--dt-fg);
  --sidebar-border: var(--dt-border-subtle); --sidebar-ring: #f97316;
  background: var(--background); color: var(--foreground);
}
/* —— 2 · tokens DAY (solo redefinen primitivos; el puente re-resuelve solo) —— */
[data-ti4go-root].day {
  color-scheme: light;
  --dt-canvas: #efefef; --dt-surface: #ffffff; --dt-raised: #fafafa; --dt-overlay: #ffffff;
  --dt-fg: #2c2c2c; --dt-fg-secondary: #666666; --dt-fg-tertiary: #999999;
  --dt-vector: #666666; --dt-grid: #999999; --dt-border-subtle: #d9d9d9; --dt-border-strong: #cccccc;
  --dt-o300: #c2410c; --dt-o400: #ea580c;
  --dt-elev-1: 0 1px 2px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.04);
  --dt-elev-2: 0 2px 4px rgba(0,0,0,.08), 0 4px 8px rgba(0,0,0,.04);
  --dt-elev-3: 0 4px 8px rgba(0,0,0,.1), 0 8px 16px rgba(0,0,0,.06);
  --dt-elev-4: 0 8px 16px rgba(0,0,0,.12), 0 16px 32px rgba(0,0,0,.08);
  --dt-elev-5: 0 16px 32px rgba(0,0,0,.14), 0 24px 48px rgba(0,0,0,.1);
  --cv-bg: #efefef; --cv-minor: #8b8b90; --cv-major: #ea580c;
  --cv-stream: rgba(113,113,122,.55); --cv-divide: #ea580c; --cv-node: rgba(234,88,12,.65);
}
/* —— 3 · :host — el default inline de un custom element colapsa height:100% —— */
:host { display: block; position: relative; }
/* —— 4 · cadena de montaje del lienzo (clases reales de TerrainViewer.tsx) —— */
[data-ti4go-root] > .h-\[100dvh\] { height: 100% !important; }
.h-\[100dvh\] { display: flex; flex-direction: column; }
.h-14 { height: 3.5rem; }
.shrink-0 { flex-shrink: 0; }
.flex { display: flex; }
.flex-col { flex-direction: column; }
.flex-1 { flex: 1 1 0%; min-width: 0; }
.items-center { align-items: center; }
.gap-3 { gap: .75rem; }
.min-h-0 { min-height: 0; }
.relative { position: relative; }
.overflow-hidden { overflow: hidden; }
.absolute { position: absolute; }
.inset-0 { inset: 0; }
.h-full { height: 100%; }
.w-full { width: 100%; }
.pointer-events-none { pointer-events: none; }
.touch-none { touch-action: none; }
.select-none { user-select: none; }
.z-\[5\] { z-index: 5; }
.z-10 { z-index: 10; }
.z-20 { z-index: 20; }
.z-30 { z-index: 30; }
.bg-background { background-color: var(--background); }
.bg-card { background-color: var(--card); }
.text-foreground { color: var(--foreground); }
.border-b { border-bottom-width: 1px; border-style: solid; border-color: var(--border); }
.px-3 { padding-left: .75rem; padding-right: .75rem; }
.px-4 { padding-left: 1rem; padding-right: 1rem; }
.sm\:px-4 { padding-left: 1rem; padding-right: 1rem; }
.rounded-lg { border-radius: calc(var(--radius) - 2px); }
.rounded-xl { border-radius: var(--radius); }
.hidden { display: none; }
/* variantes responsive SOLO en su breakpoint (Tailwind: sm=640 lg=1024) —
   nunca unconditionals: mostrarían paneles hidden en móvil embebido */
@media (min-width: 640px) { .sm\:block { display: block; } }
@media (min-width: 1024px) { .lg\:block { display: block; } }
/* —— 5 · FR-6 modo campo: chrome sin animaciones + telemetría fuera —— */
.field-mode *, .field-mode *::before, .field-mode *::after {
  animation: none !important; transition: none !important;
}
.field-mode .ti4go-hud, .field-mode .ti4go-footer, .field-mode .ti4go-leyenda { display: none; }
.field-mode button, .field-mode [role="button"], .field-mode [role="combobox"],
.field-mode [role="switch"], .field-mode [role="checkbox"], .field-mode [role="tab"],
.field-mode a[href] { min-height: 44px; }
`;
