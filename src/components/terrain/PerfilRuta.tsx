/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

'use client';

/**
 * Perfil de elevación (FR agenda «campo escalar» → lectura de ruta) —
 * tarjeta flotante / slot de drawer con el corte del terreno del TRAMO
 * MÁS LARGO de la capa de rutas ingestada.
 *
 * Principios:
 *  - Canvas 2D en CPU (0 GPU, ROADMAP F0) — una línea de tinta, sin rellenos.
 *  - La z viene de la MISMA copia drapeada que dibuja el overlay
 *    (consumidor de applyDrapeToLayers) ⇒ perfil ≡ lienzo bit a bit.
 *  - Tinta consciente del tema (dark / day / E-Ink vía var CSS `currentColor`
 *    del propio canvas) — sin paleta duplicada.
 *  - Accesible: role="img" + aria-label con el resumen numérico completo.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Mountain } from 'lucide-react';
import {
  buildPerfil,
  perfilAriaLabel,
  type PerfilResult,
} from '@/lib/terrain/perfil';
import type { GeomLayer } from './ingest';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Lienzo del perfil — línea de tinta única, determinista              */
/* ------------------------------------------------------------------ */

function drawPerfil(
  canvas: HTMLCanvasElement,
  res: PerfilResult | null
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 236;
  const h = canvas.clientHeight || 88;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  /* Tinta = color de texto heredado (tema dark/day/E-Ink sin duplicar paleta) */
  const ink = getComputedStyle(canvas).color || '#e7e2d8';
  const inkSoft = ink;

  /* Eje base — línea de referencia honesta (el suelo del gráfico) */
  ctx.strokeStyle = inkSoft;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0.5, h - 0.5);
  ctx.lineTo(w - 0.5, h - 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (!res || res.stats.nPts < 2) return;

  const pts = res.tramos[0].pts;
  const { zMin, zMax } = res.stats;
  const dTotal = res.stats.dTotal || 1;
  const zSpan = zMax - zMin || 1;

  /* Márgenes: izquierda 2, derecha 2, arriba 12 (rótulo cota max), abajo 4 */
  const padL = 2, padR = 2, padT = 12, padB = 4;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const x = (d: number): number => padL + (d / dTotal) * iw;
  const y = (z: number): number => padT + (1 - (z - zMin) / zSpan) * ih;

  /* Línea del perfil — 1.5 px de tinta (E-Ink first: sin relleno) */
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let k = 0; k < pts.length; k++) {
    const px = x(pts[k].d);
    const py = y(pts[k].z);
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  /* Marcas de inicio y fin del tramo */
  ctx.fillStyle = ink;
  for (const k of [0, pts.length - 1]) {
    ctx.beginPath();
    ctx.arc(x(pts[k].d), y(pts[k].z), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Rótulos de cota min/max (tinta suave, monoespaciada del canvas) */
  ctx.globalAlpha = 0.8;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.round(zMax)} m`, padL, 1);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(zMin)} m`, padL, h - 1);
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ */
/* Tarjeta                                                             */
/* ------------------------------------------------------------------ */

export function PerfilRuta({
  geoms,
  className,
}: {
  /** Capas DRAPEADAS del visor (misma copia que dibuja el overlay). */
  geoms: GeomLayer[];
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<string>('');

  const eligible = useMemo(
    () => geoms.filter((l) => l.geom && l.geom.segs.length >= 4),
    [geoms]
  );

  /* Selección estable: la elegida si sigue viva; si no, la primera. */
  const activeName = eligible.some((l) => l.name === sel)
    ? sel
    : (eligible[0]?.name ?? '');
  const active = useMemo(
    () => eligible.find((l) => l.name === activeName) ?? null,
    [eligible, activeName]
  );

  const res = useMemo(() => (active ? buildPerfil(active) : null), [active]);

  /* Dibujo + redibujo en cambio de tema/field-mode (clase en <html>) */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = (): void => drawPerfil(canvas, res);
    paint();
    const obs = new MutationObserver(paint);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    const onResize = (): void => paint();
    window.addEventListener('resize', onResize);
    return () => {
      obs.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [res]);

  const fmt = (n: number, d = 0) =>
    n.toLocaleString('es-MX', { maximumFractionDigits: d, minimumFractionDigits: d });

  const s = res?.stats ?? null;
  const empty = !s || s.nPts < 2;

  return (
    <section
      aria-label="Perfil de elevación de rutas"
      className={cn(
        'rounded-xl border border-border/40 bg-background/40 px-3 py-2.5 backdrop-blur-md',
        className
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Mountain className="h-3.5 w-3.5 text-orange-400" aria-hidden />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Perfil de elevación
        </p>
      </div>

      {eligible.length === 0 ? (
        <p className="py-1 text-[10.5px] leading-snug text-muted-foreground">
          Ingresa una capa de rutas (KML/GeoJSON/CSV) para ver su corte del
          terreno — la misma z drapeada que dibuja el lienzo.
        </p>
      ) : (
        <>
          {eligible.length > 1 && (
            <label className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">Capa</span>
              <select
                value={activeName}
                onChange={(e) => setSel(e.target.value)}
                aria-label="Capa para el perfil de elevación"
                className="max-w-[170px] truncate rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10.5px] text-foreground"
              >
                {eligible.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <canvas
            ref={canvasRef}
            role="img"
            aria-label={perfilAriaLabel(res)}
            className="h-[88px] w-full text-foreground"
          />

          {s && (
            <div className="mt-1 space-y-0.5">
              <p className="font-mono text-[10px] leading-snug text-foreground/85">
                {fmt(s.dTotal / 1000, 2)} km · ↑{fmt(s.gain)} m · ↓{fmt(s.loss)} m ·{' '}
                {fmt(s.zMin)}–{fmt(s.zMax)} m
              </p>
              <p className="text-[9.5px] leading-snug text-muted-foreground">
                Cota {res?.source}
                {!empty && s.nTramos > 1 && ` · tramo más largo de ${s.nTramos}`}
                {!empty && s.nPts > 0 && ` · ${fmt(s.nPts)} pts`}
                {s.outside > 0 &&
                  ` · ${fmt(s.outside)} vértices fuera del MDT (respaldo)`}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
