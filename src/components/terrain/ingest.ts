/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Controlador de ingesta (B-D1 · D-1: instancia POR WC vía factory).
 *
 * Estado compartido entre la IngestCard del escritorio (columna flotante) y
 * el slot del drawer móvil: ambas vistas se suscriben con useSyncExternalStore
 * al mismo snapshot inmutable. El parseo corre en el Web Worker de ingesta
 * (uno POR controller); si el entorno no ofrece Worker, cae a parseo síncrono
 * (fallback).
 *
 * La ruta app conserva el singleton `ingestController` (default del contexto
 * React); cada instancia `ti4go-viewer` crea el suyo con `createIngestController()`
 * y lo provee por `IngestControllerContext` — el singleton único asumía 1 modelo
 * y es la deuda D-1 del contrato B-D1.
 *
 * Cada resultado (éxito o error) se persiste en la bitácora vía POST
 * /api/ingest — solo metadatos de auditoría, nunca el archivo.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  MAX_FILE_BYTES,
  hasKnownExtension,
  type Anchor,
  type IngestGeom,
  type IngestMeta,
} from '@/lib/ingest/parsers';
import type { DecodedDem } from '@/lib/ingest/geotiff-dem';
import type { FrictionField } from '@/lib/ingest/friction';
import type { GeoidModel } from '@/lib/ingest/geoid';
import type { IngestWorkerResponse } from './ingest.worker';

export interface IngestFile {
  id: number;
  name: string;
  size: number;
  status: 'queued' | 'parsing' | 'done' | 'error';
  stage: string;
  pct: number;
  meta: IngestMeta | null;
  error: string | null;
  hasGeom: boolean;
  /** Motor DEM Real (Task 18): ficha de decodificación (TIFF/GeoTIFF) */
  demInfo?: DemInfo;
  demError?: string;
  /** FR-5 · D12: resumen del campo de fricción (ficha/bitácora) */
  fieldInfo?: string;
  fieldError?: string;
}

/** Resumen ligero del DEM decodificado (sin el raster) */
export interface DemInfo {
  decodeMs: number;
  compression: string;
  sampleLabel: string;
  w: number;
  h: number;
  crsLabel: string;
  min: number;
  max: number;
}

/** Capa DEM real lista para alimentar el motor de terreno. */
export interface RealDemLayer {
  id: number;
  name: string;
  info: DemInfo;
  dem: DecodedDem;
}

/** FR-5 · D12: capa de campo de fricción lista para el motor de tramas. */
export interface FrictionLayer {
  id: number;
  name: string;
  field: FrictionField;
}

/** FR-7 · GGM25: capa de geoides (datum vertical ortométrico). */
export interface GeoidLayer {
  id: number;
  name: string;
  model: GeoidModel;
}

/** Capa de overlay lista para dibujar (solo archivos con geometría). */
export interface GeomLayer {
  id: number;
  name: string;
  meta: IngestMeta;
  geom: IngestGeom;
}

export interface IngestResult {
  accepted: number;
  rejected: Array<{ name: string; reason: string }>;
}

type Listener = () => void;

export class IngestController {
  private files: IngestFile[] = [];
  private filesSnap: IngestFile[] = [];
  private geoms = new Map<number, GeomLayer>();
  private geomsSnap: GeomLayer[] = [];
  private dems = new Map<number, RealDemLayer>();
  private demsSnap: RealDemLayer[] = [];
  private frictions = new Map<number, FrictionLayer>();
  private frictionsSnap: FrictionLayer[] = [];
  private geoids = new Map<number, GeoidLayer>();
  private geoidsSnap: GeoidLayer[] = [];
  private listeners = new Set<Listener>();
  private worker: Worker | null = null;
  private workerBroken = false;
  private seqId = 0;
  private msgSeq = 0;
  private handlers = new Map<number, (m: IngestWorkerResponse) => void>();
  /** Pendientes con buffer retenido: si el worker muere en vuelo, parseSync
   *  los recupera (por eso NO se transfiere el ArrayBuffer: se clona). */
  private pending = new Map<number, { name: string; buf: ArrayBuffer; anchor: Anchor }>();
  /** B-D1 · canal programático (`ingestAsync` → loadMissionPack): promesas
   *  pendientes por id de archivo, resueltas al asentar el parseo. */
  private asyncWaiters = new Map<number, { resolve: (f: IngestFile) => void; reject: (e: Error) => void }>();

