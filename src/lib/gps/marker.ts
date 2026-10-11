/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A-8 · marcador GPS del motor — geometría vectorial PURA con presupuesto
 * duro de ≤ 8 nodos (débito de FR-7): rombo 4 + cruz 4 = 8 EXACTOS, sin
 * arcos ni curvas. El dibujo es dato (W5): el motor proyecta el fix con SU
 * convención de marco (drawInegiFrame, D12: lat y lon → metros con
 * 111_320 — difiere de fixToSceneM §5.1 solo en el radio latitudinal,
 * 0.67% ≪ precisión GPS, y alinea el marcador con el marco cartográfico)
 * y consume estos nodos; los tests los verifican a nivel de píxel con un
 * ctx grabador. 0 geolocation, 0 persistencia (W3/I-6 viven en el
 * controlador — aquí solo hay geometría y tinta).
 */
import type { GpsStatus } from './types';

export type GpsMarkerTone = 'ok' | 'degradado';

/** Presupuesto vectorial duro (directiva A-8): rombo 4 + cruz 4. */
export const GPS_MARKER_NODOS = 8 as const;

/** Radio del rombo en px de PANTALLA (como el gizmo — no escala con zoom). */
export const GPS_MARKER_R_PX = 7 as const;

/** Semibrizo de la cruz interior (fracción del radio del rombo). */
export const GPS_MARKER_CRUZ = 0.45 as const;

export interface GpsMarkerNode {
  x: number;
  y: number;
}

export interface GpsMarkerNodes {
  rombo: [GpsMarkerNode, GpsMarkerNode, GpsMarkerNode, GpsMarkerNode];
  cruz: [GpsMarkerNode, GpsMarkerNode, GpsMarkerNode, GpsMarkerNode];
}

/** Nodos del marcador en px — función pura, known-answer en la suite. */
export function gpsMarkerNodes(px: number, py: number, r: number): GpsMarkerNodes {
  const d = r * GPS_MARKER_CRUZ;
  return {
    rombo: [
      { x: px, y: py - r },
      { x: px + r, y: py },
      { x: px, y: py + r },
      { x: px - r, y: py },
    ],
    cruz: [
      { x: px - d, y: py },
      { x: px + d, y: py },
      { x: px, y: py - d },
      { x: px, y: py + d },
    ],
  };
}

/** Estados CON fix → tono del marcador; sin fix ⇒ null (no se dibuja). */
export function gpsMarkerTone(status: GpsStatus): GpsMarkerTone | null {
  if (status === 'activo') return 'ok';
  if (status === 'degradado') return 'degradado';
  return null;
}

/** Tintas del marcador, derivadas de la paleta del tema activo. */
export interface GpsMarkerInks {
  /** Fix de calidad (estado activo). */
  gpsOk: string;
  /** Fix degradado (≥ 25 m). */
  gpsWarn: string;
  /** «Papel» del tema para la cruz interior (contraste sobre el relleno). */
  gpsHole: string;
}

/** ctx mínimo consumido por el marcador — grabable en tests de píxel. */
export interface GpsMarkerCtx {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  save(): void;
  restore(): void;
  /* la unión del DOM: el ctx real (CanvasRenderingContext2D) es assignable */
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
}

/**
 * Traza el marcador en (px, py): rombo relleno + cruz del color del papel.
 * Exactamente GPS_MARKER_NODOS nodos de path — nada más.
 */
export function drawGpsMarkerAt(
  ctx: GpsMarkerCtx,
  px: number,
  py: number,
  tone: GpsMarkerTone,
  inks: GpsMarkerInks
): void {
  const { rombo, cruz } = gpsMarkerNodes(px, py, GPS_MARKER_R_PX);
  const tinta = tone === 'ok' ? inks.gpsOk : inks.gpsWarn;
  ctx.save();
  /* rombo — 4 nodos */
  ctx.beginPath();
  ctx.moveTo(rombo[0].x, rombo[0].y);
  ctx.lineTo(rombo[1].x, rombo[1].y);
  ctx.lineTo(rombo[2].x, rombo[2].y);
  ctx.lineTo(rombo[3].x, rombo[3].y);
  ctx.closePath();
  ctx.fillStyle = tinta;
  ctx.fill();
  /* cruz interior en color papel — 4 nodos (2 trazos) */
  ctx.beginPath();
  ctx.moveTo(cruz[0].x, cruz[0].y);
  ctx.lineTo(cruz[1].x, cruz[1].y);
  ctx.moveTo(cruz[2].x, cruz[2].y);
  ctx.lineTo(cruz[3].x, cruz[3].y);
  ctx.strokeStyle = inks.gpsHole;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();
}
