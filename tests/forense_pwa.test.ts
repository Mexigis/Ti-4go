/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Suite forense FR-8 — PWA OFFLINE (SW vanilla · custodia · actualización honesta).
 * Spec: docs/fr-specs/FR-8-9-pwa-benchmark.md §3 (contrato de aceptación A8-1..A8-6,
 * gates P2-1/P2-3/P2-4). Auditoría ESTÁTICA del código fuente — 0 red, 0 GPU (W5):
 *
 *   A8-1/A8-5  sw.js lleva los tokens de custodia (__CACHE_PIN__/__PRECACHE__) que
 *              el build air-gap inyecta; presupuesto ≤ 60 archivos / ≤ 25 MB (R2)
 *              documentado en el SW y dureno en el script.
 *   A8-3       Firewall de caché: /api/**, cross-origin y no-GET NUNCA se
 *              interceptan; la whitelist no incluye nada de misión real (W1/W3/W4).
 *   A8-4       Actualización honesta: skipWaiting SOLO vía mensaje del banner;
 *              SIN clients.claim(); recarga ÚNICA tras consentimiento; 0 timers.
 *   W2         0 dependencias nuevas (sin workbox/next-pwa/importScripts).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = join(import.meta.dir, '..');
/* Auditoría sobre CÓDIGO, no sobre prosa (lección A-7: los docblocks mencionan
   lo que prohíben — se audita la fuente SIN comentarios). */
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const swSrc = readFileSync(join(RAIZ, 'public/sw.js'), 'utf8');
const swCode = sinComentarios(swSrc);
const registerSrc = readFileSync(join(RAIZ, 'src/lib/pwa/register.ts'), 'utf8');
const custodiaSrc = readFileSync(join(RAIZ, 'src/lib/pwa/custodia.ts'), 'utf8');
const bannerSrc = readFileSync(join(RAIZ, 'src/components/terrain/UpdateBanner.tsx'), 'utf8');
const manifestSrc = readFileSync(join(RAIZ, 'src/app/manifest.ts'), 'utf8');
const buildSrc = readFileSync(join(RAIZ, 'scripts/build_airgap.sh'), 'utf8');
const pkgRaw = readFileSync(join(RAIZ, 'package.json'), 'utf8');

