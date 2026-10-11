/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-7 — GPS BAJO DEMANDA (contrato v1 + invariantes I-1..I-6).
 * Spec: docs/fr-specs/FR-7-gps-ggm25-contexto.md §8 (A-1..A-7, A-9; A-8 marcador
 * de motor queda registrado en bitácora de ingeniería del hito). W3 rige: geolocation SOLO en
 * src/lib/gps y SOLO tras acción explícita. 0 red, 0 GPU, 0 persistencia.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  gpsController,
  useGpsState,
} from '@/lib/gps/gpsController';
import { fixToSceneM } from '@/lib/gps/scene';
import { gpsFixturesSinteticos, desvioRoundTripWgs84Utm } from '@/lib/gps/verify';
import { GPS_TIMEOUT_SIN_SENAL_MS, GPS_UMBRAL_DEGRADE_M } from '@/lib/gps/types';

const RAIZ = join(import.meta.dir, '..');
const SRC = join(RAIZ, 'src');

/* ---------- A-1 (W3) · geolocation SOLO en src/lib/gps ---------- */
function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...archivosTs(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe('FR-7 · A-1 (W3) — frontera de geolocation', () => {
  test('toda mención de geolocation (en CÓDIGO) vive SOLO en src/lib/gps/', () => {
    const hits: string[] = [];
    for (const f of archivosTs(SRC)) {
      /* ENMIENDA documentada (E2E dorado air-gap, ): los
         HOSTS DE QA bajo src/app/e2e/ MOCKEAN el sensor (patrón A-2 — fuente
         de geolocation INYECTABLE; los forenses hacen lo mismo desde tests/).
         La frontera de PRODUCTO sigue siendo dura: cualquier archivo fuera de
         src/lib/gps/ y de src/app/e2e/ que mencione geolocation FALLA aquí. */
      if (f.replace(/\\/g, '/').includes('/src/app/e2e/')) continue;
      // Lección A-7: se audita código sin prosa — los docblocks EXPLICAN la
      // frontera y mencionan la palabra («0 llamadas a geolocation aquí»).
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (src.includes('geolocation')) {
        hits.push(f);
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.replace(/\\/g, '/')).toContain('/src/lib/gps/');
    }
  });

  test('arranque limpio: page/layout/ingest no mencionan geolocation', () => {
    for (const rel of ['src/app/page.tsx', 'src/app/layout.tsx', 'src/components/terrain/ingest.ts']) {
      const src = readFileSync(join(RAIZ, rel), 'utf8');
      expect(src.includes('geolocation')).toBe(false);
    }
  });
});

/* ---------- A-2 · ciclo de vida con mock de geolocation ---------- */
type MockFix = { latitude: number; longitude: number; accuracy: number };
interface MockGeo {
  watchers: Array<{ id: number; ok: (p: { coords: MockFix; timestamp: number }) => void; err: (e: { code: number }) => void }>;
  cleared: number[];
  nextId: number;
}

function instalarMockGeo(): MockGeo {
  const mock: MockGeo = { watchers: [], cleared: [], nextId: 100 };
  const geo = {
    watchPosition: (
      ok: (p: { coords: MockFix; timestamp: number }) => void,
      err: (e: { code: number }) => void
    ): number => {
      const id = mock.nextId++;
      mock.watchers.push({ id, ok, err });
      return id;
    },
    clearWatch: (id: number): void => {
      mock.cleared.push(id);
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { ...(globalThis.navigator ?? {}), geolocation: geo },
  });
  return mock;
}

function quitarMockGeo(): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
}

const SOLEDAD_ANCLA = { centerLat: 21.0518, centerLon: -101.3348, extentM: 6400 };

