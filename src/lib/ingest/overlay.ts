/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Overlay de geometría ingestada — Canvas 2D puro, misma proyección que el
 * motor (sx = w2 + (x·cos−y·sin)·S ; sy = h2 − ((x·sin+y·cos)·sinEl + z·cosEl)·S).
 *
 * Se dibuja sobre un canvas transparente independiente (pointer-events-none)
 * por encima del lienzo de terreno y por debajo de las cards flotantes. Se
 * redibuja ÚNICAMENTE cuando el motor redibuja (onFrame) — 0 coste en reposo,
 * coherente con la filosofía 0 GPU / solo vectores / determinista.
 *
 * FR-4 — D11: el overlay ya no usa un estilo único; resuelve la GRAMÁTICA
 * SEMÁNTICA DE LÍNEA (linegrammar.ts) por capa: peso + continuidad + halo +
 * nodos según el tipo declarado (ruta/vector/…), con codificación E-Ink-first
 * (B/N distinguible por tipo) y forward-compat genérico + nota para tipos
 * desconocidos. Capas con estado DIVERGE (cruce triangular FR-3) llevan el
 * MARCADOR VISIBLE de advertencia de H-4 (guión de alerta + triángulos).
 * Flechas de dirección en rutas: NODOS PRESUPUESTADOS (D11_MAX_NODES).
 *
 * Medición ms/cuadro (FR-4): `overlayPerf` expone la duración del último
 * cuadro y una EMA — la QA la lee (7 capas vs baseline) y el HUD puede
 * consumirla. Sin asignación en el camino caliente salvo el propio path.
 *
 * Paleta E-Ink-first: tinta negra `#111` sobre papel; halo blanco separa del
 * terreno subyacente en modo estándar. Sin azul/índigo.
 */

import type { GeomLayer } from '@/components/terrain/ingest';
import type { CamSnapshot } from '@/lib/terrain/engine';
import { DRAPE_LIFT_PX, drapeGeom, type DrapeGeom } from '@/lib/terrain/drape';
import type { BreadcrumbTrail } from '@/lib/terrain/breadcrumb';
import {
  resolveLineStyle,
  sampleNodes,
  D11_MAX_NODES,
  type D11State,
} from '@/lib/terrain/linegrammar';

export type { CamSnapshot };

const INK_DARK = '#111111'; // tinta sobre papel claro (modo day / E-Ink)
const INK_LIGHT = '#e4e4e7'; // tinta sobre lienzo oscuro (zinc-200)
const POINT_STYLE = '#f97316'; // naranja único acento (datos de campo CSV)
const LABEL_STYLE = 'rgba(161, 161, 170, 0.9)'; // zinc-400
const HALO = '#ffffff'; // papel (separa del terreno subyacente en ambos temas)

/** Medición del coste del overlay (ms por cuadro). */
export const overlayPerf = {
  lastMs: 0,
  emaMs: 0,
  frames: 0,
};

/**
 * DRAPE-1 · «la capa viva sobre las curvas» — medición del drape (QA lee
 * `__drapePerf`): capas activas en el último cuadro, vértices MDT vs
 * declarados, reconstrucciones de caché y coste del último build.
 */
export const drapePerf = {
  layers: 0,
  mdtVerts: 0,
  declaredVerts: 0,
  rebuilds: 0,
  lastBuildMs: 0,
};

/** DRAPE-1: contrato de drape que el visor entrega al overlay. */
export interface OverlayDrape {
  /** Muestreo bilineal del MDT activo (total: clamp al borde). */
  sampler: (xM: number, yM: number) => number;
  /** Sello del modelo activo (engine.terrainStamp) — invalida la caché. */
  stamp: number;
  /** Celda del MDT activo en m (paso de densificación = cellM/2). */
  cellM: number;
}

