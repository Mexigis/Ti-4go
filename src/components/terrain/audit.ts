/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cita metodológica de la demo vertical «Auditoría R1» ( Fase 3).
 *
 * Helper compartido: lo usan el botón de TerrainPanel (drawer móvil) y el
 * avatar flotante de la pila de controles de cámara (TerrainViewer). Función
 * pura sin hooks ⇒ no requiere directiva 'use client'.
 */

import { BRAND, QUALITY_SEAL } from '@/lib/branding';
import { inegiCodesJoin } from '@/lib/terrain/inegi';
import type { RegionDef } from '@/lib/terrain/regions';

/** Construye la cita copiable de Auditoría R1 (intervalo de 1 m forzado). */
export function buildAuditCitation(region: RegionDef): string {
  return `${BRAND} (sello de calidad ${QUALITY_SEAL}) · ${region.name} · ${region.areaHa.toLocaleString('es-MX')} ha ${
    region.official
      ? '(superficie oficial SMAOT, decreto 18/08/2006)'
      : '(superficie aproximada)'
  } · Marco INEGI MTN 1:50 000: ${inegiCodesJoin(' · ')} · intervalo 1 m forzado (modo auditoría)`;
}
