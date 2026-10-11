/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/* FORENSE-REFACTOR-1 y 2 — hooks useBatterySaver (F4) y useGpsBridge (FR-7/A-8) extraídos de TerrainViewer.
 *
 * La decisión pura shouldBatterySave (frontera 0.2 inclusiva) se testea con
 * known-answers sin DOM ni Battery API. El hook en sí (feature-detect +
 * listeners + cleanup) conserva el comportamiento byte-idéntico del bloque
 * inline F4; su monte/desmonte ya queda ejercitado por la suite de embed y
 * por el E2E dorado de cada ventana (gate triple REFACTOR).
 */
import { describe, expect, test } from 'bun:test';
import { shouldBatterySave } from '../src/components/terrain/hooks/useBatterySaver';
import { anchorFromRegion, gpsMarkerPayload } from '../src/components/terrain/hooks/useGpsBridge';

describe('forense_hooks · useBatterySaver (REFACTOR-1 · F4)', () => {
  test('known-answers — Modo Ahorro automático', () => {
    // cargando ⇒ jamás ahorro automático (aunque la batería esté baja)
    expect(shouldBatterySave(true, 0.1)).toBe(false);
    expect(shouldBatterySave(true, 0.0)).toBe(false);
    // sin cargar y baja ⇒ ahorro
    expect(shouldBatterySave(false, 0.2)).toBe(true);
    expect(shouldBatterySave(false, 0.05)).toBe(true);
    // sin cargar y con energía ⇒ no ahorro
    expect(shouldBatterySave(false, 1.0)).toBe(false);
    expect(shouldBatterySave(false, 0.9)).toBe(false);
  });

  test('frontera inclusiva 0.2 — el umbral del contrato F4', () => {
    expect(shouldBatterySave(false, 0.2)).toBe(true); // ≤ 20 % exacto ⇒ SÍ ahorra
    expect(shouldBatterySave(false, 0.21)).toBe(false); // un punto arriba ⇒ no
  });

  test('determinismo — misma entrada ⇒ mismo veredicto (3 pasadas)', () => {
    for (let i = 0; i < 3; i++) {
      expect(shouldBatterySave(false, 0.2)).toBe(true);
      expect(shouldBatterySave(true, 0.2)).toBe(false);
      expect(shouldBatterySave(false, 0.199999)).toBe(true);
    }
  });
});

describe('forense_hooks · useGpsBridge (REFACTOR-2 · FR-7/A-8)', () => {
  const fix = { lat: 21.018, lon: -101.3248 };
  const anchor = { centerLat: 21.05, centerLon: -101.33, extentM: 15000 };

  test('gpsMarkerPayload — fix+tono ⇒ payload; sin fix o sin tono ⇒ null (A-8)', () => {
    expect(gpsMarkerPayload({ fix, status: 'activo' }, 'ok')).toEqual({ lat: 21.018, lon: -101.3248, tone: 'ok' });
    // sin fix ⇒ marcador ausente (con tono o sin él)
    expect(gpsMarkerPayload({ fix: null, status: 'solicitando' }, 'ok')).toBe(null);
    expect(gpsMarkerPayload({ fix: null, status: 'inactivo' }, null)).toBe(null);
    // fix presente pero tono nulo (status sin marcador) ⇒ ausente
    expect(gpsMarkerPayload({ fix, status: 'denegado' }, null)).toBe(null);
  });

  test('anchorFromRegion — mapeo región→Anchor: extent ⇒ extentM (FR-7)', () => {
    expect(anchorFromRegion({ centerLat: 21.05, centerLon: -101.33, extent: 15000 })).toEqual({
      centerLat: 21.05,
      centerLon: -101.33,
      extentM: 15000,
    });
  });

  test('determinismo — misma entrada ⇒ mismo payload/anchor (3 pasadas)', () => {
    for (let i = 0; i < 3; i++) {
      expect(gpsMarkerPayload({ fix, status: 'activo' }, 'degradado')).toEqual({ lat: 21.018, lon: -101.3248, tone: 'degradado' });
      expect(anchorFromRegion({ centerLat: 20.99, centerLon: -101.28, extent: 8000 })).toEqual({
        centerLat: 20.99,
        centerLon: -101.28,
        extentM: 8000,
      });
    }
  });
});
