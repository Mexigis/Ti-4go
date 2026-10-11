/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * Cards flotantes — disolución del panel lateral (escritorio, ROADMAP-UI U1-U3).
 *
 * El contenido del sidebar se convierte en componentes flotantes transparentes
 * sobre el lienzo: grupo POV/Vuelos SIN contenedor (solo avatars L difuminados),
 * card colapsable de Capas, card de Rango de elevación, card de Semilla SDK con
 * QR vectorial por región (react-qr-code, SVG 0 GPU) y el cuadro de datos estilo
 * cajetín de plano CAD como marca de agua fija (100 % transparente).
 *
 * En móvil (<lg) el drawer inferior sigue usando TerrainPanel completo.
 */

import { useState, type ReactNode } from 'react';
import type { PresetName, ViewOpts } from '@/lib/terrain/engine';
import type { RegionDef } from '@/lib/terrain/regions';
import type { ModelInfo } from './TerrainPanel';
import { cn } from '@/lib/utils';
import { packRegionSeed } from '@/lib/terrain/seedpack';
import { INEGI_SHEETS } from '@/lib/terrain/inegi';
import { BRAND, DEVELOPER, QUALITY_SEAL, SDK_VERSION } from '@/lib/branding';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
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
  ChevronRight,
  ClipboardCopy,
  Move3d,
  QrCode,
  Scan,
  SlidersHorizontal,
  SquareDashed,
} from 'lucide-react';
import QRCode from 'react-qr-code';

/** Props compartidas de todas las cards flotantes (spread desde TerrainViewer). */
export interface FloatingProps {
  region: RegionDef;
  opts: ViewOpts;
  onOpts: (o: Partial<ViewOpts>) => void;
  modelInfo: ModelInfo | null;
  onFlyBasin: (i: number) => void;
  onPreset: (p: PresetName) => void;
  /** Breadcrumb A-8 (FR-W1 · transplante inverso): demo de migas ancladas
   *  al MDT con brigadista — 0 coste en reposo. */
  crumbsOn?: boolean;
  onToggleCrumbs?: () => void;
}

/* ------------------------------------------------------------------ */
/* AvatarButton — botón circular L (44 px) transparente y difuminado   */
/* ------------------------------------------------------------------ */

export function AvatarButton({
  icon,
  label,
  onClick,
  active = false,
  className,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** Clases extra (merge con tailwind-merge: permite sobreescribir tamaño/display). */
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'grid h-11 w-11 place-items-center rounded-full border bg-background/40 backdrop-blur-md transition-colors hover:border-orange-500/50 hover:bg-background/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60',
        active ? 'border-orange-500/70 bg-orange-500/15' : 'border-border/40',
        className
      )}
    >
      {icon}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* PovFlyGroup — vistas POV + vuelos directos, SIN contenedor ni bordes */
/* ------------------------------------------------------------------ */

const PRESETS: Array<{ id: PresetName; label: string; hint: string }> = [
  { id: 'iso', label: 'Isométrico', hint: '5' },
  { id: 'top', label: 'Cenital', hint: '7' },
  { id: 'front', label: 'Frente', hint: '1' },
  { id: 'side', label: 'Perfil', hint: '3' },
  { id: 'fit', label: 'Encajar', hint: 'H' },
];

function presetIcon(id: PresetName): ReactNode {
  if (id === 'fit') return <Scan className="h-[18px] w-[18px] text-foreground/80" aria-hidden />;
  if (id === 'top')
    return <SquareDashed className="h-[18px] w-[18px] text-foreground/80" aria-hidden />;
  return <Move3d className="h-[18px] w-[18px] text-foreground/80" aria-hidden />;
}

