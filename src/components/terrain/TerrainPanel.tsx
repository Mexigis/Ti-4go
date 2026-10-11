/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * Panel de control del visor: ubicación, microcuencas, capas, rango de
 * elevación, vistas y ficha técnica. Se usa en el panel lateral (escritorio)
 * y dentro del drawer inferior (móvil).
 */

import { memo } from 'react';
import type { PresetName, ViewOpts } from '@/lib/terrain/engine';
import type { TerrainStats } from '@/lib/terrain/generator';
import type { RegionDef } from '@/lib/terrain/regions';
import { REGIONS } from '@/lib/terrain/regions';
import {
  BRAND,
  BENEFICIARIES_LINE,
  DEVELOPER,
  LICENSE_TIERS,
  QUALITY_SEAL,
  SDK_VERSION,
} from '@/lib/branding';
import { packRegionSeed, unpackRegionSeed } from '@/lib/terrain/seedpack';
import { buildAuditCitation } from './audit';
import { GpsCard } from './GpsCard';
import { useToast } from '@/hooks/use-toast';
import {
  INEGI_FORMAT,
  INEGI_ROWS,
  INEGI_SCALE,
  INEGI_SHEETS,
} from '@/lib/terrain/inegi';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ROADMAP_METRICS,
  ROADMAP_PHASES,
  ROADMAP_RISKS,
  ROADMAP_UPDATED,
  STATUS_META,
} from '@/lib/terrain/roadmap';
import {
  Check,
  ChevronRight,
  ClipboardCopy,
  Compass,
  Cpu,
  ExternalLink,
  FileCheck,
  Gauge,
  Move3d,
  Package,
  Scan,
  ShieldAlert,
  ShieldCheck,
  SquareDashed,
} from 'lucide-react';

/** Esquema de indexación MTN de un cuadrángulo: filas A–E × columnas 1–5 */
function SheetIndexGrid({
  quad,
  highlight,
}: {
  quad: string;
  highlight: Array<{ row: number; col: number; label: string }>;
}) {
  const cell = 18;
  const ox = 16;
  const oy = 14;
  const w = ox + 5 * cell + 2;
  const h = oy + 5 * cell + 2;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-[106px] w-auto"
        role="img"
        aria-label={`Esquema de indexación del cuadrángulo ${quad}: filas A a E, columnas 1 a 5, con cartas resaltadas`}
      >
        {[1, 2, 3, 4, 5].map((c) => (
          <text
            key={c}
            x={ox + (c - 0.5) * cell}
            y={oy - 4}
            textAnchor="middle"
            fontSize={8}
            fontFamily="ui-monospace, monospace"
            className="fill-[color:var(--dt-fg-tertiary)]"
          >
            {c}
          </text>
        ))}
        {INEGI_ROWS.map((r, i) => (
          <text
            key={r}
            x={ox - 6}
            y={oy + (i + 0.5) * cell}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={8}
            fontFamily="ui-monospace, monospace"
            className="fill-[color:var(--dt-fg-tertiary)]"
          >
            {r}
          </text>
        ))}
        {INEGI_ROWS.map((_, ri) =>
          [1, 2, 3, 4, 5].map((c) => {
            const hi = highlight.find((hl) => hl.row === ri && hl.col === c);
            return (
              <rect
                key={`${ri}-${c}`}
                x={ox + (c - 1) * cell}
                y={oy + ri * cell}
                width={cell - 1.5}
                height={cell - 1.5}
                rx={2}
                fill={hi ? 'rgba(249, 115, 22, 0.22)' : 'transparent'}
                stroke={hi ? '#f97316' : 'rgba(113, 113, 122, 0.4)'}
                strokeWidth={hi ? 1.2 : 0.7}
              />
            );
          })
        )}
        {highlight.map((hl) => (
          <text
            key={hl.label}
            x={ox + (hl.col - 0.5) * cell}
            y={oy + (hl.row + 0.5) * cell}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={7.5}
            fontFamily="ui-monospace, monospace"
            className="fill-orange-400"
          >
            {hl.label}
          </text>
        ))}
      </svg>
      <span className="font-mono text-[10px] text-muted-foreground">{quad}</span>
    </div>
  );
}

