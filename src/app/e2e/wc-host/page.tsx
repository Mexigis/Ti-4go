/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * B-D1 · U5 — HOST DE PRUEBA E2E del Web Component `ti4go-viewer`
 * (contrato: «E2E agent-browser con host de prueba (div + script consumidor)»).
 *
 * Ruta técnica de QA (NO es la ruta del producto — la ruta única es /).
 * El consumidor carga el ARTEFACTO real `/wc/ti4go-viewer.js` (entry ESM
 * dedicado, bun build) y ejercita el WC por su API contractual:
 *
 *  - 3 instancias simultáneas (D-1: cada una su controller/worker):
 *      #inst1 url-sync ON  (default dark · expert)
 *      #inst2 url-sync="false" (theme day · expert)
 *      #inst3 theme eink (dark · expert)
 *  - Señales ti4go:* → log visible (same-document CustomEvent; 0 postMessage).
 *  - Auto-QA determinista (botón / auto al cargar): 8 checks PASS/FAIL
 *    visibles en el DOM para agent-browser + memoria medida de 3 instancias.
 *  - url-sync="false": flyToBBox en #inst2 NO toca location.hash (check 4);
 *    flyToBBox en #inst1 SÍ lo escribe (check 5) — contraste por par.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { packRegionSeed } from '@/lib/terrain/seedpack';
import { getRegion } from '@/lib/terrain/regions';

interface CheckRow {
  id: number;
  name: string;
  status: 'PASS' | 'FAIL' | '…';
  note: string;
}

const HASH_RE = /^#v=1\|/;

type WcElement = HTMLElement & {
  loadMissionPack: (s: unknown) => Promise<unknown>;
  flyToBBox: (b: [number, number, number, number]) => boolean;
  setViewOpts: (o: Record<string, unknown>) => void;
  getExportScene: () => { model: { region: { id: string } } } | null;
};

