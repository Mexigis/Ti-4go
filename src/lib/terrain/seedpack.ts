/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compresión de semilla ( Fase 4) — protocolo MXP1 v2 (EX-004).
 *
 * El MDT completo de una región son 161×161 Float32 ≈ 101 KB; como la
 * síntesis es determinista, basta distribuir los parámetros compactados
 * (202–240 caracteres) para regenerar exactamente el mismo terreno en
 * cualquier cliente con el SDK. Sin red, sin binarios, verificable.
 *
 * v2: `MXP1-<base64url(JSON)>.<SHA-256 truncado a 64 bits · 16 hex>`
 *     — el checksum djb2 de v1 (base36, ≤7 chars) era colisionable;
 *     SHA-256 (FIPS 180-4, `sha256.ts` puro TS) da 64 bits de integridad.
 * v1 (legacy, solo lectura): `MXP1-<base64url(JSON)>.<djb2 base36>` —
 *     se distingue por la LONGITUD del checksum: 16 hex ⇒ v2; en otro caso
 *     se intenta djb2 base36. No hay ambigüedad posible.
 *
 * El payload es numérico/ASCII ⇒ btoa directo es seguro.
 * Hardening (Bundle A #5, aprobado 2026-09-25): tras verificar el checksum
 * se validan TIPO y FINITUD de todos los campos — el checksum da integridad,
 * no autenticidad; un pack hostil con checksum recomputado se rechaza.
 */

import type { RegionDef } from './regions';
import { sha256Trunc64 } from './sha256';

export interface SeedPackInfo {
  version: 1 | 2;
  /** id de región (soledad, esperanza, bufa, santa-rosa) */
  id: string;
  /** semilla procedural determinista */
  seed: number;
  centerLat: number;
  centerLon: number;
  extent: number;
  /** número de subcuencas esculpidas */
  basins: number;
}

interface SeedPayload {
  v: 1 | 2;
  id: string;
  s: number;
  lat: number;
  lon: number;
  e: number;
  /** centroides/áreas de subcuencas: [cx, cy, areaHa?] por cuenca */
  b: number[][];
}

/** djb2 sobre UTF-16 code units, devuelto en base36 — SOLO verificación legacy v1. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Empaqueta una región a su semilla v2 (determinista, reversible, checksum SHA-256 64 bits). */
export function packRegionSeed(r: RegionDef): string {
  const payload: SeedPayload = {
    v: 2,
    id: r.id,
    s: r.seed,
    lat: r.centerLat,
    lon: r.centerLon,
    e: r.extent,
    b: r.basins.map((b) => [
      +b.cx.toFixed(1),
      +b.cy.toFixed(1),
      +b.r.toFixed(1),
      +b.outletAz.toFixed(3),
    ]),
  };
  const json = JSON.stringify(payload);
  const body = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `MXP1-${body}.${sha256Trunc64(json)}`;
}

/**
 * Decodifica y verifica una semilla MXP1 (v2 o legacy v1); null si el
 * formato/checksum/validación de rango no es válido. El checksum va sobre
 * el JSON canónico (antes de base64); la validación de tipos/finitud es
 * defensa-en-profundidad (integridad ≠ autenticidad).
 */
export function unpackRegionSeed(code: string): SeedPackInfo | null {
  const m = /^MXP1-([A-Za-z0-9_-]+)\.([a-z0-9]+)$/.exec(code.trim());
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    // v2 ⇒ checksum 16 hex; en otro caso legacy v1 (djb2 base36, ≤7 chars)
    const isV2 = m[2].length === 16 && /^[0-9a-f]{16}$/.test(m[2]);
    if (isV2) {
      if (sha256Trunc64(json) !== m[2]) return null;
    } else if (djb2(json) !== m[2]) {
      return null;
    }
    const p = JSON.parse(json) as SeedPayload;
    if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64) return null;
    if (p.v !== (isV2 ? 2 : 1)) return null; // inconsistencia versión⟷checksum ⇒ rechazo
    if (typeof p.s !== 'number' || !Number.isFinite(p.s)) return null;
    if (typeof p.lat !== 'number' || !Number.isFinite(p.lat) || Math.abs(p.lat) > 90) return null;
    if (typeof p.lon !== 'number' || !Number.isFinite(p.lon) || Math.abs(p.lon) > 180) return null;
    if (typeof p.e !== 'number' || !Number.isFinite(p.e) || p.e <= 0 || p.e > 2_000_000) return null;
    if (!Array.isArray(p.b)) return null;
    return {
      version: p.v,
      id: p.id,
      seed: p.s,
      centerLat: p.lat,
      centerLon: p.lon,
      extent: p.e,
      basins: p.b.length,
    };
  } catch {
    return null;
  }
}