export interface ModelInfo {
  stats: TerrainStats;
  levels: number;
  totalSegs: number;
  maestras: number;
  basinNames: string[];
  /** Motor DEM Real (Task 18): origen del modelo mostrado */
  source: 'procedural' | 'real';
  realMeta?: import('@/lib/terrain/dem').RealDemMeta;
  /** GPS-ORTO (puerto D-1): muestreo honesto del MDT activo (null fuera
   *  del recorte) — procedural o DEM real del CEM; sampleGridZ con bounds. */
  sampleZ: (xM: number, yM: number) => number | null;
}

interface PanelProps {
  region: RegionDef;
  regionId: string;
  onRegion: (id: string) => void;
  opts: ViewOpts;
  onOpts: (o: Partial<ViewOpts>) => void;
  modelInfo: ModelInfo | null;
  onFlyBasin: (i: number) => void;
  onPreset: (p: PresetName) => void;
  /** FR-6 · Modo Campo activo: los toggles fijados por el preset (E-Ink,
   *  Ahorro) se DESHABILITAN con nota honesta — el canvas los re-fuerza. */
  fieldMode?: boolean;
  /** Slot superior opcional (IngestCard en el drawer móvil). */
  ingestSlot?: React.ReactNode;
  /** Slot de export vectorial (ExportCard en el drawer móvil). */
  exportSlot?: React.ReactNode;
  /** Breadcrumb A-8 (FR-W1 · transplante inverso): demo de migas ancladas
   *  al MDT con brigadista — 0 coste en reposo. */
  crumbsOn?: boolean;
  onToggleCrumbs?: () => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  disabledNote,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** FR-6 · deshabilitado honesto: el preset de Modo Campo fija esta opción. */
  disabled?: boolean;
  disabledNote?: string;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-2 py-1 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      title={disabled ? disabledNote : undefined}
    >
      <span className="text-xs text-foreground/90">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px] text-foreground">{value}</span>
    </div>
  );
}

const PRESETS: Array<{ id: PresetName; label: string; hint: string }> = [
  { id: 'iso', label: 'Isométrico', hint: '5' },
  { id: 'top', label: 'Cenital', hint: '7' },
  { id: 'front', label: 'Frente', hint: '1' },
  { id: 'side', label: 'Perfil', hint: '3' },
  { id: 'fit', label: 'Encajar', hint: 'H' },
];

