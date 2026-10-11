/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * ExportCard — export vectorial de la escena (§6.2 del roadmap 0 GPU).
 *
 * Tres acciones, todas locales (0 servidor):
 *  - SVG: documento vectorial editable (curvas exactas del último cuadro).
 *  - PDF: escritor propio PDF 1.4 con ficha técnica y metadatos de marca.
 *  - Copiar enlace de vista: el estado completo (región + cámara + capas)
 *    vive en el fragmento del URL — compartir/guardar sin servidor.
 *
 * WYSIWYG: el export contiene exactamente la geometría visible (mismo
 * intervalo efectivo, rango de elevación, capas activas y paleta).
 */

import { FileDown, FileText, Link2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export type ExportFormat = 'svg' | 'pdf' | 'link';

export interface ExportCardProps {
  onExport: (fmt: Exclude<ExportFormat, 'link'>) => void;
  onCopyLink: () => void;
  /** Formato en curso (deshabilita los botones y muestra el spinner). */
  busy: ExportFormat | null;
  className?: string;
  /** F5-03 fase 1: hachurado de pendiente SOLO en el archivo exportado. */
  hachures?: boolean;
  onHachures?: (v: boolean) => void;
  /** FR-5 · D12: tramas del campo de fricción en pantalla y export. */
  friction?: boolean;
  onFriction?: (v: boolean) => void;
  /** Sin campo activo el toggle se deshabilita (honesto). */
  frictionAvailable?: boolean;
}

export function ExportCard({
  onExport,
  onCopyLink,
  busy,
  className,
  hachures,
  onHachures,
  friction,
  onFriction,
  frictionAvailable,
}: ExportCardProps) {
  const disabled = busy !== null;
  return (
    <section
      aria-label="Exportar vista"
      className={cn(
        'w-[240px] rounded-xl border border-border/40 bg-background/40 backdrop-blur-md',
        className
      )}
    >
      <div className="px-3 pt-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Exportar · vectorial
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 px-3">
        <Button
          variant="outline"
          size="sm"
          className="h-9 text-xs disabled:opacity-100 disabled:text-muted-foreground disabled:border-border"
          disabled={disabled}
          onClick={() => onExport('svg')}
          aria-label="Exportar la vista como SVG vectorial"
        >
          {busy === 'svg' ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-orange-500" aria-hidden />
          ) : (
            <FileDown className="mr-1.5 h-3.5 w-3.5 text-orange-500" aria-hidden />
          )}
          SVG
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-9 text-xs disabled:opacity-100 disabled:text-muted-foreground disabled:border-border"
          disabled={disabled}
          onClick={() => onExport('pdf')}
          aria-label="Exportar la vista como PDF vectorial"
        >
          {busy === 'pdf' ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-orange-500" aria-hidden />
          ) : (
            <FileText className="mr-1.5 h-3.5 w-3.5 text-orange-500" aria-hidden />
          )}
          PDF
        </Button>
      </div>
      <div className="px-3 pb-2.5 pt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full text-xs disabled:opacity-100 disabled:text-muted-foreground disabled:border-border"
          disabled={disabled}
          onClick={onCopyLink}
          aria-label="Copiar el enlace del estado de vista actual"
        >
          {busy === 'link' ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-orange-500" aria-hidden />
          ) : (
            <Link2 className="mr-1.5 h-3.5 w-3.5 text-orange-500" aria-hidden />
          )}
          Copiar enlace de vista
        </Button>
        {onHachures && (
          <label className="mt-2 flex cursor-pointer items-start gap-1.5 rounded-md border border-border/50 bg-muted/30 p-2">
            <Checkbox
              checked={hachures ?? false}
              onCheckedChange={(v) => onHachures(v === true)}
              aria-label="Activar hachurado de pendiente en pantalla y en el archivo exportado"
              className="mt-[1px]"
            />
            <span className="min-w-0">
              <span className="block text-[10px] font-medium leading-tight">Hachurado de pendiente</span>
              <span className="block text-[9px] leading-snug text-muted-foreground">
                Tramas Lehmann en pantalla y archivo · guard 6 ms con fallback export-only
                automático (#11 fase 2)
              </span>
            </span>
          </label>
        )}
        {onFriction && (
          <label
            className={cn(
              'mt-1.5 flex items-start gap-1.5 rounded-md border border-border/50 bg-muted/30 p-2',
              frictionAvailable ? 'cursor-pointer' : 'cursor-not-allowed'
              // Sin opacity sobre el bloque: el texto guía («cómo activar la
              // capa») debe seguir legible — WCAG 1.4.3 (axe color-contrast,
              // re-auditoría D-2/D-4 2026-10-02); la señal visual de
              // indisponibilidad vive SOLO en el checkbox.
            )}
          >
            <Checkbox
              checked={(friction ?? false) && frictionAvailable !== false}
              disabled={frictionAvailable === false}
              onCheckedChange={(v) => onFriction(v === true)}
              aria-label="Activar tramas del campo de fricción en pantalla y en el archivo exportado"
              className={`mt-[1px]${frictionAvailable === false ? ' opacity-60' : ''}`}
            />
            <span className="min-w-0">
              <span className="block text-[10px] font-medium leading-tight">Tramas de fricción · D12</span>
              <span className="block text-[9px] leading-snug text-muted-foreground">
                {frictionAvailable === false
                  ? 'Ingesta un campo de fricción (friccion*.tif / rol FRICTION del pack) para activar la capa'
                  : 'Campo de costo bajo el linework · 4 clases E-Ink · guard 6 ms con fallback export-only'}
              </span>
            </span>
          </label>
        )}
        <p className="mt-1.5 text-[9.5px] leading-snug text-muted-foreground">
          La escena es 100 % vectorial: el archivo reproduce el trazo exacto y amplía sin
          pérdida. El enlace guarda región, cámara y capas en el propio URL.
        </p>
      </div>
    </section>
  );
}