export function PovFlyGroup({ region, modelInfo, onFlyBasin, onPreset }: FloatingProps) {
  const basinNames = modelInfo?.basinNames ?? region.basins.map((b) => b.name);
  return (
    <div className="flex flex-col items-start gap-2">
      {/* Vistas POV */}
      <div className="flex items-center gap-1.5">
        {PRESETS.map((p) => (
          <AvatarButton
            key={p.id}
            icon={presetIcon(p.id)}
            label={`Vista ${p.label} · atajo ${p.hint}`}
            onClick={() => onPreset(p.id)}
          />
        ))}
      </div>

      <span className="h-px w-4 bg-border/50" aria-hidden />

      {/* Vuelo directo por subcuenca — inicial + etiqueta truncada */}
      <div className="flex flex-wrap gap-1.5">
        {basinNames.map((name, i) => {
          /* La inicial sale del nombre distintivo (sin el prefijo común
             «Subcuenca ») para que cada avatar sea reconocible. */
          const distinctive = name.replace(/^Subcuenca\s+/, '');
          const initial = distinctive.charAt(0).toUpperCase();
          return (
            <div key={name} className="flex w-11 flex-col items-center gap-0.5">
              <AvatarButton
                icon={<span className="font-semibold text-[13px] text-foreground/90">{initial}</span>}
                label={`Volar a ${name}`}
                onClick={() => onFlyBasin(i)}
              />
              <span className="max-w-[44px] truncate text-center text-[9px] text-muted-foreground">
                {name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LayersCard — card colapsable con los 11 toggles + intervalo forzado */
/* ------------------------------------------------------------------ */

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 py-1">
      <span className="text-xs text-foreground/90">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

export function LayersCard({ opts, onOpts, crumbsOn, onToggleCrumbs }: FloatingProps) {
  /* Colapsada por defecto (FIX QA 12-3-fix): abierta (~430px) desbordaba la
     columna izquierda y comprimía PovFlyGroup/ElevationCard. */
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label="Capas"
      className="overflow-hidden rounded-xl border border-border/40 bg-background/40 backdrop-blur-md"
    >
      <button
        type="button"
        data-state={open ? 'open' : 'closed'}
        aria-expanded={open}
        aria-controls="floating-layers-content"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full items-center gap-2 px-2.5 transition-colors hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60"
      >
        <SlidersHorizontal className="h-4 w-4 text-orange-400" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Capas
        </span>
        <ChevronRight
          className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-90"
          aria-hidden
        />
      </button>
      {open && (
        <div id="floating-layers-content" className="space-y-0.5 px-2.5 pb-2.5">
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
          <Toggle
            label="Cotas en maestras"
            checked={opts.cotas}
            onChange={(v) => onOpts({ cotas: v })}
          />
          <Toggle
            label="Divisorias de aguas"
            checked={opts.divides}
            onChange={(v) => onOpts({ divides: v })}
          />
          <Toggle
            label="Red de drenaje"
            checked={opts.streams}
            onChange={(v) => onOpts({ streams: v })}
          />
          <Toggle label="Malla base del MDT" checked={opts.mesh} onChange={(v) => onOpts({ mesh: v })} />
          {onToggleCrumbs && (
            <Toggle
              label="Migas A-8 (demo)"
              checked={!!crumbsOn}
              onChange={() => onToggleCrumbs()}
            />
          )}
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
            onChange={(v) => onOpts({ eink: v })}
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            Tinta negra sobre papel blanco: para tinta electrónica, impresión y lectura prolongada.
          </p>
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
            Sombra vectorial de maestras (sol NW) y niebla de profundidad al alejar: solo orden
            de pintado y color, sin shaders y sin bucles por píxel.
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* ElevationCard — SOLO el rango de elevación                          */
/* ------------------------------------------------------------------ */

export function ElevationCard({ region, opts, onOpts }: FloatingProps) {
  const fmt = (n: number, d = 0) =>
    n.toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d });
  return (
    <div className="w-[240px] rounded-xl border border-border/40 bg-background/40 px-3 py-2.5 backdrop-blur-md">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Rango de elevación
      </p>
      <div className="mt-2">
        <Slider
          min={region.elevMin}
          max={region.elevMax}
          step={5}
          value={opts.elevRange}
          onValueChange={(v) => onOpts({ elevRange: [v[0], v[1]] })}
          aria-label="Rango de elevación visible"
        />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-muted-foreground">
        <span>{fmt(opts.elevRange[0])} m</span>
        <span>{fmt(opts.elevRange[1])} m</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SeedQrCard — semilla MXP1 con QR SVG por región                     */
/* ------------------------------------------------------------------ */

export function SeedQrCard({ region }: FloatingProps) {
  const { toast } = useToast();
  const seedCode = packRegionSeed(region);

  const copySeed = (): void => {
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
  };

  return (
    <div className="w-[240px] rounded-xl border border-border/40 bg-background/40 p-2.5 backdrop-blur-md">
      <div className="mb-1.5 flex items-center gap-1.5">
        <QrCode className="h-3.5 w-3.5 text-orange-400" aria-hidden />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Semilla SDK · MXP1
        </p>
      </div>
      <div className="flex items-start gap-2">
        {/* Tesela blanca: escaneabilidad (módulos oscuros sobre claro) */}
        <div
          role="img"
          aria-label={`QR de la semilla MXP1 de ${region.name}`}
          title="QR de la semilla MXP1 de esta región — escanéalo para copiar la semilla"
          className="shrink-0 rounded-md bg-white p-1.5"
        >
          <QRCode value={seedCode} size={84} bgColor="#ffffff" fgColor="#18181b" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-4 break-all font-mono text-[9.5px] leading-snug text-foreground/75">
            {seedCode}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1.5 h-8 w-full text-xs"
            aria-label="Copiar semilla MXP1 al portapapeles"
            onClick={copySeed}
          >
            <ClipboardCopy className="mr-1.5 h-3.5 w-3.5 text-orange-500" aria-hidden />
            Copiar
          </Button>
        </div>
      </div>
      <p className="mt-1.5 text-[9.5px] leading-snug text-muted-foreground">
        QR por semilla: cada región genera su propio código. MDT ≈101 KB → {seedCode.length}{' '}
        caracteres.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CadWatermark — cajetín de plano CAD como marca de agua fija         */
/* ------------------------------------------------------------------ */

function CadCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-[3px]">
      <p className="text-[8px] uppercase tracking-wide text-muted-foreground/70">{label}</p>
      <p className="font-mono text-[9.5px] leading-tight text-foreground/80">{value}</p>
    </div>
  );
}

export function CadWatermark({ region, modelInfo }: FloatingProps) {
  const fmt = (n: number, d = 0) =>
    n.toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d });
  const mi = modelInfo;
  const dash = '—';

  return (
    /* Sin posicionamiento propio: lo pone el viewer (wrapper bottom-right).
       Raíz sin fondo: el cajetín es 100 % transparente (solo rejilla). */
    <div className="pointer-events-none select-none opacity-80">
      <div className="w-[264px] divide-y divide-border/25 border border-border/35 text-foreground/80">
        {/* Cabecera: región + superficie */}
        <div className="flex items-baseline justify-between gap-2 px-2 py-1">
          <span className="min-w-0 truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
            {region.name}
          </span>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/80">
            {fmt(region.areaHa)} ha {region.official ? '· SMAOT' : '· aprox'}
          </span>
        </div>

        {/* Coordenadas del centro */}
        <div className="px-2 py-[3px] font-mono text-[9px] text-muted-foreground/80">
          {Math.abs(region.centerLat).toFixed(4)}° N · {Math.abs(region.centerLon).toFixed(4)}° W
        </div>

        {/* Ficha técnica (2 columnas, rejilla CAD) */}
        <div className="divide-y divide-border/25">
          <div className="grid grid-cols-2 divide-x divide-border/25">
            <CadCell label="Sup. modelo" value={mi ? `${fmt(mi.stats.areaModelHa)} ha` : dash} />
            <CadCell label="Perímetro" value={mi ? `${fmt(mi.stats.dividePerimeterKm, 1)} km` : dash} />
          </div>
          <div className="grid grid-cols-2 divide-x divide-border/25">
            <CadCell label="Desnivel" value={mi ? `${fmt(mi.stats.desnivel)} m` : dash} />
            <CadCell label="Pendiente" value={mi ? `${fmt(mi.stats.slopePct, 1)} %` : dash} />
          </div>
          <div className="grid grid-cols-2 divide-x divide-border/25">
            <CadCell label="Niveles" value={mi ? fmt(mi.levels) : dash} />
            <CadCell label="Maestras" value={mi ? fmt(mi.maestras) : dash} />
          </div>
          <div className="grid grid-cols-2 divide-x divide-border/25">
            <CadCell label="Segmentos" value={mi ? fmt(mi.totalSegs) : dash} />
            <CadCell label="Cauces" value={mi ? fmt(mi.stats.streams) : dash} />
          </div>
          {/* F4: presupuesto CPU documentado en la ficha técnica */}
          <div className="grid grid-cols-2 divide-x divide-border/25">
            <CadCell label="Motor" value="CPU · 0 GPU" />
            <CadCell label="Reposo" value="0 cuadros/s" />
          </div>
        </div>

        {/* Marco cartográfico INEGI */}
        <div className="px-2 py-[3px]">
          <span className="block truncate font-mono text-[9px] text-orange-300/80">
            INEGI MTN 1:50 000 · {INEGI_SHEETS.map((s) => s.code).join(' · ')}
          </span>
        </div>

        {/* Firma */}
        <div className="flex items-baseline justify-between gap-2 px-2 py-1 text-[8.5px] text-muted-foreground/70">
          <span>{BRAND} v{SDK_VERSION}</span>
          <span>Sello {QUALITY_SEAL}</span>
          <span>{DEVELOPER}</span>
        </div>
      </div>
    </div>
  );
}