describe('FR-7 · A-2 — ciclo de vida (mock geolocation)', () => {
  beforeEach(() => {
    quitarMockGeo();
    gpsController.requestStop();
  });
  afterEach(() => {
    gpsController.requestStop();
  });

  test('requestStart crea 1 watch ⇒ fix ≤25 m ⇒ activo «±N m»; requestStop limpia y descarta en vuelo', () => {
    const mock = instalarMockGeo();
    gpsController.setAnchor(SOLEDAD_ANCLA); // el viewer aporta el Anchor (contrato)
    expect(gpsController.getState().status).toBe('inactivo');

    gpsController.requestStart();
    let st = gpsController.getState();
    expect(mock.watchers.length).toBe(1); // máx. 1 watch vivo (contrato v1)
    expect(st.watchId).toBe(100);
    expect(st.status).toBe('adquiriendo');

    // Primer fix bueno (≤ 25 m) — dentro de la región (offset 120,40 m).
    mock.watchers[0].ok({ coords: { latitude: 21.0518 + 40 / 110574, longitude: -101.3348 + 120 / (111320 * Math.cos(21.0518 * Math.PI / 180)), accuracy: 6.2 }, timestamp: 1 });
    st = gpsController.getState();
    expect(st.status).toBe('activo');
    expect(st.fix?.accuracyM).toBe(7); // techo de 6.2 (P-3: siempre ±N m)
    expect(st.etiquetaCorta).toBe('GPS activo ±7 m');
    expect(st.dentroDeRegion).toBe(true);

    // requestStop: clearWatch con ESE id + estado inactivo.
    gpsController.requestStop();
    st = gpsController.getState();
    expect(mock.cleared).toEqual([100]);
    expect(st.status).toBe('inactivo');
    expect(st.fix).toBeNull();
    expect(st.watchId).toBeNull();

    // Fix EN VUELO posterior al stop ⇒ descartado (P-2, 0 cambios de estado).
    const antes = gpsController.getState();
    mock.watchers[0].ok({ coords: { latitude: 21.06, longitude: -101.34, accuracy: 5 }, timestamp: 2 });
    expect(gpsController.getState()).toEqual(antes);
  });

  test('fix >25 m ⇒ degradado con precisión visible (P-3)', () => {
    const mock = instalarMockGeo();
    gpsController.setAnchor(SOLEDAD_ANCLA);
    gpsController.requestStart();
    mock.watchers[0].ok({ coords: { latitude: 21.0518, longitude: -101.3348, accuracy: 80.4 }, timestamp: 3 });
    const st = gpsController.getState();
    expect(st.status).toBe('degradado');
    expect(st.etiquetaCorta).toBe('GPS (pobre) ±81 m');
  });

  test('denegado es terminal-accionable y SIN coordenadas (P-4/I-1); error para código 2', () => {
    const mock = instalarMockGeo();
    gpsController.requestStart();
    mock.watchers[0].err({ code: 1 });
    expect(gpsController.getState().status).toBe('denegado');
    expect(gpsController.getState().lastError).toContain('ajustes');
    gpsController.requestStop();

    gpsController.requestStart();
    mock.watchers[1].err({ code: 2 });
    expect(gpsController.getState().status).toBe('error');
  });

  test('sin geolocation ⇒ no-disponible (feature-detect honesto)', () => {
    quitarMockGeo();
    gpsController.requestStart();
    expect(gpsController.getState().status).toBe('no-disponible');
  });
});

/* ---------- A-3/A-4 · estados y honestidad ---------- */
describe('FR-7 · A-3/A-4 — máquina de estados y honestidad contractual', () => {
  test('las 9 etiquetas de §3.2 existen en la tabla de la máquina', () => {
    const src = readFileSync(join(RAIZ, 'src/lib/gps/gpsController.ts'), 'utf8');
    for (const e of [
      'inactivo', 'solicitando', 'adquiriendo', 'activo', 'degradado',
      'sin-senal', 'denegado', 'error', 'no-disponible',
    ]) {
      expect(src.includes(`'${e}'`)).toBe(true);
    }
    expect(GPS_TIMEOUT_SIN_SENAL_MS).toBe(12_000);
    expect(GPS_UMBRAL_DEGRADE_M).toBe(25);
  });

  test('A-4 · ninguna precisión prometida fija en el código (siempre ±accuracyM real)', () => {
    const src = readFileSync(join(RAIZ, 'src/lib/gps/gpsController.ts'), 'utf8');
    expect(src).toContain('Math.ceil(accuracy)'); // techo del reporte del dispositivo
    expect(src).not.toMatch(/±\s*\d+\s*m/); // sin «±6 m» hardcodeado
  });
});

