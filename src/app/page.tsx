/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { TerrainViewer } from '@/components/terrain/TerrainViewer';

/**
 * Ruta única del producto (charter §1 — el lienzo ES el producto). Estática
 * por construcción (vehículo-A S2: output: export — la página NO lee
 * searchParams en el servidor).
 *
 * FR-6 · A-11 (harness del embedder): la activación de Modo Campo por props
 * vive en el EMBEDDER (G-2 recomendado — el preset NO viaja en el hash #v=1).
 * El simulador de embedder para QA (`?campo=1`) lo resuelve el propio viewer
 * en cliente (TerrainViewer, post-hidratación) — sin persistencia, sin hash,
 * 0 efecto en estudio. La activación por avatar es superficie del app
 * contenedor (spec §11 — fuera de alcance).
 */
export default function Home() {
  return <TerrainViewer />;
}
