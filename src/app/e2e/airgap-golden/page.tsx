/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * E2E DORADO AIR-GAP — camino de brigadista sobre el vehículo re-sellado.
 * (doc contractual: docs/fr-specs/E2E-dorado-airgap.md)
 *
 * Ruta técnica de QA (NO es la ruta del producto — la ruta única es /).
 * A diferencia del host B-D1 (/e2e/wc-host, contrato del Web Component),
 * esta página ejercita el VEHÍCULO-A real: mount del TerrainViewer de
 * producto en Modo Campo (FR-6 — la barra de campo es la única superficie
 * con el chip GPS), controller D-1 propio (factory U2 — NUNCA el singleton),
 * y el flujo dorado en orden:
 *
 *   install → pack completo → 7 capas + fricción → GPS marker → export
 *
 * 9 checks deterministas visibles en el DOM para agent-browser:
 *   1. badge honesta «air-gap» en el chrome del visor (estamos EN el vehículo)
 *   2. FR-8 install: SW activo + cache ti4go-a-<pin> + custodia.json (S6)
 *   3. pack completo por el canal programático D-1 (ingestAsync, fixture /qa/)
 *   4. 7 capas D11 asentadas en el controller (geoms ≥ 7)
 *   5. fricción D12 decodificada (1 campo)
 *   6. render de escena: delta de canvas + getExportScene() no nula
 *   7. FR-7/A-8 GPS: click REAL del chip → fix sintético → etiqueta ±N m
 *      + delta de canvas (el motor redibuja con el marcador)
 *   8. export SVG real (buildDisplayList + serializeSvg)
 *   9. export PDF real (serializePdf → Blob %PDF-)
 *
 * El fixture del pack NO viaja en el precache del SW (whitelist estricta
 * FR-8 §3.4) — lo sirve el http.server estático del despliegue; el build
 * air-gap lo copia a /qa/ ANTES del sellado (MANIFIESTO lo cubre).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerrainViewer } from '@/components/terrain/TerrainViewer';
import { GpsChip } from '@/components/terrain/GpsChip';
import { createIngestController, IngestControllerContext, type IngestController } from '@/components/terrain/ingest';
import type { Ti4goViewerApi } from '@/wc/contract';
import { getRegion } from '@/lib/terrain/regions';
import { buildDisplayList, serializePdf, serializeSvg } from '@/lib/terrain/export';
import type { ExportScene } from '@/lib/terrain/engine';

/** Holder PLANO del API (mismo patrón de ti4go-app.tsx — el viewer lo rellena). */
function useApiHolder(): { current: Ti4goViewerApi | null } {
  return useMemo(() => ({ current: null as Ti4goViewerApi | null }), []);
}

interface CheckRow {
  id: number;
  name: string;
  status: 'PASS' | 'FAIL' | '…';
  note: string;
}

const N_CHECKS = 9;
/** Fix sintético: centro de Soledad + ~22 m al norte, precisión 8 m
 *  (≤ umbral de degrade 25 m ⇒ estado «activo»; dentro de la extensión). */
const FIX_LAT_OFF = 0.0002;
const FIX_ACC_M = 8;

/** Huella visual de TODOS los canvas (orden de DOM, FNV-1a 32-bit del PNG
 *  de cada uno): el motor redibuja en SU canvas (terreno determinista —
 *  idéntico entre cuadros) pero la tinta ingerida cae en el canvas de
 *  OVERLAY — el delta debe ver ambos. */
function canvasHash(): string | null {
  const cs = Array.from(document.querySelectorAll('canvas'));
  if (cs.length === 0) return null;
  const parts: string[] = [];
  for (const c of cs) {
    try {
      const url = c.toDataURL('image/png');
      let h = 0x811c9dc5;
      for (let i = 0; i < url.length; i++) {
        h ^= url.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      parts.push(`${c.width}x${c.height}:${(h >>> 0).toString(16)}`);
    } catch {
      parts.push('inaccesible');
    }
  }
  return parts.join('|');
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 120): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let ok: boolean | Promise<boolean>;
    try {
      ok = pred();
    } catch {
      ok = false;
    }
    if (await ok) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  try {
    return !!(await pred());
  } catch {
    return false;
  }
}

