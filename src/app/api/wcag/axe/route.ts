/*
 * Copyright 2026 PPcoyente Group · MexiGIS Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WCAG automatizada — servidor de axe-core SOLO en desarrollo.
 *
 * Cierre de la deuda de accesibilidad (4ª deferral — directiva trace
 * ``): la auditoría usa axe-core desde node_modules
 * (devDependency) — 0 CDN, funciona offline en el sandbox.
 *
 * Contrato: en `next build` (artefacto air-gap, NODE_ENV=production) esta
 * ruta responde 404 — el artefacto NO lleva la herramienta de auditoría;
 * es equipo de laboratorio, no producto.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV !== 'development') {
    return new Response('Auditoría WCAG disponible solo en desarrollo', { status: 404 });
  }
  try {
    const src = await readFile(
      path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'),
      'utf8'
    );
    return new Response(src, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  } catch {
    return new Response('axe-core no instalado (bun add -d axe-core)', { status: 500 });
  }
}
