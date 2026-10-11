/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * IngestCard — ingesta de archivos GIS/CAD por arrastre (drag & drop) o
 * adjunto (input file). Card flotante transparente, misma gramática visual
 * que el resto de la disolución (rounded-xl · bg-background/40 · blur).
 *
 * Formatos: TIFF, GeoTIFF, GeoPDF, OBJ, DXF, CSV, Blender (.blend), DWG.
 * Límite duro: 50 MB por archivo (validado aquí y en el worker).
 * El parseo corre 100 % en CPU local (Web Worker) — 0 GPU, 0 subidas:
 * solo los metadatos de auditoría se persisten vía /api/ingest.
 *
 * Se monta dos veces sobre el MISMO controlador (singleton): en la columna
 * flotante de escritorio y como slot superior del drawer móvil.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { INGEST_ACCEPT, MAX_FILE_BYTES, type Anchor, type IngestFormat } from '@/lib/ingest/parsers';
import { useIngestController, useIngestFiles, useIngestGeoms, useRealDems, type IngestController, type IngestFile } from './ingest';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';
import {
  Blocks,
  Box,
  Check,
  ChevronRight,
  Clock,
  Database,
  FileArchive,
  FileImage,
  FileJson,
  FileText,
  Loader2,
  Map,
  Mountain,
  PencilRuler,
  Ruler,
  Table,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';

/* --- iconos por formato ---------------------------------------------- */

const FORMAT_ICONS: Partial<Record<IngestFormat, LucideIcon>> = {
  tiff: FileImage,
  geojson: FileJson,
  kml: Map,
  pack: FileArchive,
  geopdf: FileText,
  obj: Box,
  dxf: PencilRuler,
  csv: Table,
  blend: Blocks,
  dwg: Ruler,
};

const FORMAT_CHIPS = ['TIFF', 'GeoTIFF', 'GeoPDF', 'OBJ', 'DXF', 'CSV', 'GEOJSON', 'KML', 'PACK', 'BLEND', 'DWG'];

/* #4 opción (b) — artefacto air-gap: la bitácora /api/ingest NO existe en el
   export estático; la degradación se declara en la UI en lugar de lanzar
   peticiones que solo pueden fallar (405/404). Parseo 100 % local intacto. */
const AIRGAP = process.env.NEXT_PUBLIC_AIRGAP === '1';

function formatIcon(name: string, format?: IngestFormat): LucideIcon {
  if (format) return FORMAT_ICONS[format] ?? FileText;
  const ext = (name.includes('.') ? name.split('.').pop() ?? '' : '').toLowerCase();
  const map: Record<string, IngestFormat> = {
    tif: 'tiff', tiff: 'tiff', geotiff: 'tiff',
    pdf: 'geopdf', geopdf: 'geopdf',
    obj: 'obj', dxf: 'dxf', csv: 'csv', geojson: 'geojson', json: 'geojson',
    kml: 'kml', zip: 'pack', blend: 'blend', dwg: 'dwg',
  };
  return FORMAT_ICONS[map[ext]] ?? FileText;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toLocaleString('es-MX', { maximumFractionDigits: 1 })} MB`;
  if (n >= 1024) return `${(n / 1024).toLocaleString('es-MX', { maximumFractionDigits: 0 })} KB`;
  return `${n} B`;
}

/** Resumen de entidades: top-3 tipos por conteo. */
function entitySummary(f: IngestFile): string {
  const e = f.meta?.entities;
  if (!e) return '';
  return Object.entries(e)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v.toLocaleString('es-MX')}`)
    .join(' · ');
}

/* ------------------------------------------------------------------ */