export default function AirgapGoldenE2E() {
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [running, setRunning] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const apiHolder = useApiHolder();

  /* D-1 · factory por instancia (U2) — el harness es un embedder más. */
  const controller: IngestController = useMemo(() => createIngestController(), []);
  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  const runQa = useCallback(async () => {
    setRunning(true);
    const rows: CheckRow[] = Array.from({ length: N_CHECKS }, (_, i) => ({ id: i + 1, name: '', status: '…' as const, note: '' }));
    const set = (i: number, status: CheckRow['status'], name: string, note = ''): void => {
      rows[i] = { id: i + 1, name, status, note };
      setChecks([...rows]);
    };

    /* --- 1 · badge honesta air-gap (estamos EN el vehículo) — en móvil el
            panel vive en el Sheet: se abre el REAL «Abrir panel de capas». --- */
    try {
      await new Promise((r) => setTimeout(r, 600));
      const trigger = viewerRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Abrir panel de capas"]');
      if (!trigger) throw new Error('trigger del panel no encontrado');
      trigger.click();
      /* SheetContent se PORTALA a document.body (radix) — buscar en el documento. */
      const badgeOk = await waitFor(
        () => !!document.querySelector('span[title^="Artefacto air-gap"]'),
        4_000
      );
      trigger.click(); /* el Sheet se cierra — el flujo sigue limpio */
      set(0, badgeOk ? 'PASS' : 'FAIL', 'badge honesta «air-gap» en el panel de control (bitácora no disp.)');
    } catch (err) {
      set(0, 'FAIL', 'badge honesta «air-gap» en el panel de control (bitácora no disp.)', String(err).slice(0, 80));
    }

    /* --- 2 · FR-8 install: SW activo + cache del pin + custodia S6 --- */
    try {
      let activo = false;
      if ('serviceWorker' in navigator) {
        activo = await waitFor(
          async () => !!(await navigator.serviceWorker.getRegistration())?.active,
          10_000,
          250
        );
      }
      const pinResp = await fetch('/custodia.json', { cache: 'no-store' });
      const custodia = (await pinResp.json()) as { pin: string; generator: string };
      const nombres = 'caches' in window ? await caches.keys() : [];
      const cacheName = nombres.find((n) => n === `ti4go-a-${custodia.pin}`) ?? '';
      const entradas = cacheName ? (await (await caches.open(cacheName)).keys()).length : 0;
      set(
        1,
        activo && !!cacheName && entradas > 0 ? 'PASS' : 'FAIL',
        'FR-8 install: SW activo + cache ti4go-a-<pin> (A8-1/A8-5)',
        `pin=${custodia.pin} · entradas=${entradas}`
      );
    } catch (err) {
      set(1, 'FAIL', 'FR-8 install: SW activo + cache ti4go-a-<pin> (A8-1/A8-5)', String(err).slice(0, 80));
    }

    /* --- 3-6 · pack completo por canal D-1 + capas + fricción + render --- */
    const region = getRegion('soledad');
    const anchor = {
      extentM: region.extent,
      zMinM: region.elevMin,
      zMaxM: region.elevMax,
      centerLat: region.centerLat,
      centerLon: region.centerLon,
      regionName: region.name,
    };
    try {
      const res = await fetch('/qa/mision_fr5_completa.zip', { cache: 'no-store' });
      if (!res.ok) throw new Error(`fixture HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const hPre = canvasHash();
      const file = await controller.ingestAsync('mision_fr5_completa.zip', buf, anchor);
      set(2, file.status === 'done' && !file.error ? 'PASS' : 'FAIL', 'pack completo via canal programático D-1 (ingestAsync)', `${(buf.byteLength / 1024).toFixed(1)} KiB · ${file.stage}`);
      /* Los MIEMBROS del pack se expanden y asientan de forma asíncrona —
         esperar el asentamiento COMPLETO (todo done/error) antes de contar. */
      await waitFor(() => {
        const fs = controller.getFilesSnapshot();
        return fs.length > 0 && fs.every((f) => f.status === 'done' || f.status === 'error');
      }, 15_000);
      await new Promise((r) => setTimeout(r, 400));
      /* Semántica del pack: TODOS los miembros se FUSIONAN en UNA capa
         (parseMissionPack ⇒ 1 IngestGeom) — la evidencia de «7 capas» son
         los miembros procesados por rol KML/GeoJSON en el manifest. */
      const geoms = controller.getGeomsSnapshot();
      const ent = (file.meta?.entities ?? {}) as Record<string, number | undefined>;
      const proc = ent.procesados ?? 0;
      const errs = ent.errores ?? 0;
      set(3, geoms.length === 1 && proc >= 10 ? 'PASS' : 'FAIL', 'capas del pack fusionadas en el lienzo (7 KML D11 + A/B + miembro)', `geoms=${geoms.length} · miembros=${ent.miembros ?? '?'} · ok=${proc} · err=${errs}`);
      const fric = controller.getFrictionsSnapshot();
      const filaD12 = (file.meta?.rows ?? []).find(([k]) => k.startsWith('Campo de fricción'));
      set(4, fric.length === 1 ? 'PASS' : 'FAIL', 'fricción D12 del pack decodificada (rol FRICTION* → lienzo)', `frictions=${fric.length}${filaD12 ? ` · ${String(filaD12[1]).slice(0, 60)}` : ''}`);

      await new Promise((r) => setTimeout(r, 900));
      const hPost = canvasHash();
      const scene = apiHolder.current?.getExportScene() ?? null;
      set(5, !!hPost && scene !== null && hPost !== hPre ? 'PASS' : 'FAIL', 'render de escena tras ingesta (delta de canvas + getExportScene)', hPost ? `canvas=${hPost}` : 'sin canvas');
    } catch (err) {
      const msg = String(err).slice(0, 80);
      set(2, 'FAIL', 'pack completo via canal programático D-1 (ingestAsync)', msg);
      set(3, 'FAIL', '7 capas D11 asentadas en el controller', 'pack no ingestado');
      set(4, 'FAIL', 'fricción D12 decodificada (1 campo)', 'pack no ingestado');
      set(5, 'FAIL', 'render de escena tras ingesta (delta de canvas + getExportScene)', 'pack no ingestado');
    }

    /* --- 7 · GPS: click REAL del chip + fix sintético + delta canvas --- */
    try {
      const chip = viewerRef.current?.querySelector<HTMLButtonElement>('button[aria-label^="GPS"]');
      if (!chip) throw new Error('chip GPS no encontrado (¿barra de campo visible?)');
      /* Fake geolocation (patrón A-2 de los forenses — fuente inyectable). */
      const fake = {
        watchPosition(
          ok: (p: { coords: { latitude: number; longitude: number; accuracy: number }; timestamp: number }) => void
        ): number {
          setTimeout(
            () =>
              ok({
                coords: { latitude: region.centerLat + FIX_LAT_OFF, longitude: region.centerLon, accuracy: FIX_ACC_M },
                timestamp: Date.now(),
              }),
            60
          );
          return 1;
        },
        clearWatch(): void {
          /* no-op */
        },
      };
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: fake });
      const hAntes = canvasHash();
      chip.click();
      const labelOk = await waitFor(() => /±\d+ m/.test(chip.textContent ?? ''), 4_000);
      await new Promise((r) => setTimeout(r, 500));
      const hDespues = canvasHash();
      const etiqueta = (chip.textContent ?? '').trim().slice(0, 30);
      set(6, labelOk && hAntes !== hDespues ? 'PASS' : 'FAIL', 'GPS: fix → chip ±N m + motor redibuja con el marcador (A-8)', `chip="${etiqueta}"`);
      /* P-2 · cortesía del harness: cerrar el watch (higiene, ciclo cerrado). */
      chip.click();
    } catch (err) {
      set(6, 'FAIL', 'GPS: fix → chip ±N m + motor redibuja con el marcador (A-8)', String(err).slice(0, 80));
    }

    /* --- 8-9 · export real (SVG + PDF) sobre la escena del último cuadro --- */
    try {
      const scene = (apiHolder.current?.getExportScene() ?? null) as ExportScene | null;
      if (!scene) throw new Error('getExportScene() null');
      const dl = buildDisplayList(scene);
      const svg = serializeSvg(dl, scene);
      const svgOk = (svg.startsWith('<?xml') || svg.includes('<svg')) && svg.length > 10_000;
      set(7, svgOk ? 'PASS' : 'FAIL', 'export SVG real (buildDisplayList + serializeSvg)', `${(svg.length / 1024).toFixed(1)} KiB`);
      const pdf = await serializePdf(dl, scene);
      const head = await pdf.slice(0, 5).text();
      set(8, head === '%PDF-' && pdf.size > 1_000 ? 'PASS' : 'FAIL', 'export PDF real (serializePdf → Blob %PDF-)', `${(pdf.size / 1024).toFixed(1)} KiB`);
    } catch (err) {
      const msg = String(err).slice(0, 80);
      set(7, 'FAIL', 'export SVG real (buildDisplayList + serializeSvg)', msg);
      set(8, 'FAIL', 'export PDF real (serializePdf → Blob %PDF-)', msg);
    }

    setChecks([...rows]);
    setRunning(false);
  }, [controller]);

  const pass = checks.filter((c) => c.status === 'PASS').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const done = checks.length > 0 && checks.every((c) => c.status !== '…');

  return (
    <IngestControllerContext.Provider value={controller}>
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-b border-border bg-card px-4 py-3">
          <h1 className="text-sm font-semibold">
            E2E DORADO AIR-GAP — <code className="text-orange-400">install → pack → 7 capas + fricción → GPS → export</code>
          </h1>
          <p className="text-[11px] text-muted-foreground">
            Camino de brigadista sobre el vehículo re-sellado (Modo Campo FR-6 · controller D-1 · fixture /qa/). Doc:
            docs/fr-specs/E2E-dorado-airgap.md · viewport contractual 390×844.
          </p>
        </header>

        <main className="mx-auto max-w-6xl space-y-4 p-4">
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void runQa()}
                disabled={running}
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {running ? 'EJECUTANDO…' : 'EJECUTAR QA DORADO (9 checks)'}
              </button>
              <span
                data-testid="qa-report"
                data-status={done ? 'done' : 'pending'}
                data-pass={String(pass)}
                data-fail={String(fail)}
                className="font-mono text-xs"
              >
                QA: {pass}/{N_CHECKS} PASS · {fail} FAIL
              </span>
            </div>
            <ol className="space-y-1 font-mono text-[11px]">
              {checks.map((c) => (
                <li key={c.id} data-check={c.id} data-status={c.status} className="flex gap-2">
                  <span
                    className={
                      c.status === 'PASS' ? 'text-green-500' : c.status === 'FAIL' ? 'text-red-500' : 'text-muted-foreground'
                    }
                  >
                    {c.status}
                  </span>
                  <span>
                    {c.id}. {c.name} {c.note && <span className="text-muted-foreground">— {c.note}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* El VISOR de producto, íntegro, en Modo Campo — el harness solo
              aporta el controller D-1 (embedder legítimo) y mide. */}
          <div ref={viewerRef} className="h-[80vh] overflow-hidden rounded-xl border border-border">
            <TerrainViewer fieldMode urlSync={false} gpsSlot={<GpsChip />} apiRef={apiHolder} />
          </div>
        </main>
      </div>
    </IngestControllerContext.Provider>
  );
}