  /* --- suscripción (useSyncExternalStore) ------------------------ */

  subscribeFiles = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getFilesSnapshot = (): IngestFile[] => this.filesSnap;

  subscribeGeoms = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getGeomsSnapshot = (): GeomLayer[] => this.geomsSnap;

  subscribeDems = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getDemsSnapshot = (): RealDemLayer[] => this.demsSnap;

  subscribeFrictions = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getFrictionsSnapshot = (): FrictionLayer[] => this.frictionsSnap;

  subscribeGeoids = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getGeoidsSnapshot = (): GeoidLayer[] => this.geoidsSnap;

  /** FR-7 · GGM25: geoides ingestado por id de archivo (CustodyReceipt). */
  getGeoidFor = (id: number): GeoidLayer | undefined => this.geoids.get(id);

  private emit(): void {
    this.filesSnap = [...this.files];
    this.geomsSnap = [...this.geoms.values()];
    this.demsSnap = [...this.dems.values()];
    this.frictionsSnap = [...this.frictions.values()];
    this.geoidsSnap = [...this.geoids.values()];
    for (const fn of this.listeners) fn();
  }

  private patch(id: number, changes: Partial<IngestFile>): void {
    const i = this.files.findIndex((f) => f.id === id);
    if (i < 0) return;
    this.files[i] = { ...this.files[i], ...changes };
  }

  /* --- ingesta ---------------------------------------------------- */

