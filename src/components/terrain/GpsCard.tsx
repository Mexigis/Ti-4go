/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * GpsCard — GPS-ORTO (FR-7): cota honesta en campo y consistencia contra
 * las curvas del mapa (± tolerancia declarada).
 *
 * PUERTO D-1 (agenda documento interno de reinicio §2.1, 2026-10-02): tarjeta del
 * linaje local (`ventana-local-task47`, custodia `ventana-local-21328b2`)
 * ADAPTADA a la arquitectura de la bóveda:
 *   - Estado GPS: el controlador SINGLETON de la bóveda (`useGpsState()` +
 *     `gpsController`, máquina de 9 estados, P-1/P-2/P-3) — no la máquina
 *     local del linaje (startGps propio).
 *   - Geoid activo: el store de ingesta (`useGeoidModels()`) — no el
 *     registro module-scope del linaje local.
 *   - Reglas FR-7: conversión SOLO con geoid activo y fix en cobertura;
 *     sin geoid ⇒ cota elipsoidal-DECLARADA; sin altitud del chip ⇒
 *     «sin cota» honesto.
 *   - La «Demo laboratorio» (FR-W1) construye un fix simulado con la N
 *     REAL del geoid activo y la z del MDT del lienzo — SIEMPRE etiquetada
 *     como simulación; la validación con dispositivo es la columna FR-9.
 *   - Migas A-8: su toggle vive en la sección Capas del panel (transplante
 *     inverso) — la tarjeta no lo duplica (Surgical Changes).
 */

import { useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { gpsController, useGpsState } from '@/lib/gps/gpsController';
import { fixToSceneM } from '@/lib/gps/scene';
import {
  curvasConsistency,
  resolveCota,
  simulateFixAt,
  LAB_TOLERANCE_M,
  type CotaResult,
  type CurvasCheck,
} from '@/lib/gps/orto';
import type { GeoidModel } from '@/lib/ingest/geoid';
import type { RegionDef } from '@/lib/terrain/regions';
import { useGeoidModels } from './ingest';

function fmtCota(n: number): string {
  return `${n.toLocaleString('es-MX', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} m`;
}

export function GpsCard({
  region,
  sampleZ,
}: {
  /** Región activa (centro + extent) — ancla del fix→escena y de la demo. */
  region: RegionDef;
  /** Muestreo honesto del MDT del lienzo (null fuera del recorte). */
  sampleZ: (xM: number, yM: number) => number | null;
}) {
  const st = useGpsState();
  const geoids = useGeoidModels();
  const model: GeoidModel | null = geoids.length ? geoids[geoids.length - 1].model : null;
  const [simNote, setSimNote] = useState<string | null>(null);
  const encendido = st.status !== 'inactivo';

  /* P-1: requestStart/requestStop SOLO en este handler de click. */
  const toggle = useCallback(() => {
    setSimNote(null);
    if (encendido) gpsController.requestStop();
    else gpsController.requestStart();
  }, [encendido]);

  /** FR-W1: fix simulado — h = z_MDT + N_real; la conversión regresa a z. */
  const runDemo = useCallback(() => {
    gpsController.requestStop(); // la demo no necesita el sensor encendido
    const toScene = (lon: number, lat: number) =>
      fixToSceneM(lat, lon, {
        centerLat: region.centerLat,
        centerLon: region.centerLon,
        extentM: region.extent,
      });
    const lon = region.centerLon + 0.0037;
    const lat = region.centerLat + 0.0029;
    const f = simulateFixAt(lon, lat, sampleZ, toScene, model);
    if (!f) {
      setSimNote('la posición demo cae fuera del MDT o del geoide — sin fix honesto');
      return;
    }
    setSimNote(null);
    gpsController.inyectarFixDemo(f); // canal FR-W1: fuente 'simulacion'
  }, [region, sampleZ, model]);

  const cota: CotaResult | null = useMemo(
    () => (st.fix ? resolveCota(st.fix, model) : null),
    [st.fix, model]
  );

  const check: CurvasCheck | null = useMemo(() => {
    if (!st.fix || !cota || cota.cota === null) return null;
    const pt = fixToSceneM(st.fix.lat, st.fix.lon, {
      centerLat: region.centerLat,
      centerLon: region.centerLon,
      extentM: region.extent,
    });
    if (!pt.dentro) {
      return {
        ok: false,
        zDem: null,
        delta: null,
        tolM: LAB_TOLERANCE_M,
        bandDem: null,
        bandCota: null,
        reason: 'posición fuera del MDT del lienzo',
      };
    }
    return curvasConsistency(sampleZ, pt.xM, pt.yM, cota.cota);
  }, [st.fix, cota, region, sampleZ]);

  const datum = cota?.datum ?? (model ? `${model.name} (ortométrica)` : 'elipsoidal WGS84 (declarada)');

  return (
    <section aria-label="GPS en campo" className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        {/* h2: en la página (h1 header) la tarjeta es sección de 2º nivel —
            axe heading-order (lección D-4 del linaje local). */}
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          GPS · cota en campo (FR-7)
        </h2>
        <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
          {datum}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={encendido ? 'secondary' : 'default'}
          aria-label={encendido ? 'Detener GPS' : 'Activar GPS'}
          onClick={toggle}
          className="min-h-11"
        >
          {encendido ? 'Detener GPS' : 'Activar GPS'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label="Demo laboratorio: fix simulado FR-W1"
          onClick={runDemo}
          className="min-h-11"
        >
          Demo laboratorio
        </Button>
        {model && (
          <Badge
            variant="outline"
            className="border-emerald-500/50 text-emerald-700 dark:text-emerald-500"
          >
            geoide {model.name} activo
          </Badge>
        )}
      </div>

      {(st.status === 'denegado' || st.status === 'error' || st.status === 'no-disponible') && (
        <p role="alert" className="text-[11px] text-destructive">
          GPS no disponible: {st.lastError ?? 'sensor no disponible'}
        </p>
      )}
      {simNote && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-500">
          {simNote}
        </p>
      )}

      {!st.fix && st.status !== 'denegado' && st.status !== 'error' && st.status !== 'no-disponible' && (
        <p className="text-[11px] text-muted-foreground">
          Sin fix. El GPS se activa solo bajo demanda (FR-W3); el chip reporta
          elipsoidal y la conversión a ortométrica ocurre solo con geoid activo.
        </p>
      )}

      {st.fix && cota && (
        <div className="space-y-1.5">
          {st.fix.source === 'simulacion' && (
            <Badge
              variant="outline"
              className="border-amber-500/60 text-amber-700 dark:text-amber-500"
            >
              simulación de laboratorio (FR-W1) — no es un fix de dispositivo
            </Badge>
          )}
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Posición</span>
            <span className="font-mono text-[11px]">
              {Math.abs(st.fix.lat).toFixed(5)}° {st.fix.lat >= 0 ? 'N' : 'S'} ·{' '}
              {Math.abs(st.fix.lon).toFixed(5)}° {st.fix.lon >= 0 ? 'E' : 'W'}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Cota</span>
            <span className="font-mono text-sm font-semibold">
              {cota.cota === null ? 'sin cota del chip' : fmtCota(cota.cota)}
            </span>
          </div>
          {cota.n !== null && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">N (geoide)</span>
              <span className="font-mono text-[11px]">{fmtCota(cota.n)}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Precisión horiz.</span>
            <span className="font-mono text-[11px]">± {st.fix.accuracyM} m</span>
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">{cota.note}</p>
          {check && (
            <p
              role="status"
              className={`text-[11px] ${check.ok ? 'text-emerald-700 dark:text-emerald-500' : 'text-destructive'}`}
            >
              {check.ok ? '✓' : '✗'} curvas del mapa: Δ{' '}
              {(check.delta ?? 0) >= 0 ? '+' : ''}
              {(check.delta ?? 0).toFixed(2)} m · banda {check.bandCota} vs {check.bandDem} · tol ±
              {LAB_TOLERANCE_M.toFixed(1)} m — {check.reason}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