export interface OverlayOpts {
  /** Modo E-Ink: tinta B/N pura; false ⇒ tinta suave legada para vector sin tipo. */
  eink?: boolean;
  /** Color de tinta según el tema del lienzo (polaridad E-Ink-first):
   *  oscuro ⇒ tinta clara; day/E-Ink ⇒ tinta oscura. Por defecto clara. */
  ink?: string;
  /** DRAPE-1: cuando está presente, los features SIN cota se drapean sobre
   *  el MDT activo (z = terreno + lift 2–3 px de pantalla); los que traen
   *  cota declarada la conservan (sin lift). Ausente ⇒ z NaN proyecta
   *  neutra (0) — sin MDT no hay dónde drapear. */
  drape?: OverlayDrape;
}

/* Caché de drape por capa (WeakMap: la capa muere ⇒ caché muere con ella).
 * La clave (stamp, cellM) es el sello del modelo activo: región/DEM nuevo
 * ⇒ reconstrucción única por capa, NO por cuadro. */
const drapeCache = new WeakMap<GeomLayer, { stamp: number; cellM: number; g: DrapeGeom | null }>();

function resolveDrape(layer: GeomLayer, d: OverlayDrape | undefined): DrapeGeom | null {
  if (!d || !Number.isFinite(d.cellM) || d.cellM <= 0) return null;
  const hit = drapeCache.get(layer);
  if (hit && hit.stamp === d.stamp && hit.cellM === d.cellM) return hit.g;
  const t0 = performance.now();
  const g = drapeGeom(layer.geom.verts, layer.geom.segs, d.sampler, d.cellM / 2);
  drapePerf.rebuilds++;
  drapePerf.lastBuildMs = performance.now() - t0;
  drapeCache.set(layer, { stamp: d.stamp, cellM: d.cellM, g });
  return g;
}