export default function WcHostE2E() {
  const [loaded, setLoaded] = useState(false);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [mem, setMem] = useState<string>('n/d');
  const [eventsLog, setEventsLog] = useState<string[]>([]);
  const inst1Ref = useRef<HTMLDivElement>(null);
  const inst2Ref = useRef<HTMLDivElement>(null);
  const inst3Ref = useRef<HTMLDivElement>(null);
  const elementsRef = useRef<Array<WcElement | null>>([null, null, null]);
  /* Espejo síncrono del log: runQa es async y el closure de useState queda
     obsoleto tras los re-render — sin ref, check 3 lee un array viejo (falso
     «nuevas=0» aunque el WC SÍ emitió la señal). */
  const eventsLogRef = useRef<string[]>([]);

  const logEvent = useCallback((name: string, detail: unknown) => {
    setEventsLog((prev) => {
      const next = [...prev.slice(-40), `${name} ${JSON.stringify(detail).slice(0, 120)}`];
      eventsLogRef.current = next;
      return next;
    });
  }, []);

  /* --- carga del ARTEFACTO real (entry ESM) --- */
  useEffect(() => {
    const s = document.createElement('script');
    s.type = 'module';
    s.src = '/wc/ti4go-viewer.js';
    s.onload = () => void Promise.resolve().then(() => setLoaded(true));
    s.onerror = () => {
      setChecks([{ id: 0, name: 'carga del artefacto /wc/ti4go-viewer.js', status: 'FAIL', note: 'script onerror' }]);
    };
    document.body.appendChild(s);
    return () => {
      s.remove();
    };
  }, []);

  /* Estilos del documento → shadow root (adoptedStyleSheets) + 3 instancias + listeners ti4go:* */
  useEffect(() => {
    if (!loaded) return;
    const sheets: CSSStyleSheet[] = [];
    for (const ss of Array.from(document.styleSheets)) {
      try {
        const text = Array.from(ss.cssRules)
          .map((r) => r.cssText)
          .join('\n');
        if (!text) continue;
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        sheets.push(sheet);
      } catch {
        /* hoja cross-origin: skip */
      }
    }
    const mounts: Array<[React.RefObject<HTMLDivElement | null>, string]> = [
      [inst1Ref, ''],
      [inst2Ref, 'url-sync="false" theme="day"'],
      [inst3Ref, 'theme="eink"'],
    ];
    const els: Array<WcElement | null> = [null, null, null];
    mounts.forEach(([ref, attrs], i) => {
      const host = ref.current;
      if (!host) return;
      const el = document.createElement('ti4go-viewer') as WcElement;
      if (attrs) {
        for (const kv of attrs.split(' ').map((p) => p.split('='))) {
          el.setAttribute(kv[0], (kv[1] ?? '').replace(/"/g, ''));
        }
      }
      /* RCA Task 61 — el orden MANDA: `el.shadowRoot` NO existe antes de
       * conectar (attachShadow vive en connectedCallback); la asignación
       * pre-append era un no-op silencioso (adopted=0 medido en la falla).
       * Ahora: conectar PRIMERO, adoptar DESPUÉS (el shadow root ya existe),
       * y altura explícita del consumidor (contrato del embedder). */
      el.style.height = '100%';
      host.appendChild(el);
      if (el.shadowRoot) el.shadowRoot.adoptedStyleSheets = sheets;
      el.addEventListener('ti4go:layer-select', (e) => logEvent('ti4go:layer-select', (e as CustomEvent).detail));
      el.addEventListener('ti4go:camera-change', (e) => logEvent('ti4go:camera-change', (e as CustomEvent).detail));
      el.addEventListener('ti4go:custody', (e) => logEvent('ti4go:custody', (e as CustomEvent).detail));
      el.addEventListener('ti4go:divergence', (e) => logEvent('ti4go:divergence', (e as CustomEvent).detail));
      els[i] = el;
    });
    elementsRef.current = els;
    /* Memoria medida con 3 instancias (contrato: «costo real = memoria»).
       En microtarea: setState síncrono dentro del efecto dispara cascada
       (react-hooks/set-state-in-effect); la medida es la misma. */
    const t = setTimeout(() => {
      const pm = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      if (pm) setMem(`${(pm.usedJSHeapSize / 1048576).toFixed(1)} MB (3 instancias · usedJSHeapSize)`);
    }, 0);
    return () => {
      clearTimeout(t);
      for (const el of els) el?.remove();
    };
  }, [loaded, logEvent]);

  /* --- auto-QA determinista --- */
  const runQa = useCallback(async () => {
    const rows: CheckRow[] = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: '', status: '…' as const, note: '' }));
    const set = (i: number, status: CheckRow['status'], name: string, note = ''): void => {
      rows[i] = { id: i + 1, name, status, note };
      setChecks([...rows]);
    };
    const [e1, e2] = elementsRef.current;
    const region = getRegion('soledad');

    /* 1 · 3 instancias vivas con shadow + app montado */
    const vivas = elementsRef.current.filter((el) => el?.shadowRoot?.querySelector('[data-ti4go-root]')).length;
    set(0, vivas === 3 ? 'PASS' : 'FAIL', '3 instancias con shadow root y app montado', `vivas=${vivas}`);

    /* 2 · atributo url-sync="false" en inst2 */
    set(1, e2?.getAttribute('url-sync') === 'false' ? 'PASS' : 'FAIL', 'atributo url-sync="false" presente en #inst2');

    /* 3 · señal same-document: setViewOpts → ti4go:layer-select */
    const evAntes = eventsLogRef.current.length;
    e1?.setViewOpts({ mesh: false });
    await new Promise((r) => setTimeout(r, 400));
    const gotLayer = eventsLogRef.current.slice(evAntes).some((l) => l.startsWith('ti4go:layer-select'));
    set(2, gotLayer ? 'PASS' : 'FAIL', 'ti4go:layer-select recibida tras setViewOpts (same-document)', `nuevas=${eventsLogRef.current.length - evAntes}`);

    /* 4 · D-2: flyToBBox en #inst2 (url-sync=false) NO toca location.hash */
    const hashAntes = window.location.hash;
    const flew2 =
      e2?.flyToBBox([region.centerLon - 0.002, region.centerLat - 0.002, region.centerLon + 0.002, region.centerLat + 0.002]) ??
      false;
    await new Promise((r) => setTimeout(r, 1500));
    set(3, flew2 && window.location.hash === hashAntes ? 'PASS' : 'FAIL', 'flyToBBox con url-sync="false" NO toca location.hash', `hash="${window.location.hash.slice(0, 30)}"`);

    /* 5 · url-sync ON: flyToBBox en #inst1 SÍ escribe #v=1 (en reposo) */
    const flew1 =
      e1?.flyToBBox([region.centerLon - 0.001, region.centerLat - 0.001, region.centerLon + 0.001, region.centerLat + 0.001]) ??
      false;
    let hashOk = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (HASH_RE.test(window.location.hash)) {
        hashOk = true;
        break;
      }
    }
    set(4, flew1 && hashOk ? 'PASS' : 'FAIL', 'flyToBBox con url-sync ON escribe #v=1 (sincronización)', `hash="${window.location.hash.slice(0, 36)}…"`);

    /* 6 · camera-change: señal tras el vuelo */
    const gotCam = eventsLogRef.current.some((l) => l.startsWith('ti4go:camera-change'));
    set(5, gotCam ? 'PASS' : 'FAIL', 'ti4go:camera-change recibida (az/el/zoom)');

    /* 7 · loadMissionPack canal MXP1 → custody evento */
    try {
      const custodyDetail = await new Promise<{ packSha: string | null } | null>((resolve) => {
        const h = (e: Event): void => {
          resolve((e as CustomEvent).detail);
          e1?.removeEventListener('ti4go:custody', h);
        };
        e1?.addEventListener('ti4go:custody', h);
        setTimeout(() => resolve(null), 2500);
      });
      const receipt = (await e1?.loadMissionPack(packRegionSeed(getRegion('soledad')))) as
        | { format: string; custody: string }
        | undefined;
      await new Promise((r) => setTimeout(r, 300));
      set(
        6,
        receipt?.format === 'mxp1' ? 'PASS' : 'FAIL',
        'loadMissionPack canal MXP1 → Promise<CustodyReceipt>',
        `custody="${receipt?.custody.slice(0, 44)}…" · evento: ${custodyDetail ? `packSha=${custodyDetail.packSha ?? 'null'}` : 'n/d'}`
      );
    } catch (err) {
      set(6, 'FAIL', 'loadMissionPack canal MXP1 → Promise<CustodyReceipt>', String(err).slice(0, 80));
    }

    /* 8 · getExportScene (A-9) */
    const scene = e1?.getExportScene() ?? null;
    set(7, scene !== null ? 'PASS' : 'FAIL', 'getExportScene() ⇒ ExportScene no nula', scene ? `region=${scene.model.region.id}` : '');

    setChecks([...rows]);
  }, []);

  const pass = checks.filter((c) => c.status === 'PASS').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const done = checks.length > 0 && checks.every((c) => c.status !== '…');

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card px-4 py-3">
        <h1 className="text-sm font-semibold">
          B-D1 · Host E2E <code className="text-orange-400">ti4go-viewer</code> — div + script consumidor (artefacto
          real)
        </h1>
        <p className="text-[11px] text-muted-foreground">
          3 instancias · D-1 por instancia · señales same-document · viewport contractual 390×844 en la sesión del
          agente
        </p>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 p-4">
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void runQa()}
              disabled={!loaded}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {loaded ? 'EJECUTAR QA (8 checks)' : 'cargando artefacto…'}
            </button>
            <span data-testid="mem" className="font-mono text-xs">
              memoria: {mem}
            </span>
            <span
              data-testid="qa-report"
              data-status={done ? 'done' : 'pending'}
              data-pass={String(pass)}
              data-fail={String(fail)}
              className="font-mono text-xs"
            >
              QA: {pass}/8 PASS · {fail} FAIL
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

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Log de señales ti4go:*
          </h2>
          <div className="thin-scroll max-h-40 overflow-y-auto font-mono text-[10px] leading-relaxed">
            {eventsLog.length === 0 ? (
              <p className="text-muted-foreground">— sin señales aún —</p>
            ) : (
              eventsLog.map((l, i) => (
                <p key={i} className="whitespace-nowrap">
                  {l}
                </p>
              ))
            )}
          </div>
        </section>

        {(
          [
            ['inst1 — url-sync ON · dark · expert', inst1Ref],
            ['inst2 — url-sync="false" · day', inst2Ref],
            ['inst3 — theme="eink"', inst3Ref],
          ] as Array<[string, React.RefObject<HTMLDivElement | null>]>
        ).map(([label, ref]) => (
          <section key={label} className="overflow-hidden rounded-xl border border-border">
            <div className="border-b border-border bg-card px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              {label}
            </div>
            <div ref={ref} style={{ height: 460 }} className="relative bg-background" />
          </section>
        ))}
      </main>
    </div>
  );
}