function TerrainPanelBase({
  region,
  regionId,
  onRegion,
  opts,
  onOpts,
  modelInfo,
  onFlyBasin,
  onPreset,
  fieldMode,
  ingestSlot,
  exportSlot,
  crumbsOn,
  onToggleCrumbs,
}: PanelProps) {
  const fmt = (n: number, d = 0) =>
    n.toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d });
  const { toast } = useToast();
  const seedCode = packRegionSeed(region);
  const seedInfo = unpackRegionSeed(seedCode);

  return (
    <div className="space-y-4 p-4">
      {/* Ingesta GIS/CAD (slot compartido con la columna flotante desktop) */}
      {ingestSlot && <div className="pb-1">{ingestSlot}</div>}

      {/* Export vectorial (§6.2: SVG/PDF + enlace de vista) */}
      {exportSlot && <div className="pb-1">{exportSlot}</div>}

      {/* Ubicación */}
      <section aria-label="Ubicación" className="space-y-2">
        <SectionTitle>Ubicación</SectionTitle>
        <Select value={regionId} onValueChange={onRegion}>
          <SelectTrigger size="sm" className="w-full" aria-label="Seleccionar microcuenca">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REGIONS.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="font-mono text-[10.5px] text-muted-foreground">
          {Math.abs(region.centerLat).toFixed(4)}° N, {Math.abs(region.centerLon).toFixed(4)}° W ·{' '}
          {region.subtitle}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {region.official ? (
            <Badge variant="outline" className="border-orange-500/50 text-orange-400">
              Superficie oficial SMAOT
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Superficie aproximada
            </Badge>
          )}
          <Badge variant="outline" className="text-muted-foreground">
            {fmt(region.areaHa)} ha
          </Badge>
        </div>
      </section>

      <Separator />

      {/* GPS-ORTO (FR-7 · puerto D-1): cota honesta + consistencia vs curvas */}
      {modelInfo && <GpsCard region={region} sampleZ={modelInfo.sampleZ} />}

      <Separator />

      {/* Marco cartográfico INEGI */}
      <section aria-label="Marco cartográfico INEGI" className="space-y-2">
        <SectionTitle>Marco cartográfico INEGI</SectionTitle>
        <div className="space-y-1">
          {INEGI_SHEETS.map((s) => (
            <div
              key={s.code}
              className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/30 px-2 py-1"
            >
              <span className="font-mono text-[11px] font-semibold text-orange-400">{s.code}</span>
              <span className="text-[10px] text-muted-foreground">MTN {INEGI_SCALE}</span>
              <span className="font-mono text-[9.5px] text-muted-foreground">
                fila {s.row} · col {s.col}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-center gap-5 pt-1">
          <SheetIndexGrid
            quad="F14C43"
            highlight={[
              { row: 3, col: 4, label: 'D4' },
              { row: 4, col: 3, label: 'E3' },
            ]}
          />
          <SheetIndexGrid
            quad="F14C53"
            highlight={[
              { row: 0, col: 2, label: 'A2' },
              { row: 1, col: 1, label: 'B1' },
            ]}
          />
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Las cuatro cartas del MTN {INEGI_SCALE} ({INEGI_FORMAT}) abarcan en conjunto la zona de
          estudio de la Cuenca de la Soledad — marco documentado en tesis de la Universidad de
          Guanajuato. Indexación por cuadrángulo: filas A–E (norte→sur), columnas 1–5
          (poniente→oriente).
        </p>
        <a
          href="https://www.inegi.org.mx/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-[10.5px] text-orange-400 underline decoration-orange-500/40 underline-offset-2 transition-colors hover:text-orange-300"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          Cartas oficiales en inegi.org.mx
        </a>
      </section>

      <Separator />

      {/* Microcuencas */}
      <section aria-label="Microcuencas y subcuencas" className="space-y-2">
        <SectionTitle>Microcuencas · vuelo directo</SectionTitle>
        <div className="space-y-1">
          {(modelInfo?.basinNames ?? region.basins.map((b) => b.name)).map((name, i) => (
            <Button
              key={name}
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start text-xs font-normal text-foreground/85 hover:bg-accent hover:text-foreground"
              onClick={() => onFlyBasin(i)}
            >
              <Compass className="mr-2 h-3.5 w-3.5 text-orange-500" aria-hidden />
              {name}
            </Button>
          ))}
        </div>
      </section>

      <Separator />

      {/* Capas */}
      <section aria-label="Capas" className="space-y-1">
        <SectionTitle>Capas</SectionTitle>
        <Toggle
          label="Curvas intermedias · 1 m"
          checked={opts.minor}
          onChange={(v) => onOpts({ minor: v })}
        />
        <Toggle
          label="Curvas maestras · 25 m"
          checked={opts.major}
          onChange={(v) => onOpts({ major: v })}
        />
        <Toggle label="Cotas en maestras" checked={opts.cotas} onChange={(v) => onOpts({ cotas: v })} />
        <Toggle label="Divisorias de aguas" checked={opts.divides} onChange={(v) => onOpts({ divides: v })} />
        <Toggle label="Red de drenaje" checked={opts.streams} onChange={(v) => onOpts({ streams: v })} />
        <Toggle label="Malla base del MDT" checked={opts.mesh} onChange={(v) => onOpts({ mesh: v })} />
        <Toggle label="Nodos del MDT" checked={opts.nodes} onChange={(v) => onOpts({ nodes: v })} />
        <Toggle
          label="Etiquetas de subcuenca"
          checked={opts.labels}
          onChange={(v) => onOpts({ labels: v })}
        />
        <Toggle
          label="Marco cartográfico INEGI"
          checked={opts.inegi}
          onChange={(v) => onOpts({ inegi: v })}
        />
        <Toggle
          label="Modo E-Ink · B/N puro"
          checked={opts.eink}
          disabled={fieldMode}
          disabledNote="Fijado por Modo Campo: papel blanco + tinta negra (legibilidad solar)."
          onChange={(v) => onOpts({ eink: v })}
        />
        <p className="text-[10px] leading-snug text-muted-foreground">
          Tinta negra sobre papel blanco: para tinta electrónica, impresión y lectura prolongada.
        </p>
        {onToggleCrumbs && (
          <>
            <Toggle
              label="Migas A-8 (demo)"
              checked={!!crumbsOn}
              onChange={() => onToggleCrumbs()}
            />
            <p className="text-[10px] leading-snug text-muted-foreground">
              Migas de brigadista cada 25 m ancladas al MDT activo (simulación FR-W1); golpe de paso cada 4ª.
            </p>
          </>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-foreground/90">Intervalo forzado</span>
          <Select
            value={String(opts.forcedStep)}
            onValueChange={(v) => onOpts({ forcedStep: Number(v) })}
          >
            <SelectTrigger size="sm" className="w-[124px]" aria-label="Intervalo forzado de curvas">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Auto (LOD)</SelectItem>
              <SelectItem value="1">1 m</SelectItem>
              <SelectItem value="2">2 m</SelectItem>
              <SelectItem value="5">5 m</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          {opts.forcedStep > 0
            ? `Intervalo forzado a ${opts.forcedStep} m: verificación estricta activa (Auditoría R1).`
            : 'LOD activo. Fuerce 1 m para verificación estricta. En Auto el visor adapta el intervalo al presupuesto de segmentos para mantener la interacción fluida.'}
        </p>
        {/* F3 · Modo Ahorro: DPR 1 + tope 30 cps (Fase 4: también automático por batería) */}
        <Toggle
          label="Modo Ahorro · DPR 1 · 30 cps"
          checked={opts.powerSave}
          disabled={fieldMode}
          disabledNote="Fijado por Modo Campo: ahorro de energía garantizado (DPR 1 · 30 cps)."
          onChange={(v) => onOpts({ powerSave: v })}
        />
        <p className="text-[10px] leading-snug text-muted-foreground">
          Renderiza a 1 px por punto y limita a 30 cuadros/s: mínimo consumo en equipos
          modestos. Con batería ≤ 20 % sin cargar se activa solo (Battery API).
        </p>
        {/* F5 · relieve visual sin shaders (sombra de maestras + niebla) */}
        <Toggle
          label="Relieve F5 · sombra + niebla"
          checked={opts.reliefFx}
          onChange={(v) => onOpts({ reliefFx: v })}
        />
        <p className="text-[10px] leading-snug text-muted-foreground">
          Sombra vectorial de maestras (sol NW) y niebla de profundidad al alejar: solo orden de
          pintado y color, sin shaders y sin bucles por píxel.
        </p>
      </section>

      <Separator />

      {/* Rango de elevación */}
      <section aria-label="Rango de elevación visible" className="space-y-2">
        <SectionTitle>Rango de elevación</SectionTitle>
        <Slider
          min={region.elevMin}
          max={region.elevMax}
          step={5}
          value={opts.elevRange}
          onValueChange={(v) => onOpts({ elevRange: [v[0], v[1]] })}
          aria-label="Rango de elevación visible"
        />
        <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground">
          <span>{fmt(opts.elevRange[0])} m</span>
          <span>{fmt(opts.elevRange[1])} m</span>
        </div>
      </section>

      <Separator />

      {/* Vistas */}
      <section aria-label="Vistas predefinidas" className="space-y-2">
        <SectionTitle>Vistas POV</SectionTitle>
        <div className="grid grid-cols-3 gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p.id}
              variant="outline"
              size="sm"
              className="h-8 px-1 text-[11px]"
              onClick={() => onPreset(p.id)}
              title={`Atajo: ${p.hint}`}
            >
              {p.id === 'fit' ? (
                <Scan className="mr-1 h-3 w-3" aria-hidden />
              ) : p.id === 'top' ? (
                <SquareDashed className="mr-1 h-3 w-3" aria-hidden />
              ) : (
                <Move3d className="mr-1 h-3 w-3" aria-hidden />
              )}
              {p.label}
            </Button>
          ))}
        </div>
      </section>

      <Separator />

      {/* Demo vertical · Auditoría R1 ( Fase 3) */}
      <section aria-label="Demo vertical Auditoría R1" className="space-y-2">
        <SectionTitle>Demo vertical · Auditoría R1</SectionTitle>
        <Button
          variant="outline"
          size="sm"
          className="h-9 w-full text-xs"
          aria-label="Activar Auditoría R1 con intervalo de 1 m y copiar la cita metodológica"
          onClick={() => {
            onOpts({ forcedStep: 1 });
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
          }}
        >
          <FileCheck className="mr-2 h-3.5 w-3.5 text-orange-500" aria-hidden />
          Activar Auditoría R1 · 1 m
        </Button>
        <p className="text-[10px] leading-snug text-muted-foreground">
          Preset para planificación y auditoría: fuerza el intervalo de 1 m y entrega la cita
          oficial copiable (INEGI/SMAOT). Desactívalo con Intervalo forzado → Auto.
        </p>
      </section>

      <Separator />

      {/* Ficha técnica */}
      <section aria-label="Ficha técnica" className="space-y-2">
        <SectionTitle>Ficha técnica</SectionTitle>
        {modelInfo ? (
          <div className="space-y-1">
            <Row
              label="Superficie oficial"
              value={`${fmt(region.areaHa)} ha${region.areaApprox ? ' (aprox.)' : ''}`}
            />
            <Row
              label="Fuente del MDT"
              value={
                modelInfo.source === 'real' && modelInfo.realMeta
                  ? `REAL · ${modelInfo.realMeta.fileName.slice(0, 22)}`
                  : 'Procedural (semilla)'
              }
            />
            <Row label="Superficie modelo" value={`${fmt(modelInfo.stats.areaModelHa)} ha`} />
            <Row label="Perímetro divisorio" value={`${fmt(modelInfo.stats.dividePerimeterKm, 1)} km`} />
            <Row label="Desnivel modelo" value={`${fmt(modelInfo.stats.desnivel)} m`} />
            <Row label="Pendiente media" value={`${fmt(modelInfo.stats.slopePct, 1)} %`} />
            <Row label="Cotas mapeadas" value={`${fmt(modelInfo.levels)} niveles`} />
            <Row label="Curvas maestras" value={fmt(modelInfo.maestras)} />
            <Row label="Marco INEGI" value="4 cartas · 1:50 000" />
            <Row label="Segmentos vectoriales" value={fmt(modelInfo.totalSegs)} />
            <Row label="Nodos del MDT" value={fmt(modelInfo.stats.nodes)} />
            <Row label="Cauces trazados" value={fmt(modelInfo.stats.streams)} />
            {/* F4: presupuesto CPU documentado en la ficha técnica */}
            <Row label="Motor" value="CPU · Canvas 2D · 0 GPU" />
            <Row label="Presupuesto CPU" value="Reposo 0 cps · slicing 8 ms" />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">Generando modelo…</p>
        )}
        <ul className="list-disc space-y-0.5 pl-4 text-[10.5px] leading-relaxed text-muted-foreground">
          {region.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>

      <Separator />

      {/* Semilla SDK · MXP1 ( Fase 4) */}
      <section aria-label="Semilla SDK MXP1" className="space-y-2">
        <SectionTitle>Semilla SDK · MXP1</SectionTitle>
        <div className="rounded-md border border-border/70 bg-muted/30 p-2">
          <p className="break-all font-mono text-[10px] leading-snug text-foreground/80">
            {seedCode}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full text-xs"
          aria-label="Copiar semilla MXP1 al portapapeles"
          onClick={() => {
            try {
              navigator.clipboard
                .writeText(seedCode)
                .then(() =>
                  toast({
                    title: 'Semilla MXP1 copiada',
                    description: 'El SDK regenera este terreno exacto.',
                  })
                )
                .catch(() => toast({ title: 'No se pudo copiar', variant: 'destructive' }));
            } catch {
              toast({ title: 'No se pudo copiar', variant: 'destructive' });
            }
          }}
        >
          <ClipboardCopy className="mr-2 h-3.5 w-3.5 text-orange-500" aria-hidden />
          Copiar semilla MXP1
        </Button>
        <div className="space-y-1">
          <Row
            label="Región / semilla"
            value={`${seedInfo?.id ?? region.id} · ${seedInfo?.seed ?? region.seed}`}
          />
          <Row label="Subcuencas" value={String(seedInfo?.basins ?? region.basins.length)} />
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          Protocolo MXP1: el MDT completo (≈101 KB) se regenera de forma determinista desde{' '}
          {seedCode.length} caracteres. Sin binarios, sin red, verificable con checksum.
        </p>
      </section>

      <Separator />

      {/* SDK / Licencia ( Fase 3) */}
      <section aria-label="Ti-4GO SDK y licencia" className="space-y-2">
        <SectionTitle>Ti-4GO SDK · Licencia</SectionTitle>
        <div className="space-y-1">
          <Row label="Producto" value={BRAND} />
          <Row label="Sello de calidad" value={QUALITY_SEAL} />
          <Row label="Desarrollador" value={DEVELOPER} />
          <Row label="Versión SDK" value={`v${SDK_VERSION}`} />
          <Row label="Contrato de integración" value="@/lib/terrain · cerrado a beneficiarios" />
          <Row label="Beneficiarios" value={BENEFICIARIES_LINE} />
        </div>
        <div className="space-y-1">
          {LICENSE_TIERS.map((tier) => (
            <div key={tier.id} className="flex items-center gap-2">
              <Badge variant="outline" className="shrink-0 text-[9px]">
                {tier.name}
              </Badge>
              <span className="text-[10px] leading-snug text-muted-foreground">{tier.scope}</span>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-1.5 rounded-md border border-orange-700/30 bg-orange-500/10 p-2 dark:border-orange-500/40">
          <Package className="mt-[1px] h-3 w-3 shrink-0 text-orange-700 dark:text-orange-400" aria-hidden />
          <p className="text-[10px] leading-snug text-orange-900 dark:text-orange-200/90">
            Motor embebible 0 GPU: generación en Web Worker, render Canvas 2D bajo demanda y
            semillas deterministas MXP1.
          </p>
        </div>
      </section>

      <Separator />

      {/* Roadmap de Renderizado 0 GPU */}
      <section aria-label="Roadmap de renderizado sin GPU" className="space-y-2">
        <Accordion type="single" collapsible className="rounded-lg border border-border">
          <AccordionItem value="roadmap-gpu" className="border-b-0">
            <AccordionTrigger className="gap-2 px-3 py-2.5 hover:no-underline [&>svg]:hidden">
              <span className="flex items-center gap-2">
                <Cpu className="h-4 w-4 shrink-0 text-orange-500" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Roadmap · Renderizado 0 GPU
                </span>
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <Badge
                  variant="outline"
                  className="border-emerald-500/50 px-1.5 py-0 text-[9.5px] text-emerald-400"
                >
                  F0–F2 hecho
                </Badge>
                <ChevronRight
                  className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-90"
                  aria-hidden
                />
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-3 px-3 pb-3">
              <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                Todo el visor rasteriza en CPU con Canvas 2D: sin WebGL, WebGPU ni shaders. El plan
                evoluciona ese esquema por fases, con criterios medibles (actualizado{' '}
                <span className="font-mono">{ROADMAP_UPDATED}</span>).
              </p>

              {ROADMAP_PHASES.map((ph) => {
                const meta = STATUS_META[ph.status];
                return (
                  <div
                    key={ph.code}
                    className="rounded-md border border-border/70 bg-muted/25 p-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={`px-1.5 py-0 font-mono text-[9.5px] ${
                          ph.status === 'hecho'
                            ? 'border-emerald-500/50 text-emerald-400'
                            : ph.status === 'siguiente' || ph.status === 'activo'
                              ? 'border-orange-500/50 text-orange-400'
                              : 'text-muted-foreground'
                        }`}
                      >
                        {ph.code}
                      </Badge>
                      <span className="text-[11px] font-medium text-foreground/90">
                        {ph.title}
                      </span>
                      <Badge
                        variant="outline"
                        className={`ml-auto px-1.5 py-0 text-[9px] ${meta.cls}`}
                      >
                        {meta.label}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[10.5px] leading-snug text-muted-foreground">
                      {ph.goal}
                    </p>
                    <ul className="mt-1.5 space-y-0.5">
                      {ph.items.map((it) => (
                        <li key={it} className="flex items-start gap-1.5">
                          {ph.status === 'hecho' ? (
                            <Check
                              className="mt-[2px] h-2.5 w-2.5 shrink-0 text-emerald-500"
                              aria-hidden
                            />
                          ) : (
                            <span
                              className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-[color:var(--dt-fg-tertiary)]"
                              aria-hidden
                            />
                          )}
                          <span className="text-[10px] leading-snug text-foreground/75">{it}</span>
                        </li>
                      ))}
                    </ul>
                    {ph.criteria && (
                      <p className="mt-1.5 flex items-start gap-1 font-mono text-[9.5px] leading-snug text-orange-300/80">
                        <Gauge className="mt-[1px] h-2.5 w-2.5 shrink-0" aria-hidden />
                        {ph.criteria}
                      </p>
                    )}
                  </div>
                );
              })}

              <div className="rounded-md border border-border/70 p-2">
                <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Gauge className="h-3 w-3" aria-hidden />
                  Métricas objetivo
                </p>
                <ul className="space-y-0.5">
                  {ROADMAP_METRICS.map((m) => (
                    <li key={m} className="font-mono text-[9.5px] leading-snug text-foreground/75">
                      · {m}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-md border border-border/70 p-2">
                <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <ShieldAlert className="h-3 w-3" aria-hidden />
                  Riesgos y mitigación
                </p>
                <ul className="space-y-0.5">
                  {ROADMAP_RISKS.map((r) => (
                    <li key={r} className="text-[10px] leading-snug text-foreground/75">
                      · {r}
                    </li>
                  ))}
                </ul>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>

      <div className="rounded-md border border-orange-500/25 bg-orange-500/10 p-2 text-[10.5px] leading-relaxed text-orange-200/90">
        Modelo digital generado proceduralmente (semilla fija) calibrado a la altitud y superficie
        de referencia. Marco cartográfico: INEGI MTN 1:50 000 — F14C43D4 · F14C43E3 · F14C53A2 ·
        F14C53B1. Visualización vectorial: no sustituye el MDT de INEGI ni levantamientos LIDAR.
      </div>
    </div>
  );
}

/**
 * Memoizado (F2-C/ATOM-01): durante un cambio de región el overlay de
 * progreso re-renderiza el shell varias veces; con props referencialmente
 * estables el panel no se re-renderiza hasta que llega el modelo nuevo.
 */
export const TerrainPanel = memo(TerrainPanelBase);