describe('FR-8 · PWA offline — SW vanilla (public/sw.js)', () => {
  test('W2 · 0 dependencias: sin importScripts, sin imports/exports ES, sin workbox', () => {
    expect(swSrc).not.toMatch(/importScripts\s*\(/);
    expect(swSrc).not.toMatch(/(^|\n)\s*(import|export)\s/);
    expect(swSrc.toLowerCase()).not.toContain('workbox');
  });

  test('A8-1/A8-5 · contrato de custodia: tokens __CACHE_PIN__ y __PRECACHE__ + cache ti4go-a-<pin>', () => {
    expect(swSrc).toContain('__CACHE_PIN__');
    expect(swSrc).toContain('__PRECACHE__');
    expect(swSrc).toContain("'ti4go-a-__CACHE_PIN__'");
    expect(swSrc).toContain("var CACHE_PREFIX = 'ti4go-a-';");
  });

  test('A8-3 · firewall: /api/, cross-origin y no-GET NUNCA interceptados (return temprano)', () => {
    const fetchIdx = swSrc.indexOf("self.addEventListener('fetch'");
    expect(fetchIdx).toBeGreaterThan(-1);
    const fetchBody = swSrc.slice(fetchIdx);
    const apiGuard = fetchBody.indexOf("url.pathname.indexOf('/api/') === 0) return;");
    const corsGuard = fetchBody.indexOf('url.origin !== self.location.origin) return;');
    const methodGuard = fetchBody.indexOf("req.method !== 'GET') return;");
    const firstRespondWith = fetchBody.indexOf('respondWith');
    expect(methodGuard).toBeGreaterThan(-1);
    expect(corsGuard).toBeGreaterThan(-1);
    expect(apiGuard).toBeGreaterThan(-1);
    // Los tres guards preceden a CUALQUIER respondWith dentro del handler.
    expect(methodGuard).toBeLessThan(firstRespondWith);
    expect(corsGuard).toBeLessThan(firstRespondWith);
    expect(apiGuard).toBeLessThan(firstRespondWith);
  });

  test('A8-3/W1 · whitelist estricta: nada de misión real — solo shell/static/logo/manifest/custodia/fixtures .tif', () => {
    expect(swSrc).toMatch(/_next\/static\//);
    expect(swSrc).toMatch(/\.tif\$/);
    expect(swSrc).not.toMatch(/\.zip|\.kml|\.shp|\.dwg/i); // ingesta de usuario: JAMÁS
    expect(swSrc).not.toMatch(/geolocation|GPS|indexedDB|localStorage/i); // W3: sin posiciones ni storage extra
  });

  test('A8-4 · actualización honesta: skipWaiting ejecutable SOLO por mensaje; 0 clients.claim; 0 timers', () => {
    // Lección A-7: se audita la LLAMADA en código sin comentarios.
    expect(swCode.match(/self\.skipWaiting\(\)/g)?.length ?? 0).toBe(1);
    expect(swCode).toContain("event.data.type === 'SKIP_WAITING'");
    expect(swCode).not.toContain('clients.claim');
    expect(swCode).not.toMatch(/setInterval|setTimeout/);
  });

  test('A8-1 · purga de cachés de pins viejos en activate (custodia continua offline↔repo)', () => {
    const actIdx = swSrc.indexOf("self.addEventListener('activate'");
    const actBody = swSrc.slice(actIdx, swSrc.indexOf("self.addEventListener('fetch'"));
    expect(actBody).toContain('caches.delete(k)');
    expect(actBody).toContain('k !== CACHE');
  });

  test('R2 · presupuesto duro ≤ 60 archivos / ≤ 25 MB documentado en el SW y dureno en el build', () => {
    expect(swSrc).toMatch(/≤ 60 archivos \/ ≤ 25 MB/);
    expect(buildSrc).toContain('-gt 60');
    expect(buildSrc).toContain('25 * 1024 * 1024');
    expect(buildSrc).toContain('custodia.json');
    expect(buildSrc).toContain('__CACHE_PIN__');
  });
});

describe('FR-8 · registro y banner honestos', () => {
  test('R4 · registro solo producción: dev ⇒ null (guard NODE_ENV), sin tocar el motor', () => {
    expect(registerSrc).toContain("process.env.NODE_ENV !== 'production'");
    expect(registerSrc).toContain("navigator.serviceWorker.register('/sw.js')");
  });

  test('A8-4 · recarga ÚNICA y consentida: controllerchange {once} armado SOLO en applyUpdate', () => {
    const implIdx = registerSrc.indexOf('applyUpdate(): void {'); // implementación, no interfaz
    const implBody = registerSrc.slice(implIdx, registerSrc.indexOf('dispose(): void {'));
    expect(implBody).toContain("{ type: 'SKIP_WAITING' }");
    expect(implBody).toContain('once: true');
    expect(implBody).toContain('onControllerChange'); // la recarga vive SOLO ahí
    // La ÚNICA definición de recarga del archivo vive en onControllerChange
    // (definido antes de applyUpdate, que es quien lo arma con once).
    expect(registerSrc.match(/location\.reload/g)?.length ?? 0).toBe(1);
    const reloadIdx = registerSrc.indexOf('location.reload()');
    const defIdx = registerSrc.indexOf('const onControllerChange');
    const applyIdx2 = registerSrc.indexOf('applyUpdate(): void {');
    expect(reloadIdx).toBeGreaterThan(defIdx);
    expect(reloadIdx).toBeLessThan(applyIdx2);
    expect(registerSrc).not.toMatch(/setInterval|setTimeout/);
  });

  test('A8-4 · banner: sin auto-recarga, aria-live, textos sin tecnicismos, targets ≥44px', () => {
    expect(bannerSrc).not.toContain('location.reload'); // recarga solo via handle.applyUpdate
    expect(bannerSrc).not.toMatch(/setInterval|setTimeout/);
    expect(bannerSrc).toContain('aria-live="polite"');
    expect(bannerSrc).toContain('Nueva versión del visor lista');
    expect(bannerSrc).toContain('Recargar ahora');
    expect(bannerSrc).toContain('Más tarde');
    expect(bannerSrc).toMatch(/h-11/); // 44 px (R-2)
  });
});

describe('FR-8 · custodia embebida y manifiesto', () => {
  test('S6 · custodia.ts: forma de 4 campos y null honesto (sin throw, sin pin inventado)', () => {
    expect(custodiaSrc).toContain('interface Custodia');
    for (const campo of ['pin', 'head', 'stampUtc', 'generator']) {
      expect(custodiaSrc).toMatch(new RegExp(`${campo}: string`));
    }
    expect(custodiaSrc.match(/return null/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test('S1 · manifest.ts: standalone, start_url local, icono de la casa, 0 URLs externas', () => {
    expect(manifestSrc).toContain("display: 'standalone'");
    expect(manifestSrc).toContain("start_url: '/'");
    expect(manifestSrc).toContain("'/logo.svg'");
    expect(manifestSrc).not.toMatch(/http:\/\/|https:\/\//);
  });

  test('W2 · package.json sin dependencias PWA nuevas (workbox/next-pwa RECHAZADOS)', () => {
    expect(pkgRaw.toLowerCase()).not.toContain('workbox');
    expect(pkgRaw.toLowerCase()).not.toContain('next-pwa');
  });
});