  /** Valida tamaño/formato, encola y envía al worker. Los rechazos se
   *  reportan al llamador para el toast (no se guardan en la lista). */
  ingest(list: FileList | File[], anchor: Anchor): IngestResult {
    const rejected: IngestResult['rejected'] = [];
    let accepted = 0;
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) {
        rejected.push({ name: file.name, reason: 'supera 50 MB' });
        continue;
      }
      if (!hasKnownExtension(file.name)) {
        rejected.push({ name: file.name, reason: 'formato no soportado' });
        continue;
      }
      const id = ++this.seqId;
      this.files.push({
        id,
        name: file.name,
        size: file.size,
        status: 'queued',
        stage: 'En cola',
        pct: 0,
        meta: null,
        error: null,
        hasGeom: false,
      });
      accepted++;
      void this.readFileAndParse(id, file, anchor);
    }
    if (accepted > 0) this.emit();
    return { accepted, rejected };
  }

  private async readFileAndParse(id: number, file: File, anchor: Anchor): Promise<void> {
    this.patch(id, { status: 'parsing', stage: 'Leyendo archivo', pct: 4 });
    this.emit();
    try {
      const buf = await file.arrayBuffer();
      this.patch(id, { pct: 6 });
      this.emit();
      this.sendToWorker(id, file.name, buf, anchor);
    } catch (err) {
      this.patch(id, { status: 'error', error: `No se pudo leer: ${String(err)}` });
      this.emit();
      void this.persist(this.files.find((f) => f.id === id) ?? null);
    }
  }

  private sendToWorker(id: number, name: string, buf: ArrayBuffer, anchor: Anchor): void {
    if (this.workerBroken) {
      void this.parseSync(id, name, buf, anchor);
      return;
    }
    const w = this.ensureWorker();
    if (!w) {
      this.workerBroken = true;
      void this.parseSync(id, name, buf, anchor);
      return;
    }
    const msgId = ++this.msgSeq;
    // Mapa por id de archivo: un archivo = una petición vigente
    this.handlers.set(id, (m) => this.onWorkerMessage(id, m));
    // Buffer retenido (sin transfer) para poder recuperar si el worker muere;
    // el clon estructurado de 50 MB es barato frente a perder el archivo.
    this.pending.set(id, { name, buf, anchor });
    w.postMessage({ id: msgId, fileId: id, name, size: buf.byteLength, buf, anchor });
  }

  private onWorkerMessage(id: number, m: IngestWorkerResponse): void {
    if (m.type === 'progress') {
      this.patch(id, { status: 'parsing', stage: m.stage, pct: m.pct });
      this.emit();
      return;
    }
    this.handlers.delete(id);
    this.pending.delete(id);
    if (m.ok) {
      const demInfo: DemInfo | undefined = m.dem
        ? {
            decodeMs: m.dem.decodeMs,
            compression: m.dem.compression,
            sampleLabel: m.dem.sampleLabel,
            w: m.dem.w,
            h: m.dem.h,
            crsLabel: m.dem.crs.label,
            min: m.dem.min,
            max: m.dem.max,
          }
        : undefined;
      const fieldInfo: string | undefined = m.field
        ? `D12 · clases ${m.field.classCounts.join('/')} · costo ${m.field.vmin.toPrecision(4)}–${m.field.vmax.toPrecision(4)}`
        : m.meta.rows.find(([k]) => k === 'Campo de fricción (D12)')?.[1];
      this.patch(id, {
        status: 'done',
        stage: 'Listo',
        pct: 100,
        meta: m.meta,
        hasGeom: m.geom !== null,
        demInfo,
        demError: m.demError,
        fieldInfo,
      });
      if (m.geom) {
        const f = this.files.find((x) => x.id === id);
        this.geoms.set(id, { id, name: f?.name ?? `#${id}`, meta: m.meta, geom: m.geom });
      }
      if (m.dem && demInfo) {
        const f = this.files.find((x) => x.id === id);
        // RECORTADOR (transplante inverso): demName = .tif extraído del ZIP
        // topográfico — nombre preferente del DEM en el store.
        this.dems.set(id, { id, name: m.demName ?? f?.name ?? `#${id}`, info: demInfo, dem: m.dem });
      }
      if (m.field) {
        const f = this.files.find((x) => x.id === id);
        this.frictions.set(id, { id, name: f?.name ?? `#${id}`, field: m.field });
      }
      if (m.geoid) {
        const f = this.files.find((x) => x.id === id);
        this.geoids.set(id, { id, name: f?.name ?? `#${id}`, model: m.geoid });
      }
    } else {
      this.patch(id, { status: 'error', stage: 'Error', error: m.error });
    }
    this.settle(id);
    this.emit();
    void this.persist(this.files.find((f) => f.id === id) ?? null);
  }

  /** Fallback sin Worker: parseo síncrono en hilo principal. */
  private async parseSync(id: number, name: string, buf: ArrayBuffer, anchor: Anchor): Promise<void> {
    try {
      const { parseFile } = await import('@/lib/ingest/parsers');
      const result = parseFile(name, buf, anchor, (stage, pct) => {
        this.patch(id, { status: 'parsing', stage, pct });
        this.emit();
      });
      this.patch(id, { status: 'done', stage: 'Listo', pct: 100, meta: result.meta, hasGeom: result.geom !== null });
      if (result.geom) {
        const f = this.files.find((x) => x.id === id);
        this.geoms.set(id, { id, name: f?.name ?? `#${id}`, meta: result.meta, geom: result.geom });
      }
      if (result.field) {
        const f = this.files.find((x) => x.id === id);
        this.frictions.set(id, { id, name: f?.name ?? `#${id}`, field: result.field });
        this.patch(id, {
          fieldInfo: `D12 · clases ${result.field.classCounts.join('/')}`,
        });
      }
      if (result.geoid) {
        const f = this.files.find((x) => x.id === id);
        this.geoids.set(id, { id, name: f?.name ?? `#${id}`, model: result.geoid });
      }
    } catch (err) {
      this.patch(id, { status: 'error', stage: 'Error', error: String(err instanceof Error ? err.message : err) });
    }
    this.settle(id);
    this.emit();
    void this.persist(this.files.find((f) => f.id === id) ?? null);
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') {
      this.workerBroken = true;
      return null;
    }
    try {
      const w = new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent) => {
        const data = ev.data as IngestWorkerResponse & { fileId?: number };
        // El worker reenvía fileId; si no, resuelve por id de mensaje
        const fileId = typeof data.fileId === 'number' ? data.fileId : -1;
        const h = this.handlers.get(fileId);
        if (h) h(data);
      };
      w.onerror = (e: ErrorEvent) => {
        console.info('[ingest] worker onerror:', e.message || 'carga fallida');
        this.workerBroken = true;
        this.handlers.clear();
        // Recuperación: parseo síncrono de todo lo que estaba en vuelo
        for (const [id, p] of this.pending) void this.parseSync(id, p.name, p.buf, p.anchor);
        this.pending.clear();
      };
      this.worker = w;
      return w;
    } catch (err) {
      console.warn('[ingest] worker constructor lanzó:', String(err));
      this.workerBroken = true;
      return null;
    }
  }

  /* --- gestión de lista ------------------------------------------- */

  remove(id: number): void {
    const w = this.asyncWaiters.get(id);
    if (w) {
      this.asyncWaiters.delete(id);
      w.reject(new Error('removido durante el parseo'));
    }
    this.files = this.files.filter((f) => f.id !== id);
    this.geoms.delete(id);
    this.dems.delete(id);
    this.frictions.delete(id);
    this.geoids.delete(id);
    this.handlers.delete(id);
    this.pending.delete(id);
    this.emit();
  }

  clear(): void {
    for (const [, w] of this.asyncWaiters) w.reject(new Error('limpieza de la cola'));
    this.asyncWaiters.clear();
    this.files = [];
    this.geoms.clear();
    this.dems.clear();
    this.frictions.clear();
    this.geoids.clear();
    this.handlers.clear();
    this.pending.clear();
    this.emit();
  }

  /** B-D1 · canal programático (`loadMissionPack`): ingesta de UN archivo
   *  in-memory con los MISMOS límites del canal UI, que resuelve al asentar
   *  el parseo (worker o fallback síncrono) y rechaza con el motivo. */
  ingestAsync(name: string, buf: ArrayBuffer, anchor: Anchor): Promise<IngestFile> {
    return new Promise<IngestFile>((resolve, reject) => {
      if (buf.byteLength > MAX_FILE_BYTES) {
        reject(new Error('supera 50 MB'));
        return;
      }
      if (!hasKnownExtension(name)) {
        reject(new Error('formato no soportado'));
        return;
      }
      const id = ++this.seqId;
      this.files.push({
        id,
        name,
        size: buf.byteLength,
        status: 'queued',
        stage: 'En cola',
        pct: 0,
        meta: null,
        error: null,
        hasGeom: false,
      });
      this.asyncWaiters.set(id, { resolve, reject });
      this.emit();
      this.sendToWorker(id, name, buf, anchor);
    });
  }

  /** Resuelve/rechaza la promesa de `ingestAsync` con el estado FINAL del
   *  archivo (idempotente: solo el primer settle cuenta). */
  private settle(id: number): void {
    const w = this.asyncWaiters.get(id);
    if (!w) return;
    this.asyncWaiters.delete(id);
    const f = this.files.find((x) => x.id === id) ?? null;
    if (f && f.status === 'done') w.resolve(f);
    else w.reject(new Error(f?.error ?? 'parseo fallido'));
  }

  /** B-D1 · D-1: libera los recursos del controller (worker, handlers,
   *  pendientes y promesas en vuelo). Tras dispose() la instancia NO es
   *  re-utilizable — una por instancia WC, sin fugas entre montajes. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerBroken = true;
    this.handlers.clear();
    this.pending.clear();
    for (const [, w] of this.asyncWaiters) w.reject(new Error('controller dispuesto'));
    this.asyncWaiters.clear();
    this.listeners.clear();
    this.files = [];
    this.geoms.clear();
    this.dems.clear();
    this.frictions.clear();
    this.geoids.clear();
  }

  /* --- bitácora persistida (API) ----------------------------------- */

  private async persist(f: IngestFile | null): Promise<void> {
    if (!f || f.status === 'queued' || f.status === 'parsing') return;
    // #4 opción (b): en el artefacto air-gap la bitácora no existe — skip silencioso
    if (process.env.NEXT_PUBLIC_AIRGAP === '1') return;
    // H-3 (checkpoint FR-3): la custodia NO puede fallar en silencio —
    // todo fallo de bitácora deja traza visible en consola.
    try {
      const custody = f.meta?.custody;
      const baseNote = (
        f.meta?.truncated ??
        f.error ??
        (f.fieldInfo
          ? `campo de fricción decodificado — ${f.fieldInfo}`
          : f.demInfo
            ? `DEM decodificado ${f.demInfo.w}×${f.demInfo.h} ${f.demInfo.compression} en ${f.demInfo.decodeMs.toFixed(0)} ms`
            : f.demError ?? '')
      ).slice(0, 240);
      await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: f.name.slice(0, 200),
          format: f.meta?.format ?? 'unknown',
          sizeBytes: f.size,
          status: f.status,
          entities: f.meta?.entities ?? null,
          crs: f.meta?.crs ?? null,
          note: custody ? `${custody} · ${baseNote}`.slice(0, 300) : baseNote.slice(0, 300),
        }),
      });
    } catch (err) {
      console.info('[ingest] bitácora no registrada:', f.name, String(err));
      /* bitácora best-effort: nunca bloquea la UI, pero la ausencia de
       * custodia queda VISIBLE (H-3) — no silencio. */
    }
  }
}

