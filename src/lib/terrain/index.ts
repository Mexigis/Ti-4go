/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ti-4GO Terrain SDK — contrato de integración cerrado a beneficiarios
 * ( Fase 3; re-clasificado por revisión de ingeniería, revisión de gobernanza v2.1 — ex-«API pública»).
 * Sello de calidad: MexiGIS. Desarrollado por PPcoyente.
 *
 * Superficie de consumo del motor cartográfico determinista 0 GPU. Todo el
 * pipeline es importable y embebible desde este punto único:
 *
 * ```ts
 * import { buildTerrain, buildContours, IsoEngine, packRegionSeed } from '@/lib/terrain';
 *
 * const model = buildTerrain(getRegion('soledad'));
 * const contours = buildContours(model.grid);          // 1 m / maestras 25 m
 * new IsoEngine(canvas).setModel(model, contours);     // Canvas 2D, sin WebGL
 * packRegionSeed(getRegion('soledad'));                // MDT ≈101 KB → ~230 chars
 * ```
 *
 * Contrato del producto: cero GPU/WebGL, generación en Web Worker con
 * fallback síncrono, render bajo demanda (0 cuadros en reposo) y
 * determinismo por semilla (protocolo MXP1).
 */

export { IsoEngine, type ViewOpts, type HudInfo, type PresetName } from './engine';
export {
  FIELD_PRESET,
  FIELD_TARGET_PX,
  FIELD_BLOCKED_OPTS,
  FIELD_FALLBACK_BADGE,
  fieldHasFallback,
  applyFieldPreset,
} from './fieldmode';
export {
  buildContours,
  DEFAULT_SIMPLIFY_TOL,
  LIGHT_SIMPLIFY_TOL,
  type Contours,
  type Level,
  type Poly,
  type BuildContoursOpts,
} from './contours';
export {
  buildTerrain,
  sampleGrid,
  type TerrainModel,
  type Grid,
  type BasinInfo,
  type TerrainStats,
} from './generator';
export { REGIONS, getRegion, type RegionDef, type BasinDef } from './regions';
export { packRegionSeed, unpackRegionSeed, type SeedPackInfo } from './seedpack';