export function IngestCard({
  anchor,
  activeDemId,
  onUseDem,
  className,
  controller,
}: {
  anchor: Anchor;
  /** Motor DEM Real (Task 18): id del DEM aplicado al terreno (null = procedural) */
  activeDemId?: number | null;
  onUseDem?: (id: number | null) => void;
  className?: string;
  /** B-D1 · D-1: controller por instancia (WC); default = contexto React
   *  (que sin provider cae al singleton de la ruta app). */
  controller?: IngestController;
}) {
  const ctxCtl = useIngestController();
  const ingestCtl = controller ?? ctxCtl;
  const files = useIngestFiles();
  const geoms = useIngestGeoms();
  const dems = useRealDems();
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [logCount, setLogCount] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Bitácora persistida: refresca al resolverse archivos (done/error) */
  const settledCount = files.filter((f) => f.status === 'done' || f.status === 'error').length;
  useEffect(() => {
    if (AIRGAP) return; // bitácora no disponible en el artefacto air-gap
    let alive = true;
    fetch('/api/ingest', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => {
        if (alive && d && typeof d.count === 'number') setLogCount(d.count);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [settledCount]);

  const handleFiles = (list: FileList | File[]): void => {
    const res = ingestCtl.ingest(list, anchor);
    if (res.rejected.length > 0) {
      toast({
        title:
          res.rejected.length === 1
            ? 'Archivo rechazado'
            : `${res.rejected.length} archivos rechazados`,
        description: res.rejected
          .map((r) => `${r.name} — ${r.reason}`)
          .join(' · ')
          .slice(0, 160),
        variant: 'destructive',
      });
    }
  };

  const toggleExpanded = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doneCount = files.filter((f) => f.status === 'done').length;
  const geomCount = geoms.length;

  const contentId = useId(); // fix axe duplicate-id-aria (id por instancia —
  // la tarjeta se monta en columna flotante + drawer móvil simultáneos)

  return (
    <section
      aria-label="Ingesta de archivos GIS y CAD"
      className={cn(
        'overflow-hidden rounded-xl border border-border/40 bg-background/40 backdrop-blur-md',
        className
      )}
    >
      {/* Cabecera colapsable (misma gramática que LayersCard) */}
      <button
        type="button"
        data-state={open ? 'open' : 'closed'}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full items-center gap-2 px-2.5 transition-colors hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60"
      >
        <Upload className="h-4 w-4 text-orange-400" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Ingesta GIS/CAD
        </span>
        {AIRGAP && (
          <span
            className="rounded-full border border-muted-foreground/40 px-1.5 text-[9px] font-medium text-muted-foreground"
            title="Artefacto air-gap: parseo 100 % local, bitácora no disponible"
          >
            air-gap
          </span>
        )}
        {doneCount > 0 && (
          <span className="rounded-full border border-orange-700/40 px-1.5 text-[9px] font-medium text-orange-700 dark:border-orange-500/40 dark:text-orange-400">
            {doneCount}
          </span>
        )}
        <ChevronRight
          className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-90"
          aria-hidden
        />
      </button>

      {open && (
        <div id={contentId} className="space-y-2 px-2.5 pb-2.5">
          {/* Dropzone + adjunto */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={INGEST_ACCEPT}
              className="sr-only"
              aria-hidden
              tabIndex={-1}
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              aria-label="Adjuntar archivos GIS o CAD (máximo 50 megabytes por archivo)"
              className={cn(
                'flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60',
                dragOver
                  ? 'border-orange-500/80 bg-orange-500/10'
                  : 'border-border/50 hover:border-orange-500/40 hover:bg-background/60'
              )}
            >
              <Upload className={cn('h-4 w-4', dragOver ? 'text-orange-400' : 'text-muted-foreground')} aria-hidden />
              <span className="text-[10.5px] leading-tight text-foreground/85">
                Arrastra archivos aquí
                <span className="block text-[9.5px] text-muted-foreground">o haz clic para adjuntar</span>
              </span>
              <span className="flex max-w-full flex-wrap justify-center gap-1 pt-0.5">
                {FORMAT_CHIPS.map((c) => (
                  <span
                    key={c}
                    className="rounded border border-border/40 px-1 py-px font-mono text-[7.5px] uppercase tracking-wide text-muted-foreground/80"
                  >
                    {c}
                  </span>
                ))}
              </span>
            </button>
          </div>

          {/* Lista de archivos */}
          {files.length === 0 ? (
            <p className="text-[9.5px] leading-snug text-muted-foreground">
              Sin archivos ingestados. Límite {Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB · procesamiento
              local en CPU (worker), 0 GPU · nunca salen del navegador.
            </p>
          ) : (
            <ul role="list" className="thin-scroll max-h-56 space-y-1 overflow-y-auto pr-0.5">
              {files.map((f) => {
                const Icon = formatIcon(f.name, f.meta?.format);
                const isOpen = expanded.has(f.id);
                return (
                  <li
                    key={f.id}
                    className="rounded-lg border border-border/30 bg-background/50 px-2 py-1.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-foreground/70" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[10.5px] leading-tight text-foreground/90" title={f.name}>
                          {f.name}
                        </p>
                        <p className="font-mono text-[8.5px] text-muted-foreground">{fmtBytes(f.size)}</p>
                      </div>
                      {f.status === 'done' && (
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={`Detalle de auditoría de ${f.name}`}
                          onClick={() => toggleExpanded(f.id)}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500/60"
                        >
                          <Check className="h-3.5 w-3.5 text-orange-400" aria-hidden />
                        </button>
                      )}
                      {f.status === 'parsing' && (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-orange-400" aria-hidden />
                      )}
                      {f.status === 'queued' && (
                        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      {f.status === 'error' && (
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
                      )}
                      <button
                        type="button"
                        aria-label={`Quitar ${f.name}`}
                        onClick={() => ingestCtl.remove(f.id)}
                        className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500/60"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </div>

                    {f.status === 'parsing' && (
                      <div className="mt-1 space-y-0.5">
                        <p className="text-[9px] text-muted-foreground">
                          {f.stage} · {f.pct}%
                        </p>
                        <Progress value={f.pct} className="h-1" aria-label={`Progreso de ${f.name}: ${f.pct}%`} />
                      </div>
                    )}
                    {f.status === 'done' && f.meta && (
                      <>
                        <p className="mt-0.5 text-[9px] leading-snug text-muted-foreground">
                          <span className="text-orange-400/90">{f.meta.label}</span>
                          {entitySummary(f) && <> · {entitySummary(f)}</>}
                          {f.meta.magicOk === false && <> · firma no verificada</>}
                        </p>
                        {isOpen && (
                          <dl className="mt-1 space-y-0.5 border-t border-border/30 pt-1">
                            {f.meta.rows.map(([k, v]) => (
                              <div key={k} className="flex justify-between gap-2">
                                <dt className="shrink-0 text-[8.5px] uppercase tracking-wide text-muted-foreground/70">
                                  {k}
                                </dt>
                                <dd className="truncate text-right font-mono text-[8.5px] text-foreground/80" title={v}>
                                  {v}
                                </dd>
                              </div>
                            ))}
                            {f.meta.crs && (
                              <div className="flex justify-between gap-2">
                                <dt className="shrink-0 text-[8.5px] uppercase tracking-wide text-muted-foreground/70">
                                  CRS
                                </dt>
                                <dd className="text-right font-mono text-[8.5px] text-orange-300/80">{f.meta.crs}</dd>
                              </div>
                            )}
                            {f.meta.truncated && (
                              <p className="text-[8.5px] leading-snug text-orange-400/80">⚠ {f.meta.truncated}</p>
                            )}
                            {/* Motor DEM Real (Task 18): aplicar/quitar el MDT real */}
                            {f.status === 'done' && dems.some((d) => d.id === f.id) && onUseDem && (
                              <button
                                type="button"
                                onClick={() => onUseDem(activeDemId === f.id ? null : f.id)}
                                className={cn(
                                  'mt-1 flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-[9px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60',
                                  activeDemId === f.id
                                    ? 'border-orange-500/60 bg-orange-500/15 text-orange-300 hover:bg-orange-500/25'
                                    : 'border-border/60 text-foreground/85 hover:border-orange-500/50 hover:bg-orange-500/10 hover:text-orange-300'
                                )}
                              >
                                <Mountain
                                  className={cn('h-3 w-3', activeDemId === f.id ? 'text-orange-400' : 'text-muted-foreground')}
                                  aria-hidden
                                />
                                {activeDemId === f.id ? 'MDT real activo · quitar' : 'Aplicar como MDT del terreno'}
                              </button>
                            )}
                            {f.demError && (
                              /* #8-c (Bundle B, aprobado 2026-09-25): los rechazos de
                                 ingesta se distinguen a simple vista de los éxitos. */
                              <p className="flex items-start gap-1 text-[8.5px] leading-snug text-destructive">
                                <TriangleAlert className="mt-[1px] h-3 w-3 shrink-0" aria-hidden />
                                <span className="min-w-0 break-words">DEM: {f.demError.slice(0, 120)}</span>
                              </p>
                            )}
                          </dl>
                        )}
                      </>
                    )}
                    {f.status === 'error' && (
                      <p className="mt-0.5 text-[9px] leading-snug text-destructive/90">{f.error}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Pie: capas vectoriales + bitácora + limpiar */}
          <div className="flex items-center justify-between gap-2 border-t border-border/30 pt-1.5">
            <span className="flex min-w-0 items-center gap-1 text-[9px] text-muted-foreground">
              <Database className="h-3 w-3 shrink-0" aria-hidden />
              {geomCount > 0 ? (
                <span className="truncate">
                  <span className="text-orange-400">{geomCount}</span> capa{geomCount !== 1 ? 's' : ''} sobre el
                  lienzo ·{' '}
                </span>
              ) : null}
              bitácora: {AIRGAP ? 'no disp. (air-gap)' : logCount === null ? '…' : logCount}
            </span>
            {files.length > 0 && (
              <button
                type="button"
                aria-label="Quitar todos los archivos ingestados"
                onClick={() => ingestCtl.clear()}
                className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange-500/60"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