/* ---------- A-5/A-6/A-7 · invariantes de privacidad ---------- */
describe('FR-7 · I-1/I-2/I-3 — privacidad del fix', () => {
  test('A-5 (I-1) · 0 coordenadas en consola durante un ciclo completo', () => {
    const mock = instalarMockGeo();
    const capturado: unknown[][] = [];
    const orig = { info: console.info, warn: console.warn, error: console.error };
    for (const k of ['info', 'warn', 'error'] as const) {
      console[k] = (...a: unknown[]) => capturado.push(a);
    }
    try {
      gpsController.requestStart();
      mock.watchers[0].ok({ coords: { latitude: 21.05237, longitude: -101.33706, accuracy: 6 }, timestamp: 9 });
      mock.watchers[0].err({ code: 3 });
      gpsController.requestStop();
    } finally {
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
    }
    const texto = JSON.stringify(capturado) ?? '';
    expect(texto).not.toMatch(/21\.0\d+/);
    expect(texto).not.toMatch(/-?101\.3\d+/);
  });

  test('A-6 (I-2) · src/lib/gps sin fetch, sin /api, sin almacenamiento', () => {
    for (const f of archivosTs(join(RAIZ, 'src/lib/gps'))) {
      const src = readFileSync(f, 'utf8');
      expect(src.includes('fetch(')).toBe(false);
      expect(src.includes('/api/')).toBe(false);
      expect(src).not.toMatch(/localStorage|indexedDB|sessionStorage/);
    }
  });

  test('A-7 (I-3/W1) · 0 coordenadas reales hardcodeadas en src/lib/gps', () => {
    // Los únicos literales decimales permitidos: constantes métricas de la casa.
    for (const f of archivosTs(join(RAIZ, 'src/lib/gps'))) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const pares = src.match(/-?\d+\.\d{5,}/g) ?? [];
      for (const p of pares) {
        // Permitidos SOLO los factores métricos y umbrales (no parecen lat/lon de región).
        expect(['110574', '111320'].some((k) => p.startsWith(k) || p.includes(k))).toBe(true);
      }
    }
  });
});

