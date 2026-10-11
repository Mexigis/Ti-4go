/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B-D1 / A-8 · forense del marcador GPS del motor (débito de FR-7).
 *
 * Presupuesto vectorial DURO ≤ 8 nodos (rombo 4 + cruz 4) + test de PÍXELES
 * con ctx grabador (0 canvas real necesario — el dibujo es dato, W5) +
 * auditoría estructural del motor: 0 geolocation (W3), 0 persistencia
 * (I-6) — el fix entra como DATO por setGpsMarker y nada sale a disco.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  drawGpsMarkerAt,
  GPS_MARKER_CRUZ,
  GPS_MARKER_NODOS,
  GPS_MARKER_R_PX,
  gpsMarkerNodes,
  gpsMarkerTone,
  type GpsMarkerCtx,
} from '../src/lib/gps/marker';
import { DAY_COLORS, EINK_COLORS } from '../src/lib/terrain/engine';

/* ---------- ctx grabador: registra cada op a nivel de píxel ---------- */
interface Op {
  op: string;
  args: number[];
  style?: string;
  lw?: number;
}

class RecorderCtx implements GpsMarkerCtx {
  ops: Op[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  beginPath(): void {
    this.ops.push({ op: 'beginPath', args: [] });
  }
  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'moveTo', args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ op: 'lineTo', args: [x, y] });
  }
  closePath(): void {
    this.ops.push({ op: 'closePath', args: [] });
  }
  fill(): void {
    this.ops.push({ op: 'fill', args: [], style: this.fillStyle });
  }
  stroke(): void {
    this.ops.push({ op: 'stroke', args: [], style: this.strokeStyle, lw: this.lineWidth });
  }
  save(): void {
    this.ops.push({ op: 'save', args: [] });
  }
  restore(): void {
    this.ops.push({ op: 'restore', args: [] });
  }
  /* Píxeles consumidos por la geometría trazada (nodos de path). */
  nodosTrazados(): number {
    return this.ops.filter((o) => o.op === 'moveTo' || o.op === 'lineTo').length;
  }
}

describe('A-8 · marcador GPS del motor — geometría pura', () => {
  test('presupuesto vectorial: EXACTAMENTE 8 nodos (rombo 4 + cruz 4)', () => {
    const n = gpsMarkerNodes(100, 50, GPS_MARKER_R_PX);
    expect(n.rombo.length).toBe(4);
    expect(n.cruz.length).toBe(4);
    expect(GPS_MARKER_NODOS).toBe(8);
  });

  test('known-answer de píxeles: rombo ±r y cruz ±r·0.45 alrededor de (px,py)', () => {
    const px = 123;
    const py = 77;
    const r = GPS_MARKER_R_PX;
    const d = r * GPS_MARKER_CRUZ;
    const n = gpsMarkerNodes(px, py, r);
    expect([n.rombo[0].x, n.rombo[0].y]).toEqual([px, py - r]);
    expect([n.rombo[1].x, n.rombo[1].y]).toEqual([px + r, py]);
    expect([n.rombo[2].x, n.rombo[2].y]).toEqual([px, py + r]);
    expect([n.rombo[3].x, n.rombo[3].y]).toEqual([px - r, py]);
    expect([n.cruz[0].x, n.cruz[0].y]).toEqual([px - d, py]);
    expect([n.cruz[1].x, n.cruz[1].y]).toEqual([px + d, py]);
    expect([n.cruz[2].x, n.cruz[2].y]).toEqual([px, py - d]);
    expect([n.cruz[3].x, n.cruz[3].y]).toEqual([px, py + d]);
  });

  test('tono por estado: activo→ok · degradado→degradado · sin fix ⇒ null', () => {
    expect(gpsMarkerTone('activo')).toBe('ok');
    expect(gpsMarkerTone('degradado')).toBe('degradado');
    for (const s of [
      'inactivo',
      'solicitando',
      'adquiriendo',
      'sin-senal',
      'denegado',
      'error',
      'no-disponible',
    ] as const) {
      expect(gpsMarkerTone(s)).toBeNull();
    }
  });
});

