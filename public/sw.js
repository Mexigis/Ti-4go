/*
 * Ti-4GO · Service Worker air-gap (FR-8) — vanilla, 0 dependencias (W2).
 * Spec: docs/fr-specs/FR-8-9-pwa-benchmark.md §3.3–§3.7.
 *
 * Contrato:
 *  - install: precachea la lista inyectada por el build (shell + static +
 *    fixtures sintéticas) — presupuesto duro ≤ 60 archivos / ≤ 25 MB (R2),
 *    verificado por scripts/build_airgap.sh; el conteo se loguea (A8-1).
 *    SIN skipWaiting: el SW nuevo queda en waiting hasta el consentimiento
 *    explícito del usuario (actualización honesta, §3.7).
 *  - activate: purga TODA caché ti4go-a-* que no sea el pin actual (custodia
 *    atada al HEAD — repo-manifiesto + línea snapshot). SIN clients.claim():
 *    el control pasa solo tras la recarga consentida.
 *  - fetch: whitelist estricta (§3.4) — navegación y shell cache-first;
 *    miss en whitelist ⇒ red SIN escribir caché; /api/**, cross-origin y
 *    no-GET NUNCA se interceptan (A8-3, firewall de caché W1).
 *  - message: SKIP_WAITING solo desde el click del banner (UpdateBanner).
 *
 * En dev este archivo NO se registra (registerSw ⇒ null — R4).
 */
'use strict';

/* Inyectados por scripts/build_airgap.sh (custodia atada al pin del HEAD):
   __CACHE_PIN__  → pin corto (12 hex) del HEAD.
   __PRECACHE__   → JSON array de rutas relativas al origen del artefacto. */
var CACHE = 'ti4go-a-__CACHE_PIN__';
var PRECACHE = __PRECACHE__;

var CACHE_PREFIX = 'ti4go-a-';

/* Whitelist estricta (spec §3.4). Lo NO listado: network-only, sin caché. */
function whitelisted(pathname) {
  if (pathname === '/sw.js') return false; /* el propio SW se actualiza por red */
  if (pathname === '/' || pathname === '/index.html' || pathname === '/404.html') return true;
  if (pathname.indexOf('/_next/static/') === 0) return true; /* inmutables por hash de contenido */
  if (pathname === '/logo.svg' || pathname === '/manifest.webmanifest' || pathname === '/custodia.json') {
    return true; /* identidad y custodia embebidas (S6) */
  }
  if (/\.tif$/i.test(pathname)) return true; /* fixtures sintéticas — NADA de misión real (W1) */
  return false;
}

/* Install: precache con conteo logueado. */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(PRECACHE).then(function () {
          return caches.keys().then(function (keys) {
            var kits = keys.filter(function (k) {
              return k.indexOf(CACHE_PREFIX) === 0;
            });
            /* A8-1: el conteo instalado = PRECACHE.length (logueado). */
            console.info(
              '[ti4go-sw] precache ' + PRECACHE.length + ' archivos · cache ' + CACHE
            );
            return kits.length;
          });
        });
      })
    /* Sin skipWaiting aquí — actualización honesta (§3.7). */
  );
});

/* Activate: purga de cachés de pins viejos. */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE) return caches.delete(k);
          return undefined;
        })
      );
    })
    /* Sin clients.claim() — el control cambia solo con la recarga consentida. */
  );
});

/* Fetch: whitelist + cache-first (§3.4). Fuera de whitelist: red, SIN caché. */
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; /* no-GET: NUNCA interceptado */
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; /* cross-origin: NUNCA */
  if (url.pathname.indexOf('/api/') === 0) return; /* /api/**: NUNCA (W1, A8-3) */

  /* Navegación: el shell ES el vehículo — cache-first con red como refresco. */
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then(function (hit) {
        return hit || fetch(req);
      })
    );
    return;
  }

  if (!whitelisted(url.pathname)) return; /* red pura, sin escribir caché (R2) */
  event.respondWith(
    caches.match(req).then(function (hit) {
      /* Miss whitelisted ⇒ red SIN cachear (el precache manda; presupuesto R2). */
      return hit || fetch(req);
    })
  );
});

/* Mensaje del banner: única vía hacia skipWaiting (consentimiento explícito). */
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