export const ingestController = new IngestController();

/** B-D1 · D-1: factory por instancia — cada `ti4go-viewer` crea SU
 *  controller (y SU worker de ingesta) eliminando la suposición de singleton
 *  único («asume 1 modelo»). La ruta app sigue usando el default. */
export function createIngestController(): IngestController {
  return new IngestController();
}

/** Contexto React: el provider lo inyecta el WC con su controller por
 *  instancia; sin provider, TODOS los consumidores caen al singleton default
 *  (ruta app intacta). */
export const IngestControllerContext = createContext<IngestController>(ingestController);

/** Controller vigente: override por contexto (WC) o el singleton de la app. */
export function useIngestController(): IngestController {
  return useContext(IngestControllerContext);
}

/* --- hooks de React -------------------------------------------------- */

export function useIngestFiles(): IngestFile[] {
  const ctl = useIngestController();
  return useSyncExternalStore(
    ctl.subscribeFiles,
    ctl.getFilesSnapshot,
    ctl.getFilesSnapshot // getServerSnapshot (SSR: lista vacía estable)
  );
}

export function useIngestGeoms(): GeomLayer[] {
  const ctl = useIngestController();
  return useSyncExternalStore(
    ctl.subscribeGeoms,
    ctl.getGeomsSnapshot,
    ctl.getGeomsSnapshot // getServerSnapshot (SSR: lista vacía estable)
  );
}

/** Capas DEM real decodificadas (Motor DEM Real, Task 18) */
export function useRealDems(): RealDemLayer[] {
  const ctl = useIngestController();
  return useSyncExternalStore(
    ctl.subscribeDems,
    ctl.getDemsSnapshot,
    ctl.getDemsSnapshot // getServerSnapshot (SSR: lista vacía estable)
  );
}

/** FR-5 · D12: campos de fricción decodificados (suelto `fricc*` o pack). */
export function useFrictionFields(): FrictionLayer[] {
  const ctl = useIngestController();
  return useSyncExternalStore(
    ctl.subscribeFrictions,
    ctl.getFrictionsSnapshot,
    ctl.getFrictionsSnapshot // getServerSnapshot (SSR: lista vacía estable)
  );
}

/** FR-7 · GGM25: modelos de geoides ingestado (sub-grid del pack o ZIP). */
export function useGeoidModels(): GeoidLayer[] {
  const ctl = useIngestController();
  return useSyncExternalStore(
    ctl.subscribeGeoids,
    ctl.getGeoidsSnapshot,
    ctl.getGeoidsSnapshot // getServerSnapshot (SSR: lista vacía estable)
  );
}