describe('A-8 · test de PÍXELES (ctx grabador)', () => {
  test('trazo: 8 nodos exactos · relleno del tono · cruz en color papel', () => {
    const ctx = new RecorderCtx();
    drawGpsMarkerAt(ctx, 40, 60, 'ok', {
      gpsOk: '#22c55e',
      gpsWarn: '#f59e0b',
      gpsHole: '#0b0b0c',
    });
    /* presupuesto cumplido EN EL TRAZO REAL */
    expect(ctx.nodosTrazados()).toBe(8);
    /* rombo relleno con la tinta del tono */
    const fill = ctx.ops.find((o) => o.op === 'fill');
    expect(fill?.style).toBe('#22c55e');
    /* los 4 vértices del rombo están en el path del fill */
    const pathNodos = ctx.ops.filter((o) => o.op === 'moveTo' || o.op === 'lineTo');
    expect(pathNodos[0]).toMatchObject({ op: 'moveTo', args: [40, 53] });
    expect(pathNodos[1]).toMatchObject({ op: 'lineTo', args: [47, 60] });
    expect(pathNodos[2]).toMatchObject({ op: 'lineTo', args: [40, 67] });
    expect(pathNodos[3]).toMatchObject({ op: 'lineTo', args: [33, 60] });
    /* cruz interior con el color del PAPEL y ancho propio */
    const stroke = ctx.ops.find((o) => o.op === 'stroke');
    expect(stroke?.style).toBe('#0b0b0c');
    expect(stroke?.lw).toBe(1.4);
    expect(pathNodos[4]).toMatchObject({ op: 'moveTo', args: [40 - 7 * GPS_MARKER_CRUZ, 60] });
    expect(pathNodos[5]).toMatchObject({ op: 'lineTo', args: [40 + 7 * GPS_MARKER_CRUZ, 60] });
  });

  test('tono degradado usa la tinta de aviso (misma geometría, otra tinta)', () => {
    const ctx = new RecorderCtx();
    drawGpsMarkerAt(ctx, 10, 10, 'degradado', {
      gpsOk: '#22c55e',
      gpsWarn: '#f59e0b',
      gpsHole: '#0b0b0c',
    });
    const fill = ctx.ops.find((o) => o.op === 'fill');
    expect(fill?.style).toBe('#f59e0b');
    expect(ctx.nodosTrazados()).toBe(8);
  });

  test('tintas por tema presentes en las 3 paletas (dark vía contrato de tipos)', () => {
    /* E-Ink: tinta pura jerarquizada por alpha (sin color). */
    expect(EINK_COLORS.gpsOk).toBe('#000000');
    expect(EINK_COLORS.gpsWarn).toBe('rgba(0, 0, 0, 0.55)');
    /* Día: verdes/ámbar de papel con contraste sobre #efefef. */
    expect(DAY_COLORS.gpsOk).toBe('#15803d');
    expect(DAY_COLORS.gpsWarn).toBe('#b45309');
    /* dark: auditado estructuralmente abajo (los colores son el mismo objeto
       de paleta que el resto del lienzo). */
  });
});

describe('A-8 · auditoría estructural del motor (código sin comentarios)', () => {
  const src = readFileSync(new URL('../src/lib/terrain/engine.ts', import.meta.url), 'utf8');
  /* franja del módulo relativa al marcador (setGpsMarker + drawGpsMarker);
     drawInegiFrame se busca DESPUÉS de setGpsMarker — su llamada en draw()
     aparece antes y cortaría la franja vacía (falsos verdes). */
  const i0 = src.indexOf('setGpsMarker(');
  const i1 = src.indexOf('drawInegiFrame(', i0);
  const franja = src.slice(i0, i1);
  expect(franja.length).toBeGreaterThan(200);

  test('W3 · el motor NO llama geolocation (el disparo vive SOLO en el chip)', () => {
    expect(franja.includes('geolocation')).toBe(false);
    expect(franja.includes('watchPosition')).toBe(false);
    expect(franja.includes('getCurrentPosition')).toBe(false);
  });

  test('I-6 · el motor NO persiste el fix (dato en memoria, nunca a disco)', () => {
    expect(franja.includes('localStorage')).toBe(false);
    expect(franja.includes('sessionStorage')).toBe(false);
    expect(franja.includes('indexedDB')).toBe(false);
  });

  test('§5.1 · fuera del extent el marcador JAMÁS se dibuja (guard en el motor)', () => {
    expect(franja.includes('extentM / 2')).toBe(true);
  });
});