/* ---------- scene.ts + A-9 (V-1) · determinismo y round-trip ---------- */
describe('FR-7 · scene.ts (pura) y V-1 round-trip', () => {
  test('mapeo equirectangular determinista con dentro/fuera de región (§5.1)', () => {
    const centro = fixToSceneM(21.0518, -101.3348, SOLEDAD_ANCLA);
    expect(centro).toEqual({ xM: 0, yM: 0, dentro: true });
    // 120 m al este (misma convención que el test de ciclo de vida).
    const este = fixToSceneM(
      21.0518,
      -101.3348 + 120 / (111320 * Math.cos(21.0518 * Math.PI / 180)),
      SOLEDAD_ANCLA
    );
    expect(este.dentro).toBe(true);
    expect(este.xM).toBeCloseTo(120, 6);
    // Lejos ⇒ fuera de región (el marcador JAMÁS se dibuja fuera del lienzo).
    const fuera = fixToSceneM(21.4, -101.9, SOLEDAD_ANCLA);
    expect(fuera.dentro).toBe(false);
    // Determinismo: misma entrada ⇒ mismo objeto (JSON igual).
    expect(JSON.stringify(fixToSceneM(21.0518, -101.3348, SOLEDAD_ANCLA)))
      .toBe(JSON.stringify({ xM: 0, yM: 0, dentro: true }));
  });

  test('A-9 (V-1) · fixtures sintéticos Soledad: round-trip WGS84⇄UTM14N ≤ 1e-6°', () => {
    const fixes = gpsFixturesSinteticos(21.0518, -101.3348);
    expect(fixes.length).toBe(5);
    const { maxDesvioGrados, pares } = desvioRoundTripWgs84Utm(fixes);
    expect(pares.every((p) => p.ok)).toBe(true);
    expect(maxDesvioGrados).toBeLessThan(1e-6);
  });

  test('contrato v1: useGpsState exportado y hook del SLOT (montaje único, sin auto-activación)', () => {
    expect(typeof useGpsState).toBe('function');
    const src = readFileSync(join(RAIZ, 'src/lib/gps/gpsController.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // lección A-7: código sin prosa
    expect(src).toContain('requestStart = (): void');
    expect(src).toContain('requestStop = (): void');
    // P-1 por construcción: NINGUNA llamada requestStart() en el propio módulo
    // (el disparo vive en handlers de interacción del chrome del SLOT).
    expect(src.match(/requestStart\(\)/g)?.length ?? 0).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* PUERTO D-1 — GPS-ORTO (gps/orto.ts): reglas FR-7 + consistencia     */
/* ±1.0 m + demo FR-W1 + altitud del chip. Núcleo del linaje local     */
/* (custodia ventana-local-task47) adaptado a la bóveda: geoid vía     */
/* src/lib/ingest/geoid.ts (NaN-semantics), escena vía fixToSceneM,    */
/* MDT vía sampler inyectado (procedural o DEM REAL del CEM).          */
/* ------------------------------------------------------------------ */
import { parseBilGeoid, undulation, type GeoidModel } from '@/lib/ingest/geoid';
import {
  resolveCota,
  curvasConsistency,
  simulateFixAt,
  LAB_TOLERANCE_M,
  DATUM_ELLIPSOIDAL,
  type ZSampler,
} from '@/lib/gps/orto';

/** Modelo sintético 4×4 con N constante (referencia pública de la golden
 *  de la Soledad: −11.23 m) cubriendo el ancla sintética del archivo. */
const GEOID_W = 4;
const GEOID_DX = 0.01;
const GEOID_ULX = -101.35;
const GEOID_ULY = 21.08;
const N_CONST = -11.23;

function modeloGeoidSinNodata(): GeoidModel {
  const hdr = [
    'BYTEORDER      I',
    'LAYOUT         BIL',
    `NROWS          ${GEOID_W}`,
    `NCOLS          ${GEOID_W}`,
    'NBANDS         1',
    'NBITS          32',
    `XDIM           ${GEOID_DX}`,
    `YDIM           ${GEOID_DX}`,
    `ULXMAP         ${GEOID_ULX}`,
    `ULYMAP         ${GEOID_ULY}`,
    'NODATA         -nan',
    '',
  ].join('\n');
  const bil = new Uint8Array(GEOID_W * GEOID_W * 4);
  const dv = new DataView(bil.buffer);
  for (let k = 0; k < GEOID_W * GEOID_W; k++) dv.setFloat32(k * 4, N_CONST, true);
  const r = parseBilGeoid(new TextEncoder().encode(hdr), bil, null, 'GGM25-demo');
  if (!r.ok) throw new Error(`fixture geoid debía parsear: ${r.reason}`);
  return r.model;
}

function samplerDe(z: number | null): ZSampler {
  return () => z;
}

function toSceneDe(dentro: boolean): (lon: number, lat: number) => { xM: number; yM: number; dentro: boolean } {
  return () => ({ xM: 100, yM: 200, dentro });
}

const FIX_BASE = {
  lat: 21.0518,
  lon: -101.3348,
  accuracyM: 5,
  timestampMs: 0,
  altitudeAccuracyM: null,
};

describe('FR-7 · PUERTO D-1 — GPS-ORTO (orto.ts): reglas FR-7, ±1.0 m, demo FR-W1', () => {
  test('resolveCota · sin altitud del chip ⇒ cota null honesta (jamás horneada)', () => {
    const r = resolveCota({ ...FIX_BASE, altitudeM: null, source: 'chip' }, null);
    expect(r.cota).toBeNull();
    expect(r.datum).toBe(DATUM_ELLIPSOIDAL);
    expect(r.n).toBeNull();
    expect(r.note).toContain('no reportó altitud');
  });

  test('resolveCota · geoid NO activo ⇒ cota elipsoidal DECLARADA, sin conversión (FR-7)', () => {
    const r = resolveCota({ ...FIX_BASE, altitudeM: 2036.5, source: 'chip' }, null);
    expect(r.cota).toBe(2036.5); // SIN conversión — el valor elipsoidal íntegro
    expect(r.datum).toBe(DATUM_ELLIPSOIDAL);
    expect(r.n).toBeNull();
    expect(r.note).toContain('SIN conversión');
  });

  test('resolveCota · geoid activo + en cobertura ⇒ H = h − N con datum del MODELO', () => {
    const m = modeloGeoidSinNodata();
    const h = 2036.5;
    const r = resolveCota({ ...FIX_BASE, altitudeM: h, source: 'chip' }, m);
    /* El BIL es Float32: el N almacenado es f32(−11.23) — la comparación es
       contra el valor efectivo del modelo (honesto, no el literal f64). */
    const N32 = new Float32Array([N_CONST])[0];
    const n = undulation(m, FIX_BASE.lat, FIX_BASE.lon);
    expect(n).toBe(N32);
    expect(r.cota).toBe(h - N32);
    expect(r.datum).toBe('GGM25-demo (ortométrica)');
    expect(r.n).toBe(N32);
    expect(r.note).toContain('H = h − N');
  });

  test('resolveCota · fuera de cobertura del geoide ⇒ elipsoidal declarada (honesto)', () => {
    const m = modeloGeoidSinNodata();
    const r = resolveCota({ ...FIX_BASE, lat: 41, lon: -99, altitudeM: 2036.5, source: 'chip' }, m);
    expect(r.cota).toBe(2036.5);
    expect(r.datum).toBe(DATUM_ELLIPSOIDAL);
    expect(r.n).toBeNull();
    expect(r.note).toContain('fuera de cobertura');
  });

  test('curvasConsistency · ±1.0 m declarado: 0.5 ok · 1.01 excede · bandas de curva', () => {
    const ok = curvasConsistency(samplerDe(2100), 0, 0, 2100.5);
    expect(ok.ok).toBe(true);
    expect(ok.delta).toBeCloseTo(0.5, 10);
    expect(ok.bandDem).toBe(2100);
    expect(ok.bandCota).toBe(2100);
    expect(ok.tolM).toBe(LAB_TOLERANCE_M);
    expect(LAB_TOLERANCE_M).toBe(1.0); // el valor del checkpoint, declarado

    const limite = curvasConsistency(samplerDe(2100), 0, 0, 2101.0);
    expect(limite.ok).toBe(true); // |Δ| ≤ tol (banda inclusiva)

    const excede = curvasConsistency(samplerDe(2100), 0, 0, 2101.01);
    expect(excede.ok).toBe(false);
    expect(excede.reason).toContain('excede');
    expect(excede.bandCota).toBe(2101);
  });

  test('curvasConsistency · fix fuera del MDT ⇒ null honesto (jamás clamp al borde)', () => {
    const r = curvasConsistency(samplerDe(null), 0, 0, 2100);
    expect(r.ok).toBe(false);
    expect(r.zDem).toBeNull();
    expect(r.delta).toBeNull();
    expect(r.bandDem).toBeNull();
    expect(r.reason).toContain('fuera del MDT');
  });

  test('simulateFixAt · round-trip FR-W1: h = z + N ⇒ resolveCota regresa a z (Δ ≈ 0)', () => {
    const m = modeloGeoidSinNodata();
    const z = 2123.456;
    const fix = simulateFixAt(-101.3348, 21.0518, samplerDe(z), toSceneDe(true), m);
    expect(fix).not.toBeNull();
    expect(fix?.source).toBe('simulacion'); // SIEMPRE etiquetada
    const r = resolveCota(fix!, m);
    expect(r.cota).not.toBeNull();
    expect(r.cota!).toBeCloseTo(z, 9); // la conversión regresa a z_MDT
    expect(Math.abs(r.cota! - z)).toBeLessThanOrEqual(LAB_TOLERANCE_M);
  });

  test('simulateFixAt · sin geoid ⇒ h = z (elipsoidal demo) · fuera ⇒ null honesto', () => {
    const z = 2123.456;
    const f1 = simulateFixAt(-101.3348, 21.0518, samplerDe(z), toSceneDe(true), null);
    expect(f1?.altitudeM).toBe(z);
    expect(simulateFixAt(-101.3348, 21.0518, samplerDe(z), toSceneDe(false), null)).toBeNull();
    expect(simulateFixAt(-101.3348, 21.0518, samplerDe(null), toSceneDe(true), null)).toBeNull();
    // Con geoid pero fuera de su cobertura ⇒ null (no se inventa N).
    const m = modeloGeoidSinNodata();
    expect(simulateFixAt(21, -99, samplerDe(z), toSceneDe(true), m)).toBeNull();
  });

  test('controller · altitud del chip capturada (W3C altitude); ausente ⇒ null (D-1)', () => {
    const mock: {
      watchers: Array<{ id: number; ok: (p: { coords: Record<string, unknown>; timestamp: number }) => void }>;
      nextId: number;
    } = { watchers: [], nextId: 900 };
    const geo = {
      watchPosition: (ok: (p: { coords: Record<string, unknown>; timestamp: number }) => void): number => {
        mock.watchers.push({ id: mock.nextId, ok });
        return mock.nextId++;
      },
      clearWatch: () => {},
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { ...(globalThis.navigator ?? {}), geolocation: geo },
    });
    try {
      gpsController.requestStop();
      gpsController.setAnchor(SOLEDAD_ANCLA);
      gpsController.requestStart();
      // Fix CON altitud elipsoidal ⇒ capturada íntegra (fuente 'chip').
      mock.watchers[0].ok({
        coords: {
          latitude: 21.0518,
          longitude: -101.3348,
          accuracy: 5,
          altitude: 2036.5,
          altitudeAccuracy: 8,
        },
        timestamp: 1,
      });
      let st = gpsController.getState();
      expect(st.fix?.altitudeM).toBe(2036.5);
      expect(st.fix?.altitudeAccuracyM).toBe(8);
      expect(st.fix?.source).toBe('chip');

      // Fix SIN altitud ⇒ null honesto (jamás 0 ni valor horneado).
      mock.watchers[0].ok({
        coords: { latitude: 21.0518, longitude: -101.3348, accuracy: 5, altitude: null },
        timestamp: 2,
      });
      st = gpsController.getState();
      expect(st.fix?.altitudeM).toBeNull();
    } finally {
      gpsController.requestStop();
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    }
  });

  test('inyectarFixDemo · canal FR-W1: guard honesto + etiqueta de simulación + stop limpia', () => {
    gpsController.requestStop();
    gpsController.setAnchor(SOLEDAD_ANCLA);
    // Guard: un fix 'chip' jamás entra por el canal de demo.
    gpsController.inyectarFixDemo({ ...FIX_BASE, altitudeM: 2100, source: 'chip' });
    expect(gpsController.getState().fix).toBeNull();

    // Fix de laboratorio ⇒ entra, etiquetado como demo (P-3/I-1 honestos).
    gpsController.inyectarFixDemo({
      ...FIX_BASE,
      altitudeM: 2123.456,
      source: 'simulacion',
    });
    const st = gpsController.getState();
    expect(st.status).toBe('activo');
    expect(st.etiquetaCorta).toContain('demo (FR-W1)');
    expect(st.fix?.source).toBe('simulacion');
    expect(st.watchId).toBeNull(); // ningún watch del sensor

    // requestStop limpia la demo (estado inactivo, fix null).
    gpsController.requestStop();
    expect(gpsController.getState().status).toBe('inactivo');
    expect(gpsController.getState().fix).toBeNull();
  });
});
