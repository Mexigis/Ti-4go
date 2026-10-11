/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * Visor isométrico de curvas de nivel — Microcuencas de Guanajuato.
 *
 * Shell de la aplicación: header (título + selector), lienzo a pantalla
 * completa, HUD tipo Blender, controles POV, leyenda, panel de control
 * (panel lateral en escritorio / drawer inferior en móvil) y footer fijo.
 *
 * Render de baja inferencia: todo el cálculo es local (Canvas 2D), el bucle
 * se detiene al quedar inactivo y el LOD se adapta al presupuesto de segmentos.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { IsoEngine, type HudInfo, type PresetName, type ViewOpts } from '@/lib/terrain/engine';
import { applyFieldPreset } from '@/lib/terrain/fieldmode';
import { FieldBar } from '@/components/terrain/FieldBar';
import { useBatterySaver } from '@/components/terrain/hooks/useBatterySaver';
import { UpdateBanner } from '@/components/terrain/UpdateBanner';
import { CustodiaPin } from '@/components/terrain/CustodiaPin';
import { useGpsBridge } from '@/components/terrain/hooks/useGpsBridge';
import { sampleGridZ } from '@/lib/terrain/gps';
import { GpsCard } from './GpsCard';
import { buildContours } from '@/lib/terrain/contours';
import type { Contours } from '@/lib/terrain/contours';
import { buildTerrain } from '@/lib/terrain/generator';
import type { TerrainModel } from '@/lib/terrain/generator';
import type { TerrainWorkerResponse } from './terrain.worker';
import { getRegion, REGIONS, type RegionDef } from '@/lib/terrain/regions';
import { BENEFICIARIES_LINE, BRAND, QUALITY_SEAL, SDK_VERSION } from '@/lib/branding';
import { TerrainPanel, type ModelInfo } from './TerrainPanel';
import { AvatarButton, CadWatermark, ElevationCard, LayersCard, PovFlyGroup, SeedQrCard } from './floating';
import { buildAuditCitation } from './audit';
import { IngestCard } from './IngestCard';
import { useFrictionFields, useGeoidModels, useIngestController, useIngestGeoms, useRealDems, type GeomLayer, type RealDemLayer } from './ingest';
import { drawIngestOverlay, drawBreadcrumb, drapePerf, overlayPerf } from '@/lib/ingest/overlay';
import { buildBreadcrumbTrail, type BreadcrumbTrail } from '@/lib/terrain/breadcrumb';
import type { Anchor } from '@/lib/ingest/parsers';
import { sampleDemElevation } from '@/lib/ingest/geotiff-dem';
import type { RealDemMeta } from '@/lib/terrain/dem';
import { buildDisplayList, downloadBlob, serializePdf, serializeSvg } from '@/lib/terrain/export';
import { encodeViewHash, parseViewHash, type ViewCamera } from '@/lib/terrain/viewstate';
import { createMissionPackLoader, type MissionPackSource } from '@/wc/mission-pack';
import type {
  CustodyReceipt,
  Ti4goBBox,
  Ti4goCameraDetail,
  Ti4goDivergenceDetail,
  Ti4goLayerSelectDetail,
  Ti4goViewerApi,
} from '@/wc/contract';
import { ExportCard, type ExportFormat } from './ExportCard';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  FileCheck,
  Home,
  Loader2,
  Minus,
  Moon,
  Mountain,
  Plus,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sun,
  Upload,
} from 'lucide-react';

const frame = () => new Promise<void>((r) => setTimeout(r, 40));

/** B-D1 · U4: mapeo semántico de capas de vista → clase D11 (payload
 *  layerType de ti4go:layer-select). Las booleanas del ViewOpts son capas;
 *  elevRange/forcedStep no lo son (nunca emiten). */
const LAYER_TYPE_BY_KEY: Record<string, string> = {
  minor: 'intermedia',
  major: 'curva-maestra',
  streams: 'cauce',
  divides: 'divisoria',
  hachures: 'hachura',
  friction: 'campo-friccion',
  mesh: 'vista',
  nodes: 'vista',
  labels: 'vista',
  cotas: 'vista',
  inegi: 'vista',
  reliefFx: 'vista',
};

/** Valores por defecto de la vista (los consagrados del visor). */
const DEFAULT_OPTS: ViewOpts = {
  minor: true,
  major: true,
  mesh: true,
  nodes: false,
  streams: true,
  divides: true,
  labels: true,
  cotas: true,
  inegi: true,
  elevRange: [2000, 2545],
  forcedStep: 0,
  reliefFx: true,
  eink: false,
  day: false,
  powerSave: false,
};

/**
 * FR-6 §4 — props del embedder (RETROCOMPATIBLES: <TerrainViewer /> sin props
 * produce exactamente el comportamiento actual; page.tsx no cambia).
 * El estado de Modo Campo lo POSEE el embedder (props only, G-2 recomendado:
 * el preset NO viaja en el hash #v=1 — retrocompat de 9 bits intacta).
 */
export interface TerrainViewerProps {
  /** Activa el preset Modo Campo (default false — comportamiento actual intacto). */
  fieldMode?: boolean;
  /** Salida para que el embedder refleje el estado (reservado: v1 no añade
   *  alternancia interna; el embedder conmuta la prop y ya conoce el valor). */
  onFieldModeChange?: (v: boolean) => void;
  /** R-5 · SLOT GPS: nodo del embedder; sin él se muestra el placeholder
   *  honesto no interactivo («GPS — pendiente (FR-7)»). 0 lógica GPS aquí. */
  gpsSlot?: ReactNode;
  /** Overrides del embedder sobre FIELD_PRESET, aplicados al ACTIVAR (los
   *  bloqueados eink/powerSave se ignoran aquí y se re-fuerzan en vuelo). */
  fieldOpts?: Partial<ViewOpts>;
  /** B-D1 · D-2: sincronización de estado de vista con el URL (#v=1) —
   *  LECTURA (restauración inicial + hashchange) y ESCRITURA (replaceState
   *  en reposo). Default true (comportamiento actual intacto); false =
   *  0 acceso al hash de ANY dirección (contrato WC: apagable por ATRIBUTO
   *  `url-sync="false"` — no detección de iframe). */
  urlSync?: boolean;
  /** B-D1 · U3: overrides de la vista INICIAL (sembrados una sola vez al
   *  montar; p. ej. theme="eink" ⇒ { eink: true }). No re-aplica después:
   *  los cambios dinámicos van por el API del WC (setViewOpts, U4). */
  initialOpts?: Partial<ViewOpts>;
  /** Task 61 · RCA «estilos-WC-nunca-inyectados» (caso límite hermano): la
   *  polaridad del lienzo (ViewOpts.day) estaba acoplada a `resolvedTheme` de
   *  next-themes, que observa el <html> del DOCUMENTO anfitrión — en un
   *  documento con N instancias WC forzando temas distintos, la última monta
   *  su clase y TODAS siguen esa clase (medido: inst day pintaba lienzo dark).
   *  El elemento WC pasa `dayOverride={theme === 'day'}` y la polaridad del
   *  lienzo queda POR INSTANCIA. undefined (default) ⇒ comportamiento actual
   *  intacto en la ruta /. */
  dayOverride?: boolean;
  /** B-D1 · U4: ref donde el viewer registra su API interna para el elemento
   *  WC (loadMissionPack/flyToBBox/setViewOpts/getExportScene). El app la
   *  entrega al elemento vía Ti4goHostHooks.registerApi. */
  apiRef?: { current: Ti4goViewerApi | null };
  /** B-D1 · U4: señales same-document del WC (CustomEvents sobre el host;
   *  NUNCA postMessage, jamás '*'). Opcionales — retrocompatibles. */
  onCameraChange?: (c: Ti4goCameraDetail) => void;
  onLayerSelect?: (l: Ti4goLayerSelectDetail) => void;
  onCustody?: (r: CustodyReceipt) => void;
  onDivergence?: (d: Ti4goDivergenceDetail) => void;
}

