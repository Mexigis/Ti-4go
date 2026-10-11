/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Marca, sello de calidad, desarrollador, beneficiarios y versión del SDK —
 * fuente única de verdad.
 *
 * Jerarquía de identidad (definida por el propietario):
 * - BRAND «Ti-4GO»      → marca del producto.
 * - QUALITY_SEAL «MexiGIS» → sello de calidad que certifica el motor.
 * - DEVELOPER «PPcoyente»  → empresa desarrolladora.
 * - BENEFICIARIES          → beneficiarios designados del producto.
 *
 * Todos los puntos de superficie (metadata HTML, package.json, header, footer,
 * panel) importan desde aquí para evitar divergencias.
 */

/** Marca del producto. */
export const BRAND = 'Ti-4GO';

/** Sello de calidad que certifica el motor cartográfico. */
export const QUALITY_SEAL = 'MexiGIS';

/** Empresa desarrolladora. */
export const DEVELOPER = 'PPcoyente';

/** Nombre largo institucional (documentación y sellos). */
export const BRAND_LONG = 'Ti-4GO · Motor Cartográfico Determinista';

/** Promesa de valor de una línea (0 GPU · 0 bandwidth · determinista). */
export const BRAND_TAGLINE = 'Cartografía de precisión sin GPU · determinista · 0 bandwidth';

/** Versión del SDK de terreno (contrato de integración cerrado a beneficiarios en src/lib/terrain/index.ts). */
export const SDK_VERSION = '1.0.0';

/** Nombre del paquete SDK (package.json). */
export const SDK_NAME = 'ti-4go';

/** Beneficiarios registrados en los metadatos del producto. */
export const BENEFICIARIES = ['PPcoyente Group', 'MexiGIS Labs'] as const;

/** Línea única con los beneficiarios (footer, metadata, panel). */
export const BENEFICIARIES_LINE = BENEFICIARIES.join(' · ');

/** Nivel de licencia B2B informativo (la validación de clave llega en Fase 5). */
export interface LicenseTier {
  id: string;
  name: string;
  scope: string;
}

/** Tiers de licenciamiento del SDK. */
export const LICENSE_TIERS: LicenseTier[] = [
  { id: 'comunidad', name: 'Comunidad', scope: 'Visor público con atribución Ti-4GO · sello MexiGIS/INEGI' },
  { id: 'gobierno', name: 'Gobierno · SMAOT', scope: 'Demo vertical «Auditoría R1»: 1 m forzado + cita oficial' },
  { id: 'empresa', name: 'Empresa (B2B)', scope: 'SDK embebible · semillas privadas · sin marca' },
];