export function drawIngestOverlay(
  ctx: CanvasRenderingContext2D,
  cam: CamSnapshot,
  layers: GeomLayer[],
  opts: OverlayOpts = {}
): void {
  const t0 = performance.now();
  const cvn = ctx.canvas;
  const bw = Math.round(cam.w * cam.dpr);
  const bh = Math.round(cam.h * cam.dpr);
  if (cvn.width !== bw || cvn.height !== bh) {
    cvn.width = bw;
    cvn.height = bh;
  }
  ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
  ctx.clearRect(0, 0, cam.w, cam.h);
  if (layers.length === 0) {
    overlayPerf.lastMs = performance.now() - t0;
    return;
  }

  const S = cam.pxPerM;
  const c = Math.cos(cam.az);
  const s = Math.sin(cam.az);
  const es = Math.sin(cam.el);
  const ec = Math.cos(cam.el);
  const w2 = cam.w / 2 + cam.panX;
  const h2 = cam.h / 2 + cam.panY;
  const M = 60; // margen de culling
  const ink = opts.ink ?? INK_LIGHT;
  const visible = (px: number, py: number): boolean =>
    px >= -M && px <= cam.w + M && py >= -M && py <= cam.h + M;

  let drapedLayers = 0;
  let drapeMdt = 0;
  let drapeDeclared = 0;
  for (const layer of layers) {
    const { verts: origVerts, segs: origSegs, pts } = layer.geom;

    // --- DRAPE-1: geometría drapeada (cacheada por capa + sello MDT) ---
    const drape = resolveDrape(layer, opts.drape);
    const verts = drape ? drape.verts : origVerts;
    const segs = drape ? drape.segs : origSegs;
    if (drape) {
      drapedLayers++;
      drapeMdt += drape.mdtCount;
      drapeDeclared += drape.declaredCount;
    }
    // z del vértice i: declarada o terreno; sin drape y sin cota ⇒ 0
    // (proyección neutra — NaN jamás entra al path).
    const zAt = (i: number): number => {
      const z = verts[i * 3 + 2];
      return Number.isFinite(z) ? z : 0;
    };
    // Lift de pantalla SOLO para vértices drapeados (la tinta viva no se
    // entierra en la curva que la porta); cota declarada = dato intacto.
    const liftAt = (i: number): number =>
      drape !== null && drape.src[i] === 0 ? DRAPE_LIFT_PX : 0;

    // --- D11: estilo resuelto por capa (tipo + estado DIVERGE + v1.1) --
    // v1.1 defensiva: route_class/confidence se consumen si presentes
    // (meta del pack/KML/GeoJSON); ausentes ⇒ defaults v1.0.
    const state: D11State = layer.meta.diverge ? 'diverge' : 'normal';
    const resolved = resolveLineStyle(layer.meta.layerType, state, {
      routeClass: layer.meta.routeClass,
      confidence: layer.meta.confidence,
    });
    const lineColor = ink;

    // Aristas: un solo path por capa (1 stroke) con la gramática D11.
    if (segs.length > 0) {
      const buildPath = (): void => {
        ctx.beginPath();
        for (let k = 0; k + 1 < segs.length; k += 2) {
          const ia = segs[k];
          const ib = segs[k + 1];
          const a = ia * 3;
          const b = ib * 3;
          if (a + 2 >= verts.length || b + 2 >= verts.length) continue;
          const ax = w2 + (verts[a] * c - verts[a + 1] * s) * S;
          const ay = h2 - ((verts[a] * s + verts[a + 1] * c) * es + zAt(ia) * ec) * S - liftAt(ia);
          const bx = w2 + (verts[b] * c - verts[b + 1] * s) * S;
          const by = h2 - ((verts[b] * s + verts[b + 1] * c) * es + zAt(ib) * ec) * S - liftAt(ib);
          // Culling por segmento: ambos extremos fuera del mismo lateral
          if (
            !visible(ax, ay) &&
            !visible(bx, by) &&
            ((ax < -M && bx < -M) ||
              (ax > cam.w + M && bx > cam.w + M) ||
              (ay < -M && by < -M) ||
              (ay > cam.h + M && by > cam.h + M))
          )
            continue;
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
      };
      // Halo primero (separación del fondo; DIVERGE lo refuerza)
      if (resolved.style.haloPx > 0) {
        buildPath();
        ctx.strokeStyle = HALO;
        ctx.lineWidth = resolved.style.weightPx + resolved.style.haloPx * 2;
        ctx.lineCap = 'butt';
        ctx.stroke();
      }
      buildPath();
      ctx.strokeStyle = lineColor;
      // v1.1: intensidad de tinta según confianza (el halo/papel queda pleno)
      ctx.globalAlpha = resolved.opacity;
      ctx.lineWidth = resolved.style.weightPx;
      ctx.setLineDash(resolved.style.dash);
      ctx.lineCap = 'butt';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Puntos CSV (campo): naranjas — pertenecen al canal de datos de campo.
    if (pts.length > 0) {
      ctx.fillStyle = POINT_STYLE;
      for (let k = 0; k < pts.length; k++) {
        const i = pts[k];
        const a = i * 3;
        if (a + 2 >= verts.length) continue;
        const px = w2 + (verts[a] * c - verts[a + 1] * s) * S;
        const py = h2 - ((verts[a] * s + verts[a + 1] * c) * es + zAt(i) * ec) * S - liftAt(i);
        if (!visible(px, py)) continue;
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }

    // --- D11: nodos presupuestados (flechas de ruta / triángulos DIVERGE)
    const glyph = resolved.style.nodeGlyph;
    if (glyph !== 'none' && segs.length > 1) {
      const segList: Array<{ a: number; b: number; ax: number; ay: number; bx: number; by: number }> = [];
      for (let k = 0; k + 1 < segs.length; k += 2) {
        const ia = segs[k];
        const ib = segs[k + 1];
        const a = ia * 3;
        const b = ib * 3;
        if (a + 2 >= verts.length || b + 2 >= verts.length) continue;
        const ax = w2 + (verts[a] * c - verts[a + 1] * s) * S;
        const ay = h2 - ((verts[a] * s + verts[a + 1] * c) * es + zAt(ia) * ec) * S - liftAt(ia);
        const bx = w2 + (verts[b] * c - verts[b + 1] * s) * S;
        const by = h2 - ((verts[b] * s + verts[b + 1] * c) * es + zAt(ib) * ec) * S - liftAt(ib);
        if (!visible(ax, ay) && !visible(bx, by)) continue;
        segList.push({ a: k, b: k + 1, ax, ay, bx, by });
      }
      const nodes = sampleNodes(glyph, segList, segList.length);
      ctx.fillStyle = lineColor;
      ctx.strokeStyle = lineColor;
      ctx.globalAlpha = resolved.opacity;
      ctx.lineWidth = 1.4;
      for (const nd of nodes) {
        const g = segList[nd.vertex];
        if (!g) continue;
        if (nd.glyph === 'arrow') {
          // Chevron orientado al sentido de viaje (punta en el segmento).
          const mx = (g.ax + g.bx) / 2;
          const my = (g.ay + g.by) / 2;
          const ang = Math.atan2(g.by - g.ay, g.bx - g.ax);
          ctx.beginPath();
          for (const off of [Math.PI * 0.78, -Math.PI * 0.78]) {
            const a2 = ang + Math.PI + off; // abiertas hacia atrás del avance
            ctx.moveTo(mx + Math.cos(a2) * 5, my + Math.sin(a2) * 5);
            ctx.lineTo(mx, my);
          }
          ctx.stroke();
        } else if (nd.glyph === 'triangle') {
          // ▲ de advertencia DIVERGE (H-4): visible sobre cualquier fondo.
          const mx = (g.ax + g.bx) / 2;
          const my = (g.ay + g.by) / 2;
          ctx.beginPath();
          ctx.moveTo(mx, my - 5);
          ctx.lineTo(mx + 4.5, my + 3.5);
          ctx.lineTo(mx - 4.5, my + 3.5);
          ctx.closePath();
          ctx.fill();
        } else if (nd.glyph === 'circle') {
          const mx = (g.ax + g.bx) / 2;
          const my = (g.ay + g.by) / 2;
          ctx.beginPath();
          ctx.arc(mx, my, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (nd.glyph === 'square') {
          const mx = Math.round((g.ax + g.bx) / 2);
          const my = Math.round((g.ay + g.by) / 2);
          ctx.fillRect(mx - 2, my - 2, 4, 4);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Etiqueta de capa en el centroide proyectado (solo con zoom suficiente)
    if (cam.zoom > 0.45) {
      let cx = 0,
        cy = 0,
        cz = 0;
      const n = origVerts.length / 3;
      if (n > 0) {
        const step = Math.max(1, Math.floor(n / 64)); // muestra determinista
        let cnt = 0;
        for (let k = 0; k < n; k += step) {
          cx += origVerts[k * 3];
          cy += origVerts[k * 3 + 1];
          const z = origVerts[k * 3 + 2];
          cz += Number.isFinite(z) ? z : 0; // DRAPE-1: NaN no envenena el centroide
          cnt++;
        }
        cx /= cnt;
        cy /= cnt;
        cz /= cnt;
      }
      const px = w2 + (cx * c - cy * s) * S;
      const py = h2 - ((cx * s + cy * c) * es + cz * ec) * S;
      if (visible(px, py)) {
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = resolved.state === 'diverge' ? ink : LABEL_STYLE;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const probable = resolved.note.includes('probable, no confirmado');
        const baseTag = layer.meta.label.toLocaleLowerCase();
        const tag =
          resolved.state === 'diverge'
            ? `${baseTag} · diverge${probable ? ' · probable' : ''}`
            : probable
              ? `${baseTag} · probable`
              : baseTag;
        ctx.fillText(tag, px, py - 4);
      }
    }
  }

  const dt = performance.now() - t0;
  overlayPerf.lastMs = dt;
  overlayPerf.frames++;
  overlayPerf.emaMs = overlayPerf.frames <= 1 ? dt : overlayPerf.emaMs * 0.9 + dt * 0.1;
  drapePerf.layers = drapedLayers;
  drapePerf.mdtVerts = drapeMdt;
  drapePerf.declaredVerts = drapeDeclared;
}

/** Presupuesto de nodos exportado para la ficha/QA. */
export const OVERLAY_MAX_NODES = D11_MAX_NODES;

/* ------------------------------------------------------------------ */
/* Breadcrumb A-8 (FR-W1) — migas ancladas al terreno + brigadista      */
/* (transplante inverso, )                        */
/* ------------------------------------------------------------------ */

/**
 * Dibuja el breadcrumb del brigadista (ruta demo A-8) sobre el mismo canvas
 * del overlay. «Se siente paso»: cada BREADCRUMB_STEP_M hay una miga; cada
 * 4ª miga es el «golpe de paso» (punto mayor). La z de cada miga YA es la
 * del MDT (trail anclado al terreno); el lift de DRAPE_LIFT_PX en pantalla
 * las separa de las curvas igual que a las capas drapeadas.
 *
 * Brigadista (cabeza): halo + tinta + etiqueta de ruta — legible sobre
 * cualquier terreno, sin color (codificación E-Ink-first).
 */
export function drawBreadcrumb(
  ctx: CanvasRenderingContext2D,
  cam: CamSnapshot,
  trail: BreadcrumbTrail,
  opts: { ink?: string } = {}
): void {
  const t0 = performance.now();
  const ink = opts.ink ?? INK_LIGHT;
  const S = cam.pxPerM;
  const c = Math.cos(cam.az);
  const s = Math.sin(cam.az);
  const es = Math.sin(cam.el);
  const ec = Math.cos(cam.el);
  const w2 = cam.w / 2 + cam.panX;
  const h2 = cam.h / 2 + cam.panY;
  const M = 60;
  const project = (x: number, y: number, z: number): [number, number] => [
    w2 + (x * c - y * s) * S,
    h2 - ((x * s + y * c) * es + z * ec) * S - DRAPE_LIFT_PX,
  ];

  // Migas: alpha por edad (la más reciente opaca) + golpe de paso cada 4.
  ctx.fillStyle = ink;
  for (let i = 0; i < trail.n; i++) {
    const [px, py] = project(trail.pts[i * 3], trail.pts[i * 3 + 1], trail.pts[i * 3 + 2]);
    if (px < -M || px > cam.w + M || py < -M || py > cam.h + M) continue;
    const age = trail.n <= 1 ? 0 : i / (trail.n - 1); // 0 = cabeza
    const beat = (trail.n - 1 - i) % 4 === 0; // cadencia «se siente paso»
    const r = beat ? 1.9 : 1.2;
    ctx.globalAlpha = 0.9 - 0.55 * age;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Brigadista en la cabeza: halo blanco + tinta + stem vertical corto.
  const [hx, hy] = project(trail.headX, trail.headY, trail.headZ);
  ctx.strokeStyle = HALO;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(hx, hy - 6, 3.4, 0, Math.PI * 2); // halo del torso-cabeza
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx, hy - 9);
  ctx.stroke();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(hx, hy - 6, 2.4, 0, Math.PI * 2); // cabeza
  ctx.stroke();
  ctx.beginPath(); // cuerpo (línea de paso)
  ctx.moveTo(hx, hy - 3.4);
  ctx.lineTo(hx, hy);
  ctx.stroke();

  // Etiqueta de ruta junto a la cabeza.
  ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`▲ brigadista · ${trail.routeId}`, hx + 7, hy - 8);

  const dt = performance.now() - t0;
  overlayPerf.lastMs += dt; // se suma al cuadro del overlay (no rompe la EMA)
}
