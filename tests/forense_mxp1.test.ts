/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense — Protocolo MXP1 (EX-004 v2 + hardening Bundle A #5).
 * Fija con aserciones los reclamos del README: SHA-256 puro TS contra
 * vectores FIPS 180-4, formato v2 (16 hex), longitudes 202–240,
 * round-trip por región, lectura legacy v1 y rechazo de packs hostiles
 * con checksum recomputado (integridad ≠ autenticidad).
 */
import { describe, expect, test } from 'bun:test';
import { packRegionSeed, unpackRegionSeed } from '../src/lib/terrain/seedpack';
import { sha256Hex, sha256Trunc64 } from '../src/lib/terrain/sha256';
import { REGIONS } from '../src/lib/terrain/regions';

describe('SHA-256 puro TS — vectores FIPS 180-4', () => {
  test('vacío ⇒ e3b0c442…', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
  test('"abc" ⇒ ba7816bf…', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'  // FIPS 180-4 «abc» — literal íntegro restaurado (firewall de identidad nunca debe tocar literales de código)
    );
  });
  test('bloque 448-bit ("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    );
  });
  test('determinismo ×100', () => {
    const first = sha256Hex('MXP1-determinismo');
    for (let i = 0; i < 100; i++) expect(sha256Hex('MXP1-determinismo')).toBe(first);
  });
  test('sha256Trunc64 = primeros 16 hex', () => {
    expect(sha256Trunc64('abc')).toBe(sha256Hex('abc').slice(0, 16));
    expect(sha256Trunc64('abc')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('MXP1 — formato v2 y round-trip', () => {
  test('formato `MXP1-<b64url>.<16 hex>` y longitud 202–240 (reclamo §0-a)', () => {
    for (const r of REGIONS) {
      const code = packRegionSeed(r);
      expect(code).toMatch(/^MXP1-[A-Za-z0-9_-]+\.[a-z0-9]{16}$/);
      expect(code.length).toBeGreaterThanOrEqual(202);
      expect(code.length).toBeLessThanOrEqual(240);
    }
  });
  test('pack determinista (mismo input ⇒ byte a byte)', () => {
    const a = packRegionSeed(REGIONS[0]);
    const b = packRegionSeed(REGIONS[0]);
    expect(a).toBe(b);
  });
  test('round-trip con campos exactos para las 4 regiones', () => {
    for (const r of REGIONS) {
      const info = unpackRegionSeed(packRegionSeed(r));
      expect(info).not.toBeNull();
      expect(info!.version).toBe(2);
      expect(info!.id).toBe(r.id);
      expect(info!.seed).toBe(r.seed);
      expect(info!.centerLat).toBe(r.centerLat);
      expect(info!.centerLon).toBe(r.centerLon);
      expect(info!.extent).toBe(r.extent);
      expect(info!.basins).toBe(r.basins.length);
    }
  });
  test('cada región produce un pack distinto', () => {
    const packs = REGIONS.map((r) => packRegionSeed(r));
    expect(new Set(packs).size).toBe(REGIONS.length);
  });
});

describe('MXP1 — legacy v1 (djb2, solo lectura)', () => {
  function packV1(payload: Record<string, unknown>): string {
    const json = JSON.stringify(payload);
    let h = 5381;
    for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0;
    const body = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `MXP1-${body}.${(h >>> 0).toString(36)}`;
  }
  test('v1 con checksum djb2 se lee con version 1', () => {
    const code = packV1({ v: 1, id: 'soledad', s: 42424, lat: 20.99, lon: -101.37, e: 3100, b: [[0, 0, 100, 1]] });
    const info = unpackRegionSeed(code);
    expect(info).not.toBeNull();
    expect(info!.version).toBe(1);
    expect(info!.id).toBe('soledad');
  });
  test('inconsistencia v⟷checksum ⇒ null (v2 declarado con checksum djb2)', () => {
    const code = packV1({ v: 2, id: 'soledad', s: 42424, lat: 20.99, lon: -101.37, e: 3100, b: [] });
    expect(unpackRegionSeed(code)).toBeNull();
  });
});

describe('MXP1 — manipulación ⇒ null', () => {
  const base = packRegionSeed(REGIONS[0]);
  const cut = (s: string, n: number) => s.slice(0, n);
  test('cuerpo alterado ⇒ checksum no coincide ⇒ null', () => {
    const head = cut(base, base.lastIndexOf('.'));
    const body = base.slice(5, base.lastIndexOf('.'));
    const flip = body[0] === 'A' ? 'B' : 'A';
    expect(unpackRegionSeed(`${head.slice(0, 5)}${flip}${body.slice(1)}${base.slice(base.lastIndexOf('.'))}`)).toBeNull();
  });
  test('checksum alterado ⇒ null', () => {
    const head = base.slice(0, base.lastIndexOf('.'));
    const bad = `${head}.0000000000000000`;
    expect(unpackRegionSeed(bad)).toBeNull();
  });
  test('prefijo alterado ⇒ null', () => {
    expect(unpackRegionSeed(base.replace('MXP1-', 'MXP2-'))).toBeNull();
  });
  test('basura ⇒ null (sin excepciones)', () => {
    for (const s of ['', 'MXP1-', 'MXP1-xxx', 'xx', 'MXP1-....', base.slice(0, 8)]) {
      expect(unpackRegionSeed(s)).toBeNull();
    }
  });
});

describe('MXP1 — hardening #5 (Bundle A): checksum válido pero payload hostil ⇒ null', () => {
  /** Empaqueta un payload ARBITRARIO con checksum SHA-256 v2 RECOMPUTADO (atacante puede). */
  function packHostile(payload: Record<string, unknown>): string {
    const json = JSON.stringify(payload);
    const body = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `MXP1-${body}.${sha256Trunc64(json)}`;
  }
  test('lat no numérico ⇒ null', () => {
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1, lat: 'INJECT', lon: 0, e: 100, b: [] }))).toBeNull();
  });
  test('lat fuera de rango geográfico ⇒ null', () => {
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1, lat: 999, lon: 0, e: 100, b: [] }))).toBeNull();
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1, lat: -91, lon: 0, e: 100, b: [] }))).toBeNull();
  });
  test('lon fuera de rango geográfico ⇒ null', () => {
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1, lat: 0, lon: 181, e: 100, b: [] }))).toBeNull();
  });
  test('seed Infinity ⇒ null', () => {
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1e999, lat: 0, lon: 0, e: 100, b: [] }))).toBeNull();
  });
  test('extent no positivo / no finito ⇒ null', () => {
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1, lat: 0, lon: 0, e: 0, b: [] }))).toBeNull();
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1, lat: 0, lon: 0, e: -5, b: [] }))).toBeNull();
  });
  test('id no string / vacío ⇒ null', () => {
    expect(unpackRegionSeed(packHostile({ v: 2, id: { x: 1 }, s: 1, lat: 0, lon: 0, e: 100, b: [] }))).toBeNull();
    expect(unpackRegionSeed(packHostile({ v: 2, id: '', s: 1, lat: 0, lon: 0, e: 100, b: [] }))).toBeNull();
  });
  test('b no array ⇒ null', () => {
    expect(unpackRegionSeed(packHostile({ v: 2, id: 'x', s: 1, lat: 0, lon: 0, e: 100, b: 'no' }))).toBeNull();
  });
  test('payload legítimo sigue pasando tras el hardening', () => {
    expect(unpackRegionSeed(packRegionSeed(REGIONS[0]))).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* G-2 · Compatibilidad cruzada por respuesta-conocida                 */
/*                                                                     */
/* El sha256.ts/seedpack.ts actuales son RE-IMPLEMENTACIONES (Task 37,  */
/* tras el rollback). Si no reprodujeran los checksums históricos, las  */
/* semillas MXP1 ya distribuidas quedarían HUÉRFANAS (prioridad-0).     */
/* Resultado 2026-09-26: los reproducen byte a byte ⇒ compatibilidad    */
/* cruzada demostrada. Se pinean además las 2 regiones restantes como   */
/* extensión del fingerprint (registro de hoy, no pins históricos).     */
/* ------------------------------------------------------------------ */

describe('MXP1 — compatibilidad cruzada por respuesta-conocida (G-2)', () => {
  /** Pins HISTÓRICOS (registro del propietario, linaje T26–T31 pre-rollback). */
  const PINS_HISTORICOS: [string, string, number][] = [
    ['soledad', 'e0b19c08b20f5a18', 240],
    ['bufa', '8b8d6b54c3a9aa4c', 202],
  ];
  /** Pins de extensión (registrados 2026-09-26, misma sesión G-2). */
  const PINS_EXTENSION: [string, string, number][] = [
    ['esperanza', '88e6b5741ae92a87', 212],
    ['santarosa', 'b00e513ed77e6923', 234],
  ];

  function assertPin(id: string, checksum: string, len: number): void {
    const region = REGIONS.find((r) => r.id === id)!;
    const seed = packRegionSeed(region);
    expect(seed.length).toBe(len);
    expect(seed.split('.')[1]).toBe(checksum);
    const info = unpackRegionSeed(seed);
    expect(info !== null && info.version === 2 && info.id === id).toBe(true);
    expect(packRegionSeed(region)).toBe(seed); // determinismo byte a byte
  }

  test('pins históricos reproducidos por la re-implementación (semillas NO huérfanas)', () => {
    for (const [id, checksum, len] of PINS_HISTORICOS) assertPin(id, checksum, len);
  });

  test('pins de extensión registrados hoy (fingerprint completo de las 4 regiones)', () => {
    for (const [id, checksum, len] of PINS_EXTENSION) assertPin(id, checksum, len);
  });
});
