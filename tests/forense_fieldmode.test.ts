/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-6 — PRESET «MODO CAMPO» (módulo puro + chrome).
 * Checkpoint re-entrada  (paso 5: FR-6 P2/P3).
 * Criterios de la spec docs/fr-specs/FR-6-modo-campo-preset.md §7:
 *
 *   A-1  Preset congelado (Object.isFrozen), known-answer (deepEqual),
 *        applyFieldPreset determinista (JSON igual) y bloquea eink/powerSave
 *        contra overrides del embedder Y del estado de usuario.
 *   A-6  Mapeo de fallback → badge persistente «Tramas: solo export»
 *        (fieldHasFallback + FIELD_FALLBACK_BADGE — texto sin tecnicismos).
 *   A-7  Sin lógica GPS: FieldBar/fieldmode no contienen «geolocation» y el
 *        placeholder honesto está presente (texto + aria-label).
 *   A-8  Offline-first: fieldmode.ts y FieldBar.tsx sin fetch/XHR/WebSocket
 *        (test estático sobre el código fuente).
 *   Regla FR-W1: fixtures sintéticos solo; W5 0 GPU: el test nunca toca el
 *   rasterizador (A-2/A-3 ya viven en forense_lehmann/forense_pack).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applyFieldPreset,
  FIELD_BLOCKED_OPTS,
  FIELD_FALLBACK_BADGE,
  FIELD_PRESET,
  FIELD_TARGET_PX,
  fieldHasFallback,
} from '@/lib/terrain/fieldmode';
import type { ViewOpts } from '@/lib/terrain/engine';

/** Estado de usuario base para el merge (todas las requeridas de ViewOpts). */
const BASE: ViewOpts = {
  minor: true,
  major: true,
  mesh: true,
  nodes: true,
  streams: true,
  divides: true,
  labels: true,
  cotas: true,
  inegi: true,
  elevRange: [2055, 2365],
  forcedStep: 0,
  reliefFx: true,
  eink: false,
  day: false,
  powerSave: false,
};

describe('FR-6 · fieldmode — preset Modo Campo', () => {
  test('A-1 · FIELD_PRESET congelado y known-answer (spec §5)', () => {
    expect(Object.isFrozen(FIELD_PRESET)).toBe(true);
    expect(FIELD_PRESET).toEqual({
      eink: true,
      powerSave: true,
      reliefFx: false,
      mesh: false,
      nodes: false,
      minor: true,
      major: true,
      streams: true,
      divides: true,
      labels: true,
      cotas: true,
      inegi: true,
      forcedStep: 0,
    });
    expect(FIELD_TARGET_PX).toBe(44);
    expect(Object.isFrozen(FIELD_BLOCKED_OPTS)).toBe(true);
    expect([...FIELD_BLOCKED_OPTS]).toEqual(['eink', 'powerSave']);
  });

  test('A-1 · applyFieldPreset determinista (misma entrada ⇒ JSON igual)', () => {
    const a = applyFieldPreset(BASE);
    const b = applyFieldPreset(BASE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // el preset SIEMBRA el estado de campo sobre el usuario…
    expect(a.eink).toBe(true);
    expect(a.powerSave).toBe(true);
    expect(a.mesh).toBe(false);
    expect(a.nodes).toBe(false);
    expect(a.reliefFx).toBe(false);
    // …conserva lo que el preset no cubre (misión intacta + rango del usuario)
    expect(a.elevRange).toEqual([2055, 2365]);
  });

  test('A-1 · bloqueados: eink/powerSave resisten overrides (embedder y usuario)', () => {
    const r1 = applyFieldPreset(BASE, { eink: false, powerSave: false });
    expect(r1.eink).toBe(true);
    expect(r1.powerSave).toBe(true);
    const r2 = applyFieldPreset(
      { ...BASE, eink: false, powerSave: false },
      { eink: false, powerSave: false, mesh: true }
    );
    expect(r2.eink).toBe(true);
    expect(r2.powerSave).toBe(true);
    // lo NO bloqueado sí es sobre-escribible por el embedder (spec §4)
    expect(r2.mesh).toBe(true);
  });

  test('A-6 · mapeo de fallback → badge persistente (R-4, texto G-6)', () => {
    expect(fieldHasFallback('', '')).toBe(false);
    expect(fieldHasFallback('guard', '')).toBe(true);
    expect(fieldHasFallback('', 'frame')).toBe(true);
    expect(fieldHasFallback('guard', 'frame')).toBe(true);
    expect(FIELD_FALLBACK_BADGE).toBe('Tramas: solo export');
  });

  test('A-7 · GPS = FR-7 entregado: chip real en el SLOT, 0 geolocation en el chrome (R-5)', () => {
    const bar = readFileSync('src/components/terrain/FieldBar.tsx', 'utf8');
    // FR-7 landed: el SLOT monta el chip real del controlador (GpsChip), el
    // embedder sigue pudiendo sobre-escribir con gpsSlot. La lógica GPS vive
    // SOLO en src/lib/gps (auditada por forense_gps A-1) — el chrome no la
    // contiene jamás.
    expect(bar).toContain('GpsChip');
    expect(bar).toContain('gpsSlot');
    expect(/geolocation/i.test(bar)).toBe(false);
    const fm = readFileSync('src/lib/terrain/fieldmode.ts', 'utf8');
    expect(/geolocation/i.test(fm)).toBe(false);
  });

  test('A-8 · offline-first: 0 red en fieldmode.ts y FieldBar.tsx (estático)', () => {
    const re = /fetch\(|XMLHttpRequest|WebSocket|new EventSource|navigator\.sendBeacon/;
    for (const f of ['src/lib/terrain/fieldmode.ts', 'src/components/terrain/FieldBar.tsx']) {
      const src = readFileSync(f, 'utf8');
      expect(re.test(src)).toBe(false);
    }
  });
});