export function TerrainViewer({
  fieldMode: fieldModeProp = false,
  onFieldModeChange,
  gpsSlot,
  fieldOpts,
  urlSync: urlSyncProp = true,
  initialOpts,
  dayOverride,
  apiRef,
  onCameraChange,
  onLayerSelect,
  onCustody,
  onDivergence,
}: TerrainViewerProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /* B-D1 · U4: espejo de los callbacks de señal — onHud y los toggles leen
     el ref (identidad estable ⇒ el motor NUNCA se re-crea por una señal). */
  const signalCbsRef = useRef({ onCameraChange, onLayerSelect, onCustody, onDivergence });
  useEffect(() => {
    signalCbsRef.current = { onCameraChange, onLayerSelect, onCustody, onDivergence };
  }, [onCameraChange, onLayerSelect, onCustody, onDivergence]);
  /** Última cámara emitida por ti4go:camera-change (throttle por delta). */
  const lastCamEmitRef = useRef<Ti4goCameraDetail | null>(null);

  const engineRef = useRef<IsoEngine | null>(null);
  const azRef = useRef<HTMLSpanElement>(null);
  const elRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const stepRef = useRef<HTMLSpanElement>(null);
  const segRef = useRef<HTMLSpanElement>(null);
  const msRef = useRef<HTMLSpanElement>(null);
  /** #12 semáforo: latch rojo (≥12 ms persiste hasta cuadro < 8 ms). */
  const msRedRef = useRef(false);
  /* FR-6 · estado de la barra de campo (FieldBar). Solo se actualiza en
     campo (fieldModeRef) ⇒ 0 re-renders en modo estudio (R-3: 0 trabajo). */
  const [fieldHud, setFieldHud] = useState({
    idle: true,
    save: false,
    interval: 0,
    hachureFallback: '' as HudInfo['hachureFallback'],
    frictionFallback: '' as HudInfo['frictionFallback'],
  });
  /* FR-6: el one-shot dispara TAMBIÉN en carga directa en campo (hard-load
     con fieldMode=true desde el montaje — harness ?campo=1): por eso el ref
     inicia en false y NO en fieldMode (si iniciara en fieldMode, `entering`
     sería false en el primer efecto y el preset JAMÁS se sembraría). */
  const fieldModeRef = useRef(false);
  const fieldOptsRef = useRef(fieldOpts);
  /* A-9: presentación base pre-preset (null en estudio ⇒ export sin cambios). */
  const basePresentationRef = useRef<Partial<ViewOpts> | null>(null);

  /* FR-6 · A-11 — simulador de embedder para QA (harness del export estático):
     `?campo=1` activa el modo por la vía contractual (props ⇒ fieldMode), pero
     resuelto en CLIENTE tras hidratación — el vehículo air-gap es output:export
     y la ruta / no lee searchParams en servidor (S2). Sin persistencia, sin
     hash #v=1 (G-2); 0 trabajo en estudio (el estado solo cambia si el param
     existe; el microtask sale del cuerpo síncrono del efecto). */
  const [qaFieldMode, setQaFieldMode] = useState(false);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('campo');
    if (v === '1' || v === 'true') {
      void Promise.resolve().then(() => setQaFieldMode(true));
    }
  }, []);
  const fieldMode = fieldModeProp || qaFieldMode;
  const jankRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerHandlerRef = useRef<((data: TerrainWorkerResponse) => void) | null>(null);
  const pendingSyncRef = useRef<(() => void) | null>(null);
  const genSeqRef = useRef(0);
  const workerBrokenRef = useRef(false);

  /* Ingesta GIS/CAD: canvas de overlay + estado de arrastre global */
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const geomsRef = useRef<GeomLayer[]>([]);
  const dragDepthRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const [regionId, setRegionId] = useState('soledad');
  const [region, setRegion] = useState<RegionDef>(() => getRegion('soledad'));
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const { toast } = useToast();
  /* B-D1 · D-1: controller de ingesta del CONTEXTO (por instancia en el WC;
   * sin provider = singleton de la ruta app). */
  const ingestCtl = useIngestController();

  /* ---- Estado de vista por URL (§6.2) ----
     Restauro DESPUÉS de la hidratación (sin mismatch SSR): el hash puede
     traer región, cámara y capas; la cámara se aplica tras el primer modelo
     (setModel→fitView la resetea) vía pendingCamRef. */
  const pendingCamRef = useRef<ViewCamera | null>(null);
  /** true cuando ya hubo un modelo aplicado — el hash se escribe desde entonces. */
  const viewSyncRef = useRef(false);
  /** B-D1 · D-2: espejo del prop urlSync — leído por writeViewHash (callback
   *  estable) y por el efecto de restauración/escucha del hash. */
  const urlSyncRef = useRef(urlSyncProp);
  useEffect(() => {
    urlSyncRef.current = urlSyncProp;
  }, [urlSyncProp]);
  const regionIdRef = useRef(regionId);
  useEffect(() => {
    regionIdRef.current = regionId;
  }, [regionId]);

  const writeViewHash = useCallback((): void => {
    /* B-D1 · D-2: con url-sync apagado el hash NUNCA se toca (ni escribir). */
    if (!urlSyncRef.current) return;
    const eng = engineRef.current;
    if (!eng || !viewSyncRef.current || typeof window === 'undefined') return;
    try {
      const cam = eng.snapshotCam();
      window.history.replaceState(null, '', `#${encodeViewHash(regionIdRef.current, cam, optsRef.current)}`);
    } catch {
      /* replaceState puede fallar en sandboxes — la vista sigue operativa */
    }
  }, []);

  /* Motor DEM Real (Task 18): el último GeoTIFF decodificado se aplica solo;
     quitar MDT real o aplicar otro desde la ficha de la IngestCard.
     userDemId: undefined = auto (último decodificado) · null = explícito
     procedural · número = ese DEM (si el archivo se quita, vuelve el auto). */
  const realDems = useRealDems();
  const [userDemId, setUserDemId] = useState<number | null | undefined>(undefined);
  const activeDem = useMemo(() => {
    if (userDemId === null) return null;
    if (typeof userDemId === 'number') {
      const found = realDems.find((d) => d.id === userDemId);
      if (found) return found;
    }
    return realDems.length > 0 ? realDems[realDems.length - 1] : null;
  }, [realDems, userDemId]);
  const activeDemRef = useRef<RealDemLayer | null>(null);
  useEffect(() => {
    activeDemRef.current = activeDem;
  }, [activeDem]);

  /* FR-5 · D12: el último campo de fricción decodificado (suelto `fricc*`
     o rol FRICTION* del pack) alimenta el motor de tramas. El anclaje
     escénico sigue a la REGIÓN ACTIVA: al cambiar, se re-aplica. */
  const frictionLayers = useFrictionFields();
  const activeFriction = frictionLayers.length > 0 ? frictionLayers[frictionLayers.length - 1] : null;
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (!activeFriction) {
      eng.setFrictionField(null, null);
      return;
    }
    eng.setFrictionField(activeFriction.field, {
      centerLat: region.centerLat,
      centerLon: region.centerLon,
      extentM: region.extent,
      zMinM: region.elevMin,
      zMaxM: region.elevMax,
    });
  }, [activeFriction, region]);

  /* FR-7 · GGM25: el datum vertical declarado sigue al último geoides
     ingestado (sub-grid del pack o ZIP nacional). Sin geoides ⇒ null = el
     honesto «WGS84 (elipsoidal)» en el cajetín del export (ADR D10).
     P-3/W5: la etiqueta es DATO; la cota del GPS NO se convierte aquí. */
  const geoidLayers = useGeoidModels();
  const activeGeoid = geoidLayers.length > 0 ? geoidLayers[geoidLayers.length - 1] : null;
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.setVerticalDatum(activeGeoid ? `${activeGeoid.model.name} (ortométrica)` : null);
  }, [activeGeoid]);
  const [loading, setLoading] = useState<{ stage: string; pct: number } | null>({
    stage: 'Preparando lienzo',
    pct: 10,
  });
  const [opts, setOpts] = useState<ViewOpts>(() => ({ ...DEFAULT_OPTS, ...initialOpts }));
  /* A-9: espejo de opts — fresco cuando el one-shot de campo dispara (el
     efecto espejo se declara antes que el one-shot ⇒ orden de ejecución
     garantizado por React: efectos corren en orden de declaración). */
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);
  const [sheetOpen, setSheetOpen] = useState(false);

  /* Design tokens dual Dark/Day: el tema de la UI gobierna la paleta del
     lienzo (ViewOpts.day). Pre-mount el default es dark (mismo render SSR
     y de hidratación: 0 mismatch). */
  const { resolvedTheme, setTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  useEffect(() => setThemeMounted(true), []);
  /* Task 61: el WC inyecta dayOverride (por instancia); la ruta / no lo pasa
   * (undefined) y conserva el camino document-scoped intacto. */
  const isDay = dayOverride !== undefined ? dayOverride : themeMounted && resolvedTheme === 'day';
  const toggleTheme = useCallback(() => {
    setTheme(isDay ? 'dark' : 'day');
  }, [isDay, setTheme]);

  /* F4 · Modo Ahorro automático — REFACTOR-1: hook extraído a
     src/components/terrain/hooks/useBatterySaver.ts (comportamiento
     byte-idéntico; la decisión pura vive en shouldBatterySave para el
     forense). Sin la API (Safari/headless), el modo sigue disponible
     manualmente desde Capas. */
  const battSave = useBatterySaver();

  /* HUD: escritura directa al DOM (sin re-render de React por cuadro).
     Cada emisión con idle=true es exactamente el instante en que el bucle de
     render se detiene: ahí se sincroniza el estado de vista en el URL. */
  const onHud = useCallback(
    (h: HudInfo) => {
      if (azRef.current) azRef.current.textContent = `${h.azDeg.toFixed(1)}°`;
      if (elRef.current) elRef.current.textContent = `${h.elDeg.toFixed(1)}°`;
      if (zoomRef.current) zoomRef.current.textContent = `${h.zoom.toFixed(2)}×`;
      /* R-03 · el auditor distingue sin interactuar el LOD del 1 m forzado:
         el sufijo «· LOD» es visible de forma permanente en modo automático. */
      const forcedNow = optsRef.current.forcedStep > 0;
      if (stepRef.current)
        stepRef.current.textContent = `${h.interval} m${forcedNow ? '' : ' · LOD'}`;
      if (segRef.current) segRef.current.textContent = h.drawnSegs.toLocaleString('es-MX');
      if (msRef.current) {
        msRef.current.textContent = h.frameMs > 0 ? `${h.frameMs.toFixed(1)} ms` : '—';
        /* Hallazgo #12 (Bundle B, aprobado 2026-09-25): semáforo del
           presupuesto de 8 ms/cuadro — ámbar ≥ 8 ms, rojo ≥ 12 ms
           PERSISTENTE (latch hasta cuadro < 8 ms). 0 re-renders: la clase
           se escribe junto al texto, en la misma escritura DOM directa. */
        if (h.frameMs >= 12) msRedRef.current = true;
        else if (h.frameMs > 0 && h.frameMs < 8) msRedRef.current = false;
        msRef.current.className = msRedRef.current
          ? 'text-right text-red-500'
          : h.frameMs >= 8
            ? 'text-right text-amber-400'
            : 'text-right';
      }
      if (statusRef.current) {
        const base = h.idle ? 'reposo · bajo consumo' : 'activo';
        statusRef.current.textContent = h.save ? `${base} · ahorro` : base;
      }
      /* FR-6 · R-4/R-2: la barra de campo se sincroniza con la MISMA emisión
         (0 timers nuevos — R-3). Solo en campo: en estudio, 0 setState. */
      if (fieldModeRef.current) {
        setFieldHud({
          idle: h.idle,
          save: h.save,
          interval: h.interval,
          hachureFallback: h.hachureFallback,
          frictionFallback: h.frictionFallback,
        });
      }
      /* #11 fase 2 · fallback del hachurado interactivo: toast una vez por
         evento (guard > 6 ms o cuadros > 8 ms sostenidos). El checkbox NO se
         toca: sigue activo para el ARCHIVO exportado (fallback export-only
         aprobado por el propietario). */
      if (h.hachureFallback && h.hachureFallback !== hachFallbackRef.current) {
        hachFallbackRef.current = h.hachureFallback;
        toast({
          title: 'Hachurado en pantalla desactivado',
          description:
            h.hachureFallback === 'guard'
              ? 'La construcción excede 6 ms en este equipo — queda SOLO en el archivo exportado (fallback aprobado).'
              : 'Cuadros > 8 ms sostenidos — queda SOLO en el archivo exportado (reversión automática).',
        });
      } else if (!h.hachureFallback) {
        hachFallbackRef.current = '';
      }
      /* FR-5 · D12: fallback del campo de fricción — toast único por evento
         (mismo esquema que el hachurado; el checkbox NO se toca: queda para
         el ARCHIVO exportado). */
      if (h.frictionFallback && h.frictionFallback !== frictionFallbackRef.current) {
        frictionFallbackRef.current = h.frictionFallback;
        toast({
          title: 'Tramas de fricción desactivadas en pantalla',
          description:
            h.frictionFallback === 'guard'
              ? 'La construcción del campo excede 6 ms en este equipo — quedan SOLO en el archivo exportado.'
              : 'Cuadros > 8 ms sostenidos con 7 capas — quedan SOLO en el archivo exportado.',
        });
      } else if (!h.frictionFallback) {
        frictionFallbackRef.current = '';
      }
      if (h.idle) writeViewHash();
      /* B-D1 · U4: señal ti4go:camera-change {az, el, zoom} — solo si la
         cámara cambió desde la última emisión (0 coste en reposo: onHud
         deja de emitir cuando el bucle duerme). */
      const last = lastCamEmitRef.current;
      if (!last || Math.abs(last.az - h.azDeg) > 0.05 || Math.abs(last.el - h.elDeg) > 0.05 || Math.abs(last.zoom - h.zoom) > 0.005) {
        lastCamEmitRef.current = { az: h.azDeg, el: h.elDeg, zoom: h.zoom };
        signalCbsRef.current.onCameraChange?.(lastCamEmitRef.current);
      }
    },
    [writeViewHash, toast]
  );

  /* Motor: crear una sola vez */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const eng = new IsoEngine(canvas, onHud);
    engineRef.current = eng;
    return () => {
      eng.dispose();
      engineRef.current = null;
    };
  }, [onHud]);

  /* Worker de generación (F1): crear una sola vez; fallback síncrono si el
     entorno no ofrece Worker o el módulo falla al cargar */
  useEffect(() => {
    if (typeof Worker === 'undefined') {
      console.warn('[terrain] Worker no disponible en este entorno');
      workerBrokenRef.current = true;
      return;
    }
    try {
      const w = new Worker(new URL('./terrain.worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (ev: MessageEvent) =>
        workerHandlerRef.current?.(ev.data as TerrainWorkerResponse);
      w.onerror = (e: ErrorEvent) => {
        console.info(
          '[terrain] worker onerror:',
          e.message || 'carga fallida',
          '| src:', (e.filename || '').slice(-90),
          '| línea:', e.lineno
        );
        workerBrokenRef.current = true;
        pendingSyncRef.current?.();
        pendingSyncRef.current = null;
      };
      workerRef.current = w;
      return () => {
        w.terminate();
        workerRef.current = null;
      };
    } catch (err) {
      console.warn('[terrain] worker constructor lanzó:', String(err));
      workerBrokenRef.current = true;
      return;
    }
  }, []);

  /* Modelo: regenerar al cambiar de región — Web Worker (F1) con cancelación
     de resultados obsoletos por id y fallback síncrono */
  useEffect(() => {
    let cancelled = false;
    const myId = ++genSeqRef.current;

    /* Telemetría de jank (ATOM-01, roadmap): suma de tareas largas
       (>50 ms) en el hilo principal durante toda la generación + tiempo de
       aplicación del resultado. Con el Worker activo lo esperado es ~0 ms. */
    let ltSum = 0;
    let obs: PerformanceObserver | null = null;
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) ltSum += e.duration;
        });
        obs.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
      }
    } catch {
      obs = null;
    }

    const apply = (model: TerrainModel, contours: Contours, real?: RealDemMeta): void => {
      const t0 = performance.now();
      engineRef.current?.setModel(model, contours);
      /* Breadcrumb A-8 (transplante inverso): trail del modelo activo. */
      crumbsTrailRef.current = buildBreadcrumbTrail(model.grid);
      const applyMs = performance.now() - t0;
      obs?.disconnect();
      obs = null;
      if (jankRef.current) {
        jankRef.current.textContent =
          ltSum > 0 ? `${ltSum.toFixed(0)} + ${applyMs.toFixed(1)} ms` : `0 + ${applyMs.toFixed(1)} ms`;
      }
      setRegion(getRegion(regionId));
      setOpts((o) => ({
        ...o,
        elevRange: [Math.floor(contours.minV), Math.ceil(contours.maxV)],
      }));
      setModelInfo({
        stats: model.stats,
        levels: contours.levels.length,
        totalSegs: contours.totalSegs,
        maestras: contours.maestraCount,
        basinNames: model.basins.map((b) => b.name),
        source: real ? 'real' : 'procedural',
        realMeta: real,
        /* GPS-ORTO (puerto D-1): muestreo honesto del MDT activo —
           sampleGridZ con bounds (null fuera del recorte, jamás clamp). */
        sampleZ: (xM: number, yM: number) => sampleGridZ(model.grid, xM, yM),
      });
      /* Estado de vista por URL (§6.2): la cámara del hash se aplica DESPUÉS
         de setModel (fitView la resetea); desde aquí el URL se sincroniza. */
      const pc = pendingCamRef.current;
      if (pc) {
        pendingCamRef.current = null;
        engineRef.current?.setCamera(pc.az, pc.el, pc.zoom, pc.panX, pc.panY);
      }
      viewSyncRef.current = true;
      writeViewHash();
      setLoading(null);
    };

    const runSync = async (): Promise<void> => {
      if (activeDem) {
        // Motor DEM Real requiere worker (DecompressionStream ya hecho; el
        // reamuestreo es liviano pero el fallback procedural es más honesto)
        console.warn('[terrain] DEM real sin worker: cae a procedural');
      }
      console.info('[terrain] generación SÍNCRONA (fallback, bloquea por tandas)');
      setLoading({ stage: 'Esculpiendo el relieve', pct: 25 });
      await frame();
      if (cancelled) return;
      const r = getRegion(regionId);
      const model = buildTerrain(r);
      if (cancelled) return;
      setLoading({ stage: 'Extrayendo curvas de nivel (1 m / 25 m)', pct: 60 });
      await frame();
      if (cancelled) return;
      const contours = buildContours(model.grid);
      if (cancelled) return;
      setLoading({ stage: 'Trazando drenaje y divisorias', pct: 90 });
      await frame();
      if (cancelled) return;
      apply(model, contours);
    };

    const w = workerRef.current;
    if (w && !workerBrokenRef.current) {
      workerHandlerRef.current = (data: TerrainWorkerResponse) => {
        if (cancelled || data?.id !== myId) return; // resultado obsoleto: ignorar
        if (data.type === 'progress') {
          setLoading({ stage: data.stage, pct: data.pct });
          return;
        }
        workerHandlerRef.current = null;
        pendingSyncRef.current = null;
        if (data.ok) {
          console.info('[terrain] resultado vía Web Worker (id', data.id + ')', data.real ? '· MDT REAL' : '');
          apply(data.model, data.contours, data.real);
        } else {
          console.warn('[terrain] worker devolvió error:', data.error);
          if (activeDem) {
            // El DEM real no aplicó (p. ej. sin cobertura): procedural y,
            // en la próxima ingesta, el nuevo DEM vuelve a intentar auto.
            setUserDemId(null);
            toast({
              title: 'MDT real no aplicable',
              description: data.error.slice(0, 140),
              variant: 'destructive',
            });
          }
          void runSync();
        }
      };
      pendingSyncRef.current = () => {
        if (!cancelled) void runSync();
      };
      void (async () => {
        if (activeDem) {
          /* A-01 · feedback inmediato y verificable: el auditor ve en qué hilo
             corre el reamuestreo mientras el badge del HUD aún no existe. */
          setLoading({ stage: `Procesando en Worker · MDT real · ${activeDem.name.slice(0, 28)}`, pct: 30 });
          /* Sin transfer del raster: el DEM puede re-aplicarse (otra región o
             quitar/volver a poner) — el clon estructurado es el precio de la
             reusabilidad. */
          w.postMessage({
            id: myId,
            type: 'generate-real',
            dem: activeDem.dem,
            region: getRegion(regionId),
            fileName: activeDem.name,
          });
        } else {
          setLoading({ stage: 'Esculpiendo el relieve', pct: 25 });
          w.postMessage({ id: myId, type: 'generate', region: getRegion(regionId) });
        }
      })();
    } else {
      void runSync();
    }

    return () => {
      cancelled = true;
      workerHandlerRef.current = null;
      pendingSyncRef.current = null;
      obs?.disconnect();
    };
  }, [regionId, activeDem, toast, writeViewHash]);

  /* Export vectorial (§6.2): SVG/PDF desde la escena del último cuadro. */
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  /* F5-03 fase 1 → #11 fase 2: el checkbox activa el hachurado EN PANTALLA
     (con guard 6 ms + auto-fallback a export-only en el motor) Y en el
     archivo exportado. Sin 10.º bit en el hash de URL (retrocompat 9 bits). */
  const [exportHachures, setExportHachures] = useState(false);
  /* FR-5 · D12: el checkbox de fricción gobierna la capa EN PANTALLA Y en
     el export; requiere campo activo. Sin 10.º bit en el hash (retrocompat). */
  const [exportFriction, setExportFriction] = useState(false);
  /* #11 fase 2: rastrea transiciones de fallback para el toast único */
  const hachFallbackRef = useRef<'' | 'guard' | 'frame'>('');
  const frictionFallbackRef = useRef<'' | 'guard' | 'frame'>('');
  const handleExport = useCallback(
    async (fmt: 'svg' | 'pdf'): Promise<void> => {
      const base = engineRef.current?.getExportScene();
      if (!base) {
        toast({
          title: 'Nada que exportar',
          description: 'Espera a que el modelo del terreno termine de generarse.',
          variant: 'destructive',
        });
        return;
      }
      setExporting(fmt);
      try {
        /* A-9 WYSIWYG: en campo, el snapshot se toma con la PRESENTACIÓN base
           (pre-preset) restaurada en el motor — paleta/niebla/mesh se hornean
           en los buckets y un parche SOLO de opts no basta. getExportScene(pres)
           re-expresa los buckets con la paleta restaurada y re-establece el
           estado vivo byte-idéntico en el MISMO turno síncrono (0 cuadros
           intermedios, 0 parpadeo). En estudio: pres = null ⇒ camino intacto. */
        const pres = fieldModeRef.current ? basePresentationRef.current : null;
        const base2 = engineRef.current?.getExportScene(pres ?? undefined) ?? base;
        const scene = {
          ...base2,
          opts: { ...base2.opts, hachures: exportHachures, friction: exportFriction },
        };
        const dl = buildDisplayList(scene);
        const name = `ti4go-${scene.model.region.id}-curvas.${fmt}`;
        const blob =
          fmt === 'svg'
            ? new Blob([serializeSvg(dl, scene)], { type: 'image/svg+xml;charset=utf-8' })
            : await serializePdf(dl, scene);
        downloadBlob(blob, name);
        const hachureNote = dl.hachures ? ` · ${dl.hachures.toLocaleString('es-MX')} hachures` : '';
        const frictionNote = dl.frictionSegs
          ? ` · ${dl.frictionSegs.toLocaleString('es-MX')} tramas D12`
          : '';
        toast({
          title: fmt === 'svg' ? 'SVG vectorial descargado' : 'PDF vectorial descargado',
          description: `${scene.model.region.name} · ${dl.segs.toLocaleString('es-MX')} segmentos${hachureNote}${frictionNote} · ${(blob.size / 1024).toFixed(0)} KB · amplía sin pérdida.`,
        });
      } catch {
        toast({
          title: 'No se pudo exportar',
          description: 'Error inesperado durante la serialización vectorial.',
          variant: 'destructive',
        });
      } finally {
        setExporting(null);
      }
    },
    [toast, exportHachures, exportFriction]
  );

  const handleCopyLink = useCallback((): void => {
    writeViewHash();
    try {
      navigator.clipboard
        .writeText(window.location.href)
        .then(() =>
          toast({
            title: 'Enlace de vista copiado',
            description: 'Región, cámara y capas viajan en el propio URL (sin servidor).',
          })
        )
        .catch(() => toast({ title: 'No se pudo copiar', variant: 'destructive' }));
    } catch {
      toast({ title: 'No se pudo copiar', variant: 'destructive' });
    }
  }, [toast, writeViewHash]);

  /* Opciones de vista (F4: el Modo Ahorro efectivo = manual OR batería baja;
     Modo Día = tema UI dark|day de next-themes) */
  const effOpts = useMemo(
    () => ({
      ...opts,
      /* FR-6 · R-1/R-3: en campo, eink/powerSave están BLOQUEADOS y se
         re-fuerzan en cada cómputo (legibilidad solar y energía no se
         negocian — FIELD_BLOCKED_OPTS; el automático por batería queda
         como refuerzo, no como requisito). */
      eink: fieldMode ? true : opts.eink,
      powerSave: fieldMode ? true : opts.powerSave || battSave,
      day: isDay,
      /* #11 fase 2: el checkbox de hachurado también gobierna la capa
         interactiva (guard + fallback viven en el motor) */
      hachures: exportHachures,
      /* FR-5 · D12: el campo de fricción exige campo activo — sin él la
         capa no se dibuja (el motor lo guarda: frictionRef null). */
      friction: exportFriction && activeFriction != null,
    }),
    [opts, battSave, isDay, exportHachures, exportFriction, activeFriction, fieldMode]
  );
  useEffect(() => {
    engineRef.current?.setOpts(effOpts);
  }, [effOpts]);

  /* FR-6 · activación ONE-SHOT del preset (spec §4/§5): al ENTRAR en campo,
     FIELD_PRESET ⊕ fieldOpts sellan el estado (applyFieldPreset); después el
     usuario opera los toggles con normalidad («reactivables por el usuario»),
     salvo los bloqueados, que effOpts re-fuerza en cada cómputo. */
  useEffect(() => {
    const entering = fieldMode && !fieldModeRef.current;
    fieldModeRef.current = fieldMode;
    if (entering) {
      /* A-9 WYSIWYG: antes de sembrar el preset se capturan las llaves de
         PRESENTACIÓN del lienzo que el preset va a pisar (eink/powerSave/
         mesh/nodes/reliefFx/forcedStep). El ARCHIVO exportado en campo se
         serializa con esta presentación base: el modo viste el lienzo,
         no la escena — export(campo) ≡ export(estudio) byte-idéntico para
         la misma región/cámara/capas. Las CAPAS (minor/major/streams/
         divides/labels/cotas/inegi) siguen el estado vivo del campo
         (garantía de misión del preset; reactivables por el usuario). */
      const prev0 = optsRef.current;
      basePresentationRef.current = {
        eink: prev0.eink,
        powerSave: prev0.powerSave,
        mesh: prev0.mesh,
        nodes: prev0.nodes,
        reliefFx: prev0.reliefFx,
        forcedStep: prev0.forcedStep,
      };
      setOpts((prev) => applyFieldPreset(prev, fieldOptsRef.current));
    }
  }, [fieldMode]);
  useEffect(() => {
    fieldOptsRef.current = fieldOpts;
  }, [fieldOpts]);

  /* FR-7/A-8 · puente GPS ↔ motor: REFACTOR-2 (hook useGpsBridge — bloques
     FR-7 y A-8 extraídos byte-idénticos; el forense cubre las decisiones
     puras anchorFromRegion/gpsMarkerPayload). */
  useGpsBridge({ region, engineRef, onHud });

  /* R-2 · A-11: los overlays PORTALIZADOS (Sheet/drawer, toasts, dropdowns de
     Select) montan fuera de la raíz .field-mode — el scope CSS por descendencia
     no los alcanza. El body lleva la marca mientras el modo está activo (con
     cleanup) para que las reglas de ergonomía ≥44 px cubran también su
     contenido. 0 timers, 0 red: sincronización determinista con el prop. */
  useEffect(() => {
    if (!fieldMode) return;
    document.body.classList.add('field-mode-host');
    return () => {
      document.body.classList.remove('field-mode-host');
    };
  }, [fieldMode]);

  const patchOpts = useCallback((o: Partial<ViewOpts>) => setOpts((prev) => ({ ...prev, ...o })), []);

  /* B-D1 · U4: toggles del panel/floating → señal ti4go:layer-select
     {layerId, uuid, layerType} (uuid vacío: las capas de vista no llevan
     identidad FR-2). applyHash sigue usando patchOpts PURO — la restauración
     del URL NO es selección del usuario y no emite. */
  const patchOptsUI = useCallback(
    (o: Partial<ViewOpts>) => {
      patchOpts(o);
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'boolean' && LAYER_TYPE_BY_KEY[k]) {
          signalCbsRef.current.onLayerSelect?.({ layerId: k, uuid: '', layerType: LAYER_TYPE_BY_KEY[k] });
        }
      }
    },
    [patchOpts]
  );
  /* Checkboxes del ExportCard (hachurado/fricción EN PANTALLA y en archivo). */
  const setExportHachuresUI = useCallback((v: boolean) => {
    setExportHachures(v);
    signalCbsRef.current.onLayerSelect?.({ layerId: 'hachures', uuid: '', layerType: 'hachura' });
  }, []);
  const setExportFrictionUI = useCallback((v: boolean) => {
    setExportFriction(v);
    signalCbsRef.current.onLayerSelect?.({ layerId: 'friction', uuid: '', layerType: 'campo-friccion' });
  }, []);

  /* Estado de vista por URL (§6.2): restauración inicial (post-hidratación,
     sin mismatch SSR) + escucha de cambios de hash externos. La cámara de la
     misma región se aplica al instante; con cambio de región se consume en
     apply() tras la regeneración (setModel→fitView). */
  const applyHash = useCallback((): void => {
    if (typeof window === 'undefined') return;
    const pv = parseViewHash(window.location.hash);
    if (!pv) return;
    const validRegion =
      pv.regionId && REGIONS.some((r) => r.id === pv.regionId) ? pv.regionId : null;
    if (validRegion && validRegion !== regionIdRef.current) {
      pendingCamRef.current = pv.cam ?? null;
      setRegionId(validRegion);
    } else if (pv.cam) {
      pendingCamRef.current = pv.cam; // por si hay regeneración en vuelo
      engineRef.current?.setCamera(pv.cam.az, pv.cam.el, pv.cam.zoom, pv.cam.panX, pv.cam.panY);
    }
    if (pv.layers) patchOpts(pv.layers);
  }, [patchOpts]);

  useEffect(() => {
    /* B-D1 · D-2: con url-sync apagado el hash NUNCA se lee ni se escucha —
     * la vista nace del default del visor (0 acceso a location.hash). */
    if (!urlSyncRef.current) return;
    applyHash();
    const onHash = (): void => applyHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [applyHash]);

  const onPreset = useCallback((p: PresetName) => engineRef.current?.applyPreset(p), []);
  const onFlyBasin = useCallback((i: number) => {
    engineRef.current?.flyToBasin(i);
    setSheetOpen(false);
  }, []);

  /* Avatar Auditoría R1 (misma lógica que el botón del panel, cita compartida) */
  const activateAudit = useCallback(() => {
    patchOpts({ forcedStep: 1 });
    const cita = buildAuditCitation(region);
    try {
      navigator.clipboard
        .writeText(cita)
        .then(() =>
          toast({
            title: 'Cita metodológica copiada',
            description: 'Auditoría R1: intervalo de 1 m forzado.',
          })
        )
        .catch(() => toast({ title: 'No se pudo copiar la cita', variant: 'destructive' }));
    } catch {
      toast({ title: 'No se pudo copiar la cita', variant: 'destructive' });
    }
  }, [patchOpts, region, toast]);

  /* ---------------- Ingesta GIS/CAD ---------------- */
  const geoms = useIngestGeoms();
  useEffect(() => {
    geomsRef.current = geoms;
    engineRef.current?.redraw();
  }, [geoms]);

  /* Breadcrumb A-8 (FR-W1 · transplante inverso): trail demo anclado al MDT
     del modelo activo. Se reconstruye con cada modelo (cambio de región /
     DEM real) en apply() y se refleja en refs para que el bucle onFrame
     (deps vacías) lo lea al vuelo — 0 coste en reposo. */
  const [crumbsOn, setCrumbsOn] = useState(false);
  const crumbsTrailRef = useRef<BreadcrumbTrail | null>(null);
  const crumbsOnRef = useRef(false);
  useEffect(() => {
    crumbsOnRef.current = crumbsOn;
    engineRef.current?.redraw();
  }, [crumbsOn]);
  const toggleCrumbs = useCallback(() => setCrumbsOn((v) => !v), []);

  /* Anclaje escénico: la geometría ingestada se normaliza a la región activa */
  /* Motor DEM Real · muestreo puntual (Task 18): clic sin arrastre sobre el
     terreno → inversión de la proyección → cota del MDT real (muestreo
     nativo bilineal si hay DEM activo; si no, de la rejilla activa). */
  const pickRef = useRef<HTMLSpanElement>(null);
  const downRef = useRef<{ x: number; y: number; t: number } | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const down = (e: PointerEvent): void => {
      if (e.isPrimary) downRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const up = (e: PointerEvent): void => {
      const d0 = downRef.current;
      downRef.current = null;
      if (!d0 || !e.isPrimary) return;
      if (Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > 5 || performance.now() - d0.t > 600) return;
      const rect = canvas.getBoundingClientRect();
      const pick = engineRef.current?.pickTerrain(e.clientX - rect.left, e.clientY - rect.top);
      if (!pick) {
        if (pickRef.current) pickRef.current.textContent = '—';
        return;
      }
      const dem = activeDemRef.current;
      const native = dem ? sampleDemElevation(dem.dem, pick.lon, pick.lat) : NaN;
      if (pickRef.current) {
        pickRef.current.textContent = Number.isFinite(native)
          ? `${native.toFixed(1)} m · DEM`
          : `${pick.z.toFixed(1)} m`;
      }
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
    };
  }, []);

  const ingestAnchor: Anchor = useMemo(
    () => ({
      extentM: region.extent,
      zMinM: region.elevMin,
      zMaxM: region.elevMax,
      centerLat: region.centerLat,
      centerLon: region.centerLon,
      regionName: region.name,
    }),
    [region]
  );

  /* ---------------- B-D1 · U4: API pública del WC ----------------
     loadMissionPack (3 canales + MXP1) · flyToBBox · setViewOpts ·
     getExportScene. Se registra en apiRef; el app la entrega al elemento
     vía Ti4goHostHooks.registerApi (same-document, sin postMessage). */
  const regionRef = useRef<RegionDef>(region);
  useEffect(() => {
    regionRef.current = region;
  }, [region]);
  const anchorRef = useRef<Anchor>(ingestAnchor);
  useEffect(() => {
    anchorRef.current = ingestAnchor;
  }, [ingestAnchor]);

  /** B-D1 · U4: el API setViewOpts USA el camino UI (patchOptsUI): si el
   *  parche conmuta capas booleanas, la señal ti4go:layer-select sale igual
   *  que en un toggle del panel — misma señal para API y UI. */
  const setViewOptsApi = useCallback((o: Partial<ViewOpts>) => patchOptsUI(o), [patchOptsUI]);

  /** A-9 WYSIWYG: misma lógica de presentación base que handleExport, sin
   *  serializar — el embedder consume la escena del último cuadro. */
  const getSceneApi = useCallback((): ReturnType<IsoEngine['getExportScene']> => {
    const eng = engineRef.current;
    if (!eng) return null;
    const pres = fieldModeRef.current ? basePresentationRef.current : null;
    return eng.getExportScene(pres ?? undefined);
  }, []);

  /** WGS84 → metros con la aproximación lineal del marco INEGI (la misma
   *  de pickTerrain): X=este, Y=norte respecto al centro de la región activa. */
  const flyToBBoxApi = useCallback((bbox: Ti4goBBox): boolean => {
    const eng = engineRef.current;
    if (!eng) return false;
    const r = regionRef.current;
    const latMid = (bbox[1] + bbox[3]) / 2;
    const mPerLon = 111320 * Math.cos((latMid * Math.PI) / 180);
    const cx = ((bbox[0] + bbox[2]) / 2 - r.centerLon) * mPerLon;
    const cy = ((bbox[1] + bbox[3]) / 2 - r.centerLat) * 110540;
    const halfW = (Math.abs(bbox[2] - bbox[0]) * mPerLon) / 2;
    const halfH = (Math.abs(bbox[3] - bbox[1]) * 110540) / 2;
    eng.flyToBBoxM(cx, cy, Math.hypot(halfW, halfH));
    return true;
  }, []);

  const loadMissionPackApi = useMemo(
    () =>
      createMissionPackLoader({
        controller: ingestCtl,
        getAnchor: () => anchorRef.current,
        setRegionId,
        onCustody: (r) => signalCbsRef.current.onCustody?.(r),
        onDivergence: (d) => signalCbsRef.current.onDivergence?.(d),
      }),
    [ingestCtl]
  );

  /* Registro del API para el elemento WC (ref vivo; null al desmontar). */
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      loadMissionPack: loadMissionPackApi,
      flyToBBox: flyToBBoxApi,
      setViewOpts: setViewOptsApi,
      getExportScene: getSceneApi,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, loadMissionPackApi, flyToBBoxApi, setViewOptsApi, getSceneApi]);

  /* Overlay: se dibuja SOLO cuando el motor redibuja (0 coste en reposo) */
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.onFrame = (cam) => {
      const cnv = overlayRef.current;
      if (!cnv) return;
      const ctx = cnv.getContext('2d');
      if (!ctx) return;
      // FR-4/D11: el overlay resuelve la gramática de línea por capa;
      // la polaridad de la tinta (E-Ink-first) sigue al tema del lienzo.
      // DRAPE-1: los features SIN cota se drapean sobre el MDT activo
      // (z del terreno + lift 2–3 px); con cota declarada, su dato manda.
      drawIngestOverlay(ctx, cam, geomsRef.current, {
        eink: eng.opts.eink,
        ink: eng.opts.day || eng.opts.eink ? '#111111' : '#e4e4e7',
        drape: {
          sampler: (x, y) => eng.sampleTerrainZ(x, y),
          stamp: eng.terrainStamp(),
          cellM: eng.terrainCellM(),
        },
      });
      // Breadcrumb A-8 (FR-W1): migas + brigadista anclados al MDT — se
      // dibuja SOLO cuando la demo está activa (0 coste en reposo).
      const cr = crumbsOnRef.current ? crumbsTrailRef.current : null;
      if (cr) {
        drawBreadcrumb(ctx, cam, cr, {
          ink: eng.opts.day || eng.opts.eink ? '#111111' : '#e4e4e7',
        });
      }
      // FR-4: medición ms/cuadro accesible para QA (7 capas vs baseline).
      (window as unknown as { __overlayPerf?: typeof overlayPerf }).__overlayPerf = overlayPerf;
      // DRAPE-1: telemetría del drape accesible para QA.
      (window as unknown as { __drapePerf?: typeof drapePerf }).__drapePerf = drapePerf;
    };
    return () => {
      eng.onFrame = null;
    };
  }, []);

  const ingestToastRejected = useCallback(
    (rejected: Array<{ name: string; reason: string }>) => {
      if (rejected.length === 0) return;
      toast({
        title:
          rejected.length === 1 ? 'Archivo rechazado' : `${rejected.length} archivos rechazados`,
        description: rejected
          .map((r) => `${r.name} — ${r.reason}`)
          .join(' · ')
          .slice(0, 160),
        variant: 'destructive',
      });
    },
    [toast]
  );

  const handleCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      if (e.dataTransfer.files.length === 0) return;
      const res = ingestCtl.ingest(e.dataTransfer.files, ingestAnchor);
      ingestToastRejected(res.rejected);
      if (res.accepted > 0) {
        toast({
          title:
            res.accepted === 1
              ? 'Archivo en cola de ingesta'
              : `${res.accepted} archivos en cola de ingesta`,
          description: 'Parseo determinista en CPU local (worker) · máx. 50 MB por archivo.',
        });
      }
    },
    [ingestAnchor, ingestToastRejected, toast]
  );

  const ingestCardProps = {
    anchor: ingestAnchor,
    activeDemId: activeDem ? activeDem.id : null,
    onUseDem: setUserDemId,
  };
  const exportCardProps = {
    onExport: (f: 'svg' | 'pdf') => void handleExport(f),
    onCopyLink: handleCopyLink,
    busy: exporting,
    hachures: exportHachures,
    onHachures: setExportHachuresUI,
    friction: exportFriction,
    onFriction: setExportFrictionUI,
    frictionAvailable: activeFriction != null,
  };
  const panelProps = { region, regionId, onRegion: setRegionId, opts, onOpts: patchOptsUI, modelInfo, onFlyBasin, onPreset, fieldMode, crumbsOn, onToggleCrumbs: toggleCrumbs, ingestSlot: <IngestCard {...ingestCardProps} />, exportSlot: <ExportCard {...exportCardProps} className="w-full" /> };
  const floatingProps = { region, opts, onOpts: patchOptsUI, modelInfo, onFlyBasin, onPreset, crumbsOn, onToggleCrumbs: toggleCrumbs };

  return (
    <div className={`flex h-[100dvh] flex-col bg-background text-foreground${fieldMode ? ' field-mode' : ''}`}>
      {/* FR-8 · banner honesto de actualización (solo con SW en waiting; 0 auto-recarga) */}
      <UpdateBanner />
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-3 sm:px-4">
        <Mountain className="h-5 w-5 shrink-0 text-orange-500" aria-hidden />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold leading-tight sm:text-base">
            {BRAND} · Microcuencas de Guanajuato
          </h1>
          <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
            Curvas de nivel 1 m · maestras 25 m · motor determinista sin GPU
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Design tokens dual Dark/Day: conmutador del tema (UI + lienzo) */}
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={toggleTheme}
            aria-label={isDay ? 'Cambiar a modo noche (dark)' : 'Cambiar a modo día (day)'}
            title={isDay ? 'Modo noche — operación crítica' : 'Modo día — campo abierto, alta luz'}
          >
            {isDay ? (
              <Moon className="h-4 w-4 text-foreground/80" aria-hidden />
            ) : (
              <Sun className="h-4 w-4 text-orange-400" aria-hidden />
            )}
          </Button>
          <Select value={regionId} onValueChange={setRegionId}>
            <SelectTrigger size="sm" className="w-[150px] sm:w-[220px]" aria-label="Seleccionar cuenca">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {REGIONS.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Avatar Auditoría R1 (solo desktop; en móvil está el botón del drawer) */}
          <AvatarButton
            className="hidden h-9 w-9 lg:grid"
            icon={<FileCheck className="h-4 w-4 text-orange-400" aria-hidden />}
            label="Activar Auditoría R1 · 1 m"
            active={opts.forcedStep === 1}
            onClick={activateAudit}
          />
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="lg:hidden" aria-label="Abrir panel de capas">
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">Capas</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side="bottom"
              aria-describedby={undefined}
              className="max-h-[75dvh] overflow-y-auto px-0 pb-6"
            >
              <SheetHeader className="px-4">
                <SheetTitle>Control del visor</SheetTitle>
              </SheetHeader>
              <TerrainPanel {...panelProps} />
            </SheetContent>
          </Sheet>
        </div>
      </header>

      {/* Lienzo */}
      <main
        className="relative min-h-0 flex-1 overflow-hidden"
        onDragEnter={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          dragDepthRef.current += 1;
          setDragging(true);
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragging(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleCanvasDrop}
      >
        <canvas
          ref={canvasRef}
          role="application"
          aria-label="Visor isométrico interactivo del terreno con curvas de nivel. Arrastrar para orbitar, rueda o pellizco para zoom."
          className="absolute inset-0 h-full w-full touch-none select-none"
        />

        {/* Overlay de geometría ingestada (CSV/OBJ/DXF) — mismo frame que el motor */}
        <canvas
          ref={overlayRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5] h-full w-full"
        />

        {/* Indicador de arrastre global (pointer-events-none: el drop cae en <main>) */}
        {dragging && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-orange-500/70 px-8 py-6 text-center">
              <Upload className="h-7 w-7 text-orange-500" aria-hidden />
              <p className="text-sm font-medium">Suelta para ingestar</p>
              <p className="font-mono text-[10px] text-muted-foreground">
                TIFF · GeoTIFF · GeoPDF · OBJ · DXF · CSV · BLEND · DWG — máx. 50 MB
              </p>
            </div>
          </div>
        )}

        {/* Cards flotantes (disolución del sidebar, escritorio lg+).
            En móvil (<lg) el drawer inferior muestra TerrainPanel completo.
            Con leyenda visible (≥sm y ≥700px) el max-h se reduce 130px para
            reservar su zona — las cards nunca pasan por detrás (QA 14). */}
        <div className="thin-scroll absolute left-3 top-3 z-10 hidden max-h-[calc(100%-88px)] w-[260px] flex-col gap-2.5 overflow-y-auto pr-0.5 lg:flex sm:[@media(min-height:700px)]:max-h-[calc(100%-218px)] [&>*]:shrink-0">
          <LayersCard {...floatingProps} />
          <PovFlyGroup {...floatingProps} />
          <ElevationCard {...floatingProps} />
          {/* GPS-ORTO (FR-7 · puerto D-1): cota honesta + consistencia vs curvas */}
          {modelInfo && <GpsCard region={region} sampleZ={modelInfo.sampleZ} />}
          <IngestCard {...ingestCardProps} />
          <SeedQrCard {...floatingProps} />
          <ExportCard {...exportCardProps} />
        </div>

        {/* Marca de agua: cajetín de plano CAD (abajo derecha, esquina típica) */}
        <div className="absolute bottom-3 right-3 z-10 hidden lg:block">
          <CadWatermark {...floatingProps} />
        </div>

        {/* HUD tipo Blender (arriba derecha) */}
        <div
          aria-label="Telemetría de cámara"
          className="ti4go-hud absolute right-3 top-3 z-10 hidden w-[168px] rounded-lg border border-border bg-card/90 px-3 py-2.5 font-mono text-[11px] shadow-md backdrop-blur sm:block"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              POV · N-panel
            </span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span className="text-muted-foreground">Azimut</span>
            <span ref={azRef} className="text-right">—</span>
            <span className="text-muted-foreground">Elevación</span>
            <span ref={elRef} className="text-right">—</span>
            <span className="text-muted-foreground">Zoom</span>
            <span ref={zoomRef} className="text-right">—</span>
            <span className="text-muted-foreground">Cota</span>
            <span
              ref={pickRef}
              className="text-right"
              title="Clic sobre el terreno: elevación muestreada del MDT (nativa si hay DEM real activo)"
            >
              —
            </span>
            <span className="text-muted-foreground">Intervalo efectivo</span>
            <span
              ref={stepRef}
              className="text-right text-orange-400"
              title={
                opts.forcedStep > 0
                  ? `Intervalo forzado a ${opts.forcedStep} m: verificación estricta activa (Auditoría R1).`
                  : 'LOD activo. Fuerce 1 m para verificación estricta (Capas → Intervalo forzado).'
              }
            >
              —
            </span>
            <span className="text-muted-foreground">Segmentos</span>
            <span ref={segRef} className="text-right">—</span>
            <span className="text-muted-foreground">Cuadro</span>
            <span ref={msRef} className="text-right">—</span>
            <span className="text-muted-foreground">Jank</span>
            <span
              ref={jankRef}
              className="text-right"
              title="Bloqueo del hilo principal en el último cambio de región: tareas largas (>50 ms) + aplicación del modelo. ~0 ms = generación 100 % fuera de hilo."
            >
              —
            </span>
          </div>
          <div className="mt-1.5 border-t border-border pt-1.5 text-[10px]">
            <span className="text-muted-foreground">Estado: </span>
            <span ref={statusRef} className="text-orange-400">—</span>
          </div>
          {modelInfo?.source === 'real' && modelInfo.realMeta && (
            <div className="mt-1 border-t border-border pt-1.5 text-[9.5px] leading-snug">
              <span className="rounded border border-orange-500/50 bg-orange-500/10 px-1 py-px font-sans text-[9px] font-semibold uppercase tracking-wide text-orange-400">
                MDT REAL
              </span>{' '}
              <span className="text-muted-foreground" title={modelInfo.realMeta.fileName}>
                {modelInfo.realMeta.coveragePct} % cobertura · {modelInfo.realMeta.crsLabel}
              </span>
            </div>
          )}
        </div>

        {/* Controles POV (derecha) */}
        <div
          role="group"
          aria-label="Controles de cámara"
          className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5"
        >
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 bg-card/90 backdrop-blur"
            onClick={() => engineRef.current?.nudge({ dAz: (15 * Math.PI) / 180 })}
            aria-label="Rotar vista a la izquierda"
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 bg-card/90 backdrop-blur"
            onClick={() => engineRef.current?.nudge({ dAz: -(15 * Math.PI) / 180 })}
            aria-label="Rotar vista a la derecha"
          >
            <RotateCw className="h-4 w-4" aria-hidden />
          </Button>
          <div className="my-1 h-px bg-border" aria-hidden />
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 bg-card/90 backdrop-blur"
            onClick={() => engineRef.current?.nudge({ dZoom: 0.3 })}
            aria-label="Acercar"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 bg-card/90 backdrop-blur"
            onClick={() => engineRef.current?.nudge({ dZoom: -0.23 })}
            aria-label="Alejar"
          >
            <Minus className="h-4 w-4" aria-hidden />
          </Button>
          <div className="my-1 h-px bg-border" aria-hidden />
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 bg-card/90 backdrop-blur"
            onClick={() => engineRef.current?.applyPreset('fit')}
            aria-label="Encajar cuenca en pantalla"
          >
            <Home className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        {/* Leyenda (abajo izquierda) — solo con altura ≥700 px: en pantallas
            cortas la columna flotante la pisaría (colisión detectada en QA) */}
        <div className="ti4go-leyenda absolute bottom-3 left-3 z-10 hidden sm:[@media(min-height:700px)]:block">
          <div
            aria-label="Leyenda"
            className="rounded-lg border border-border bg-card/90 px-3 py-2 shadow-md backdrop-blur"
          >
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Simbología
          </p>
          <div className="space-y-1 text-[10.5px] text-foreground/85">
            <div className="flex items-center gap-2">
              <span className="inline-block w-6 border-t border-[color:var(--cv-minor)]" aria-hidden />
              Curva intermedia · 1 m
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-6 border-t-2 border-[color:var(--cv-major)]" aria-hidden />
              Curva maestra · 25 m
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-6 border-t-2 border-dashed border-[color:var(--cv-divide)]" aria-hidden />
              Divisoria de aguas
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-6 border-t border-[color:var(--cv-stream)]" aria-hidden />
              Cauce
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-1.5 w-1.5 bg-[color:var(--cv-node)]" aria-hidden />
              Nodo del MDT
            </div>
          </div>
          </div>
        </div>

        {/* Overlay de carga */}
        {loading && (
          <div
            role="status"
            className="absolute inset-0 z-30 grid place-items-center bg-background/75 backdrop-blur-sm"
          >
            <div className="w-64 space-y-3 text-center">
              <Loader2 className="mx-auto h-7 w-7 animate-spin text-orange-500" aria-hidden />
              <p className="text-sm font-medium">{loading.stage}</p>
              <Progress value={loading.pct} aria-label={`Progreso: ${loading.pct}%`} />
            </div>
          </div>
        )}
        {/* FR-6 · R-2/R-4/R-5 — barra de campo: estados honestos + badge de
            fallback persistente + SLOT GPS. Solo existe en el DOM en campo. */}
        {fieldMode && (
          <FieldBar
            idle={fieldHud.idle}
            save={fieldHud.save}
            interval={fieldHud.interval}
            hachureFallback={fieldHud.hachureFallback}
            frictionFallback={fieldHud.frictionFallback}
            gpsSlot={gpsSlot}
            onExit={onFieldModeChange ? () => onFieldModeChange(false) : undefined}
          />
        )}
      </main>

      {/* Footer fijo */}
      <footer className="ti4go-footer z-20 shrink-0 border-t border-border bg-card">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-3 py-1.5 text-[10.5px] text-muted-foreground sm:px-4">
          <span className="flex items-center gap-1.5">
            <Badge variant="outline" className="border-orange-700/40 px-1.5 py-0 text-[9.5px] text-orange-700 dark:border-orange-500/40 dark:text-orange-400">
              BAJO CONSUMO
            </Badge>
            Canvas 2D · render bajo demanda · pausa en segundo plano · sin WebGL
          </span>
          <span
            className="hidden lg:inline"
            title="Sello de calidad MexiGIS · Beneficiarios registrados en los metadatos del producto"
          >
            {BRAND} v{SDK_VERSION} · Sello {QUALITY_SEAL} · Beneficiarios: {BENEFICIARIES_LINE}
          </span>
          <span className="hidden md:inline">
            Arrastrar: orbitar · Shift/der: desplazar · Rueda o pellizco: zoom · 1/3/7/5: vistas · H: encajar
          </span>
          <span className="ml-auto hidden lg:inline">
            Marco INEGI MTN 1:50 000 · F14C43D4 · F14C43E3 · F14C53A2 · F14C53B1 · modelo ilustrativo
          </span>
          <CustodiaPin />
        </div>
      </footer>
    </div>
  );
}
